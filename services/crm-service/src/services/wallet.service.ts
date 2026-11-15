/**
 * Карта гостя в Apple Wallet (миграция 067).
 *
 * Как это работает:
 *  1. Клиент жмёт «Добавить в Apple Wallet» на странице карты и скачивает
 *     .pkpass — zip с pass.json и картинками, подписанный сертификатом
 *     Pass Type ID (PKCS#7, делает passkit-generator).
 *  2. В карте лежат webServiceURL и authenticationToken: телефон
 *     регистрируется у нас (POST …/registrations) и присылает push-токен.
 *  3. Баллы изменились → триггер в БД ставит wallet_updated_at → WalletPusher
 *     шлёт в APNs пустой push → телефон спрашивает, какие карты обновились,
 *     и забирает новую версию (GET /v1/passes/…).
 *
 * Без сертификата (нет файлов в WALLET_CERT_DIR) функция выключена целиком:
 * кнопки на странице нет, маршруты отвечают 404.
 */
import fs from 'fs';
import path from 'path';
import http2 from 'http2';
import crypto from 'crypto';
import { PKPass } from 'passkit-generator';

export interface WalletConfig {
  passTypeId: string;
  teamId: string;
  signerCert: Buffer;
  signerKey: Buffer;
  wwdr: Buffer;
  signerKeyPassphrase?: string;
  /** APNs: боевой шлюз; песочница Wallet не используется */
  apnsHost: string;
}

/**
 * Настройки из окружения: идентификаторы — переменными, сертификаты —
 * файлами в каталоге (том только для чтения). Ключ в переменную окружения
 * не кладём: его видно в `docker inspect`.
 */
export function loadWalletConfig(env: NodeJS.ProcessEnv = process.env): WalletConfig | null {
  const passTypeId = (env.WALLET_PASS_TYPE_ID || '').trim();
  const teamId = (env.WALLET_TEAM_ID || '').trim();
  const dir = env.WALLET_CERT_DIR || '/run/secrets/wallet';
  if (!passTypeId || !teamId) return null;
  const read = (name: string) => {
    try { return fs.readFileSync(path.join(dir, name)); } catch { return null; }
  };
  const signerCert = read('signerCert.pem');
  const signerKey = read('signerKey.pem');
  const wwdr = read('wwdr.pem');
  if (!signerCert || !signerKey || !wwdr) return null;
  return {
    passTypeId, teamId, signerCert, signerKey, wwdr,
    signerKeyPassphrase: env.WALLET_KEY_PASSPHRASE || undefined,
    apnsHost: env.WALLET_APNS_HOST || 'https://api.push.apple.com'
  };
}

/** Цвет карты по уровню: при переходе на новый уровень карта меняет цвет. */
export const TIER_COLORS: Record<string, string> = {
  bronze: 'rgb(140, 90, 43)',
  silver: 'rgb(96, 104, 117)',
  gold: 'rgb(176, 128, 20)',
  platinum: 'rgb(45, 58, 78)'
};

export interface WalletCard {
  number: string;
  customerName: string;
  enterpriseName: string;
  points: number;
  tier: string;
  tierName: string;
  discountPercent: number;
  nextTier: { name: string; remaining: number } | null;
  recent: Array<{ date: string | Date; type: string; points: number; description: string | null }>;
}

const money = (n: number) => Math.round(n).toLocaleString('ru-RU').replace(/\u00a0/g, ' ') + ' ₽';
const TX = { earn: 'Начисление', redeem: 'Списание', adjust: 'Корректировка', expire: 'Сгорание' } as Record<string, string>;

/**
 * pass.json карты (стиль storeCard). Поля по схеме карт лояльности:
 * сверху баллы, крупно уровень и скидка, ниже гость и путь до следующего
 * уровня, номер карты и штрихкод; на обороте — ссылка и история.
 * changeMessage — текст уведомления, когда поле меняется после обновления.
 */
export function buildPassJson(card: WalletCard, o: {
  passTypeId: string; teamId: string; serialNumber: string; authToken: string; webServiceURL: string; cardUrl: string;
}): Record<string, any> {
  const tierLine = card.tierName + (card.discountPercent > 0 ? ` · скидка ${card.discountPercent}%` : '');
  const secondary: any[] = [{ key: 'guest', label: 'ГОСТЬ', value: card.customerName }];
  if (card.nextTier) {
    secondary.push({ key: 'next', label: `ДО «${card.nextTier.name.toUpperCase()}»`, value: money(card.nextTier.remaining),
                     textAlignment: 'PKTextAlignmentRight' });
  }
  const history = card.recent.length
    ? card.recent.map(t => {
        const d = new Date(t.date);
        const date = isNaN(+d) ? '' : d.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
        return `${date} ${TX[t.type] || t.type}: ${t.points > 0 ? '+' : ''}${t.points}${t.description ? ' — ' + t.description : ''}`;
      }).join('\n')
    : 'Операций пока нет';
  return {
    formatVersion: 1,
    passTypeIdentifier: o.passTypeId,
    teamIdentifier: o.teamId,
    serialNumber: o.serialNumber,
    authenticationToken: o.authToken,
    webServiceURL: o.webServiceURL,
    organizationName: card.enterpriseName,
    description: `Карта гостя «${card.enterpriseName}»`,
    logoText: card.enterpriseName,
    backgroundColor: TIER_COLORS[card.tier] || TIER_COLORS.bronze,
    foregroundColor: 'rgb(255, 255, 255)',
    labelColor: 'rgb(255, 236, 200)',
    sharingProhibited: true,
    // Код линейный (Code128) — его читают и кассовые сканеры-клавиатуры;
    // QR — запасной для старых и 2D-сканеров. Wallet берёт первый, который умеет.
    barcodes: [
      { format: 'PKBarcodeFormatCode128', message: card.number, messageEncoding: 'iso-8859-1', altText: card.number },
      { format: 'PKBarcodeFormatQR', message: card.number, messageEncoding: 'iso-8859-1', altText: card.number }
    ],
    storeCard: {
      headerFields: [{ key: 'points', label: 'БАЛЛЫ', value: card.points, changeMessage: 'Баллов на карте: %@' }],
      primaryFields: [{ key: 'tier', label: 'УРОВЕНЬ', value: tierLine, changeMessage: 'Ваш уровень: %@' }],
      secondaryFields: secondary,
      auxiliaryFields: [{ key: 'number', label: 'НОМЕР КАРТЫ', value: card.number }],
      backFields: [
        { key: 'link', label: 'Карта онлайн', value: o.cardUrl,
          attributedValue: `<a href="${o.cardUrl}">Открыть карту</a>` },
        { key: 'history', label: 'Последние операции', value: history },
        { key: 'how', label: 'Как пользоваться', value: 'Покажите штрихкод на кассе или назовите номер карты — кассир найдёт вас и начислит баллы.' }
      ]
    }
  };
}

const ASSETS = path.join(__dirname, '../../assets/wallet');
let assetCache: Record<string, Buffer> | null = null;
function assets(): Record<string, Buffer> {
  if (!assetCache) {
    assetCache = {};
    for (const f of ['icon.png', 'icon@2x.png', 'logo.png', 'logo@2x.png']) {
      assetCache[f] = fs.readFileSync(path.join(ASSETS, f));
    }
  }
  return assetCache;
}

/** Подписанный .pkpass. */
export function buildPkpass(cfg: WalletConfig, passJson: Record<string, any>): Buffer {
  const pass = new PKPass(
    { ...assets(), 'pass.json': Buffer.from(JSON.stringify(passJson)) },
    { wwdr: cfg.wwdr, signerCert: cfg.signerCert, signerKey: cfg.signerKey, signerKeyPassphrase: cfg.signerKeyPassphrase }
  );
  return pass.getAsBuffer();
}

/** Сравнение секрета без утечки по времени ответа. */
export function sameToken(given: string | undefined, expected: string): boolean {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** «ApplePass <token>» → token. */
export function applePassToken(header: string | undefined): string | undefined {
  const m = /^ApplePass\s+(\S+)$/.exec(String(header || '').trim());
  return m ? m[1] : undefined;
}

export type PushResult = 'ok' | 'gone' | 'error';

/**
 * «Устройство больше не принимает» — только 410 или 400 с причиной про сам
 * токен. Прочие 400 (неверная тема, сертификат) — ошибка настройки: удалять
 * из-за неё регистрации нельзя, иначе одна опечатка стирает все телефоны.
 */
export function classifyApns(status: number, body: string): PushResult {
  if (status === 200) return 'ok';
  if (status === 410) return 'gone';
  if (status === 400) {
    let reason = '';
    try { reason = JSON.parse(body || '{}').reason || ''; } catch { /* не JSON */ }
    if (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic') return 'gone';
  }
  return 'error';
}

/**
 * Пустой push в APNs по токену устройства: «карта обновилась, забери».
 * Тема — Pass Type ID, клиентский сертификат TLS — тот же, что подписывает карту.
 */
export function apnsSender(cfg: WalletConfig) {
  let session: http2.ClientHttp2Session | null = null;
  const connect = () => {
    if (session && !session.closed && !session.destroyed) return session;
    session = http2.connect(cfg.apnsHost, {
      cert: cfg.signerCert, key: cfg.signerKey, passphrase: cfg.signerKeyPassphrase
    });
    session.on('error', () => { session = null; });
    session.on('goaway', () => { session = null; });
    return session;
  };
  return (pushToken: string): Promise<PushResult> => new Promise((resolve) => {
    let s: http2.ClientHttp2Session;
    try { s = connect(); } catch { resolve('error'); return; }
    const req = s.request({
      ':method': 'POST', ':path': `/3/device/${pushToken}`,
      'apns-topic': cfg.passTypeId, 'apns-push-type': 'background', 'content-type': 'application/json'
    });
    let status = 0;
    let body = '';
    req.setTimeout(10000, () => { req.close(); resolve('error'); });
    req.on('response', (h) => { status = Number(h[':status']) || 0; });
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(classifyApns(status, body)));
    req.on('error', () => resolve('error'));
    req.end('{}');
  });
}
