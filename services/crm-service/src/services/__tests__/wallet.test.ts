/**
 * Apple Wallet: устройство карты, подпись, разбор ответов APNs, рассылка.
 * Подпись проверяется на самоподписанной паре (CA в роли WWDR + сертификат
 * подписанта), созданной здесь же: настоящий сертификат Apple не нужен,
 * а цепочка подписи та же.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
// @ts-ignore — типов node-forge в проекте нет, нужен только в тесте
import forge from 'node-forge';
import { buildPassJson, buildPkpass, classifyApns, applePassToken, sameToken, loadWalletConfig, TIER_COLORS, WalletCard } from '../wallet.service';
import { walletPushTick } from '../wallet.pusher';

const CARD: WalletCard = {
  number: '10000001', customerName: 'Анна', enterpriseName: 'Кофейня 104', points: 120, tier: 'gold', tierName: 'Золото',
  discountPercent: 10, nextTier: { name: 'Платина', remaining: 7500 },
  recent: [{ date: '2026-11-12T10:00:00Z', type: 'earn', points: 15, description: 'Заказ ORD-1' }]
};
const OPTS = { passTypeId: 'pass.ru.foodflow.card', teamId: 'TEAM123456', serialNumber: '10000001', authToken: 'a'.repeat(64),
  webServiceURL: 'https://coffee104.food-flow.ru/api/wallet/', cardUrl: 'https://coffee104.food-flow.ru/card/?t=' + 'b'.repeat(64) };

describe('pass.json', () => {
  const p = buildPassJson(CARD, OPTS);
  it('идентификаторы, сервис обновлений и секрет', () => {
    expect(p).toMatchObject({ formatVersion: 1, passTypeIdentifier: OPTS.passTypeId, teamIdentifier: OPTS.teamId,
      serialNumber: '10000001', authenticationToken: OPTS.authToken, webServiceURL: OPTS.webServiceURL, organizationName: 'Кофейня 104' });
  });
  it('поля: баллы, уровень со скидкой, гость, до следующего уровня, номер', () => {
    const f = p.storeCard;
    expect(f.headerFields[0]).toMatchObject({ key: 'points', value: 120, changeMessage: 'Баллов на карте: %@' });
    expect(f.primaryFields[0]).toMatchObject({ key: 'tier', value: 'Золото · скидка 10%' });
    expect(f.secondaryFields.map((x: any) => [x.key, x.value])).toEqual([['guest', 'Анна'], ['next', '7 500 ₽']]);
    expect(f.auxiliaryFields[0]).toMatchObject({ key: 'number', value: '10000001' });
    expect(f.backFields.find((x: any) => x.key === 'history').value).toMatch(/Начисление: \+15 — Заказ ORD-1/);
    expect(f.backFields.find((x: any) => x.key === 'link').value).toBe(OPTS.cardUrl);
  });
  it('штрихкод Code128 первым, QR запасным — оба с номером карты, не с секретом', () => {
    expect(p.barcodes.map((b: any) => [b.format, b.message])).toEqual([
      ['PKBarcodeFormatCode128', '10000001'], ['PKBarcodeFormatQR', '10000001']]);
  });
  it('цвет по уровню; без скидки и следующего уровня — без лишних строк', () => {
    expect(p.backgroundColor).toBe(TIER_COLORS.gold);
    const b = buildPassJson({ ...CARD, tier: 'bronze', tierName: 'Бронза', discountPercent: 0, nextTier: null, recent: [] }, OPTS);
    expect(b.backgroundColor).toBe(TIER_COLORS.bronze);
    expect(b.storeCard.primaryFields[0].value).toBe('Бронза');
    expect(b.storeCard.secondaryFields).toHaveLength(1);
    expect(b.storeCard.backFields.find((x: any) => x.key === 'history').value).toBe('Операций пока нет');
  });
});

/** CA (в роли WWDR) и подписант, выпущенный этим CA. */
function makeCerts() {
  const mk = (cn: string, issuer: forge.pki.CertificateField[] | null, signKey: forge.pki.PrivateKey | null) => {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '0' + crypto.randomBytes(8).toString('hex');
    cert.validity.notBefore = new Date(Date.now() - 86400000);
    cert.validity.notAfter = new Date(Date.now() + 86400000 * 30);
    const subj = [{ name: 'commonName', value: cn }];
    cert.setSubject(subj);
    cert.setIssuer(issuer || subj);
    cert.sign((signKey || keys.privateKey) as any, forge.md.sha256.create());
    return { keys, cert, subj };
  };
  const ca = mk('Test WWDR', null, null);
  const signer = mk('Pass Type ID: pass.ru.foodflow.card', ca.subj, ca.keys.privateKey);
  return {
    wwdr: Buffer.from(forge.pki.certificateToPem(ca.cert)),
    signerCert: Buffer.from(forge.pki.certificateToPem(signer.cert)),
    signerKey: Buffer.from(forge.pki.privateKeyToPem(signer.keys.privateKey))
  };
}

describe('подписанный .pkpass', () => {
  jest.setTimeout(60000);
  const certs = makeCerts();
  const cfg = { passTypeId: OPTS.passTypeId, teamId: OPTS.teamId, apnsHost: 'https://x', ...certs };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkpass-'));
  const file = path.join(dir, 'card.pkpass');
  fs.writeFileSync(file, buildPkpass(cfg, buildPassJson(CARD, OPTS)));
  execFileSync('unzip', ['-q', '-o', file, '-d', path.join(dir, 'x')]);
  const x = (f: string) => fs.readFileSync(path.join(dir, 'x', f));

  it('в архиве pass.json, картинки, manifest и подпись', () => {
    expect(fs.readdirSync(path.join(dir, 'x')).sort()).toEqual(
      ['icon.png', 'icon@2x.png', 'logo.png', 'logo@2x.png', 'manifest.json', 'pass.json', 'signature']);
    expect(JSON.parse(x('pass.json').toString()).serialNumber).toBe('10000001');
  });
  it('manifest — SHA-1 каждого файла (по нему Wallet проверяет целостность)', () => {
    const m = JSON.parse(x('manifest.json').toString());
    for (const f of ['pass.json', 'icon.png', 'icon@2x.png', 'logo.png', 'logo@2x.png']) {
      expect(m[f]).toBe(crypto.createHash('sha1').update(x(f)).digest('hex'));
    }
  });
  it('подпись PKCS#7 над manifest сертификатом подписанта, в цепочке WWDR', () => {
    const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(x('signature').toString('binary')))) as any;
    const cns = p7.certificates.map((c: any) => c.subject.getField('CN').value).sort();
    expect(cns).toEqual(['Pass Type ID: pass.ru.foodflow.card', 'Test WWDR']);
  });
  it('openssl подтверждает подпись над manifest.json по цепочке от WWDR; подмена manifest ломает подпись', () => {
    fs.writeFileSync(path.join(dir, 'ca.pem'), certs.wwdr);
    const verify = (content: string) => execFileSync('openssl', ['smime', '-verify', '-binary', '-inform', 'DER',
      '-in', path.join(dir, 'x', 'signature'), '-content', content, '-CAfile', path.join(dir, 'ca.pem'),
      '-purpose', 'any', '-out', '/dev/null'], { stdio: 'pipe' });
    expect(() => verify(path.join(dir, 'x', 'manifest.json'))).not.toThrow();
    const forged = path.join(dir, 'forged.json');
    fs.writeFileSync(forged, x('manifest.json').toString().replace(/"pass\.json":"[0-9a-f]+"/, '"pass.json":"' + '0'.repeat(40) + '"'));
    expect(() => verify(forged)).toThrow();
  });
});

describe('APNs и авторизация', () => {
  it('«устройство ушло» — только 410 или причина про токен', () => {
    expect(classifyApns(200, '')).toBe('ok');
    expect(classifyApns(410, '{"reason":"Unregistered"}')).toBe('gone');
    expect(classifyApns(400, '{"reason":"BadDeviceToken"}')).toBe('gone');
    expect(classifyApns(400, '{"reason":"DeviceTokenNotForTopic"}')).toBe('gone');
    expect(classifyApns(400, '{"reason":"TopicDisallowed"}')).toBe('error');
    expect(classifyApns(403, '{"reason":"BadCertificate"}')).toBe('error');
    expect(classifyApns(500, 'мусор')).toBe('error');
  });
  it('заголовок ApplePass и сравнение секрета', () => {
    expect(applePassToken('ApplePass abc123')).toBe('abc123');
    expect(applePassToken('Bearer abc123')).toBeUndefined();
    expect(applePassToken(undefined)).toBeUndefined();
    expect(sameToken('abc', 'abc')).toBe(true);
    expect(sameToken('abd', 'abc')).toBe(false);
    expect(sameToken(undefined, 'abc')).toBe(false);
  });
  it('без любого из файлов сертификата или идентификаторов — Wallet выключен', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcert-'));
    const env = { WALLET_PASS_TYPE_ID: 'pass.x', WALLET_TEAM_ID: 'T', WALLET_CERT_DIR: dir } as any;
    expect(loadWalletConfig(env)).toBeNull();
    for (const f of ['signerCert.pem', 'signerKey.pem']) fs.writeFileSync(path.join(dir, f), 'x');
    expect(loadWalletConfig(env)).toBeNull();
    fs.writeFileSync(path.join(dir, 'wwdr.pem'), 'x');
    expect(loadWalletConfig(env)).toMatchObject({ passTypeId: 'pass.x', teamId: 'T', apnsHost: 'https://api.push.apple.com' });
    expect(loadWalletConfig({ ...env, WALLET_TEAM_ID: '' })).toBeNull();
  });
});

describe('рассылка push', () => {
  const at = new Date('2026-11-14T10:00:00Z');
  const crm = (pending: any[]) => {
    const log: any[] = [];
    return { log, crm: {
      walletPending: async () => pending,
      walletDropToken: async (t: string) => { log.push(['drop', t]); },
      walletMarkPushed: async (id: string, d: Date) => { log.push(['mark', id, d.toISOString()]); }
    } as any };
  };
  it('все телефоны разбужены — карта отмечена меткой изменения', async () => {
    const { crm: c, log } = crm([{ profileId: 'p1', updatedAt: at, tokens: ['t1', 't2'] }]);
    const sent: string[] = [];
    expect(await walletPushTick(c, 'pass.x', async (t) => { sent.push(t); return 'ok'; })).toBe(1);
    expect(sent).toEqual(['t1', 't2']);
    expect(log).toEqual([['mark', 'p1', at.toISOString()]]);
  });
  it('ушедший телефон удаляется, карта всё равно отмечена', async () => {
    const { crm: c, log } = crm([{ profileId: 'p1', updatedAt: at, tokens: ['t1'] }]);
    await walletPushTick(c, 'pass.x', async () => 'gone');
    expect(log).toEqual([['drop', 't1'], ['mark', 'p1', at.toISOString()]]);
  });
  it('сбой APNs — не отмечаем, следующий проход повторит', async () => {
    const { crm: c, log } = crm([{ profileId: 'p1', updatedAt: at, tokens: ['t1', 't2'] }]);
    expect(await walletPushTick(c, 'pass.x', async (t) => (t === 't1' ? 'error' : 'ok'))).toBe(0);
    expect(log).toEqual([]);
  });
});
