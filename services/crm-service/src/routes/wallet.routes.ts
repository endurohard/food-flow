/**
 * Сервис обновлений Apple Wallet (PassKit Web Service).
 * Пути и ответы заданы Apple, телефон ходит сюда сам по webServiceURL из
 * карты: https://<домен>/api/wallet/ + «v1/…».
 *
 * Доступ к карте — заголовок «Authorization: ApplePass <authenticationToken>»
 * (wallet_auth_token карты). Без сертификата всё отвечает 404.
 */
import { Router, Request, Response } from 'express';
import { CRMService, cardBaseUrl } from '../services/crm.service';
import { buildPassJson, buildPkpass, sameToken, applePassToken } from '../services/wallet.service';
import { getWalletConfig } from '../services/wallet.runtime';
import { config } from '../config';

const router = Router();
const crm = new CRMService(config.database.url);

const DEVICE_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SERIAL_RE = /^\d{6,12}$/;

/** Карта по серийному номеру с проверкой секрета из заголовка; иначе null. */
async function authorizedCard(req: Request, serial: string) {
  if (!SERIAL_RE.test(serial)) return null;
  const loaded = await crm.loadCard('serial', serial);
  if (!loaded) return null;
  return sameToken(applePassToken(req.headers.authorization), loaded.walletAuthToken) ? loaded : null;
}

/** Собрать подписанную карту для профиля. */
export function renderPass(loaded: NonNullable<Awaited<ReturnType<CRMService['loadCard']>>>, headers: Record<string, any>): Buffer {
  const cfg = getWalletConfig()!;
  const base = cardBaseUrl(headers);
  return buildPkpass(cfg, buildPassJson(loaded.card, {
    passTypeId: cfg.passTypeId, teamId: cfg.teamId,
    serialNumber: loaded.card.number,
    authToken: loaded.walletAuthToken,
    webServiceURL: `${base}/api/wallet/`,
    cardUrl: `${base}/card/?t=${loaded.cardToken}`
  }));
}

export function sendPass(res: Response, buf: Buffer, updatedAt: Date, filename = 'card.pkpass') {
  res.set('Content-Type', 'application/vnd.apple.pkpass');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.set('Last-Modified', new Date(updatedAt).toUTCString());
  res.set('Cache-Control', 'no-store');
  return res.status(200).send(buf);
}

// Без сертификата сервис обновлений не существует
router.use((_req: Request, res: Response, next) => {
  if (!getWalletConfig()) return res.status(404).json({ error: 'Apple Wallet не подключён' });
  return next();
});

/** Карта чужого типа (не наш Pass Type ID) — не наша: 404 */
const ourType = (req: Request) => req.params.passType === getWalletConfig()!.passTypeId;

// Телефон добавил карту и подписывается на её обновления
router.post('/v1/devices/:device/registrations/:passType/:serial', async (req: Request, res: Response) => {
  try {
    if (!ourType(req)) return res.status(404).end();
    const { device, serial } = req.params;
    const pushToken = String(req.body?.pushToken || '');
    if (!DEVICE_RE.test(device) || !/^[A-Fa-f0-9]{16,256}$/.test(pushToken)) return res.status(400).end();
    const loaded = await authorizedCard(req, serial);
    if (!loaded) return res.status(401).end();
    const created = await crm.walletRegister(device, pushToken, req.params.passType, serial, loaded.profileId);
    return res.status(created ? 201 : 200).end();
  } catch (e) { console.error('Wallet register error:', e); return res.status(500).end(); }
});

// Карта удалена с телефона
router.delete('/v1/devices/:device/registrations/:passType/:serial', async (req: Request, res: Response) => {
  try {
    if (!ourType(req)) return res.status(404).end();
    const { device, serial } = req.params;
    if (!DEVICE_RE.test(device)) return res.status(400).end();
    const loaded = await authorizedCard(req, serial);
    if (!loaded) return res.status(401).end();
    await crm.walletUnregister(device, req.params.passType, serial);
    return res.status(200).end();
  } catch (e) { console.error('Wallet unregister error:', e); return res.status(500).end(); }
});

// Какие карты телефона изменились (после push). Без авторизации — так в протоколе:
// отдаются только серийные номера, сами карты — по секрету.
router.get('/v1/devices/:device/registrations/:passType', async (req: Request, res: Response) => {
  try {
    if (!ourType(req)) return res.status(404).end();
    if (!DEVICE_RE.test(req.params.device)) return res.status(400).end();
    const since = typeof req.query.passesUpdatedSince === 'string' ? req.query.passesUpdatedSince : undefined;
    const r = await crm.walletUpdatedSerials(req.params.device, req.params.passType, since);
    if (!r.serials.length) return res.status(204).end();
    return res.json({ serialNumbers: r.serials, lastUpdated: r.lastUpdated });
  } catch (e) { console.error('Wallet updated list error:', e); return res.status(500).end(); }
});

// Свежая версия карты
router.get('/v1/passes/:passType/:serial', async (req: Request, res: Response) => {
  try {
    if (!ourType(req)) return res.status(404).end();
    const loaded = await authorizedCard(req, req.params.serial);
    if (!loaded) return res.status(401).end();
    const ims = req.headers['if-modified-since'];
    // Last-Modified с точностью до секунды — сравниваем так же
    if (ims && !isNaN(Date.parse(String(ims))) &&
        Math.floor(new Date(loaded.walletUpdatedAt).getTime() / 1000) <= Math.floor(Date.parse(String(ims)) / 1000)) {
      return res.status(304).end();
    }
    return sendPass(res, renderPass(loaded, req.headers), loaded.walletUpdatedAt);
  } catch (e) { console.error('Wallet pass error:', e); return res.status(500).end(); }
});

// Журнал ошибок от телефонов: пишем коротко, без сохранения
router.post('/v1/log', (req: Request, res: Response) => {
  const logs = Array.isArray(req.body?.logs) ? req.body.logs.slice(0, 20).map((x: any) => String(x).slice(0, 300)) : [];
  if (logs.length) console.warn('Apple Wallet log:', logs.join(' | '));
  return res.status(200).end();
});

export default router;
