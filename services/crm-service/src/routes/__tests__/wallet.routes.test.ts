/**
 * Протокол сервиса обновлений Apple Wallet и выдача карты.
 * Пути, коды ответов и заголовки заданы Apple — телефон ждёт именно их.
 */
import walletRouter from '../wallet.routes';
import crmRouter from '../crm.routes';
import { setWalletConfig } from '../../services/wallet.runtime';

jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../../middleware/auth.middleware', () => ({
  authenticateUser: (_req: any, _res: any, next: any) => next(),
  authenticateInternal: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next()
}));

const AUTH = 'a'.repeat(64);
const TOKEN = 'b'.repeat(64);
const UPDATED = new Date('2026-11-14T10:00:00.500Z');
const calls: any[] = [];
let registered = new Set<string>();
let updatedSerials: any = { serials: [], lastUpdated: null };
const LOADED = { card: { number: '10000001', customerName: 'Анна', enterpriseName: 'К', points: 1, tier: 'gold', tierName: 'Золото',
  discountPercent: 10, nextTier: null, recent: [] }, profileId: 'p1', enterpriseId: 'e1', cardToken: TOKEN, walletAuthToken: AUTH, walletUpdatedAt: UPDATED };

jest.mock('../../services/crm.service', () => {
  const actual = jest.requireActual('../../services/crm.service');
  return { ...actual, CRMService: class {
    loadCard(by: string, v: string) { calls.push(['load', by, v]); return Promise.resolve((by === 'serial' && v === '10000001') || (by === 'token' && v === 'b'.repeat(64)) ? LOADED : null); }
    getCardByToken(t: string) { return Promise.resolve(t === 'b'.repeat(64) ? { ...LOADED.card } : null); }
    walletRegister(d: string, pt: string, type: string, s: string, p: string) {
      calls.push(['reg', d, pt, type, s, p]); const k = d + s; const isNew = !registered.has(k); registered.add(k); return Promise.resolve(isNew); }
    walletUnregister(d: string, type: string, s: string) { calls.push(['unreg', d, type, s]); return Promise.resolve(); }
    walletUpdatedSerials(d: string, type: string, since?: string) { calls.push(['list', d, type, since]); return Promise.resolve(updatedSerials); }
  } };
});
jest.mock('../../services/wallet.service', () => {
  const actual = jest.requireActual('../../services/wallet.service');
  return { ...actual, buildPkpass: (_cfg: any, pass: any) => Buffer.from('PKPASS:' + JSON.stringify(pass)) };
});

const CFG: any = { passTypeId: 'pass.ru.foodflow.card', teamId: 'TEAM', signerCert: Buffer.from(''), signerKey: Buffer.from(''), wwdr: Buffer.from(''), apnsHost: 'https://x' };

async function call(router: any, method: string, url: string, { headers = {}, body = {} }: any = {}) {
  return new Promise<{ status: number; body: any; hdr: Record<string, string> }>((resolve) => {
    const [pathname, qs] = url.split('?');
    const req: any = { method: method.toUpperCase(), url, originalUrl: url, path: pathname, headers, body,
      query: Object.fromEntries(new URLSearchParams(qs || '')), params: {} };
    let status = 200; const hdr: Record<string, string> = {};
    const res: any = {
      status(c: number) { status = c; return res; }, set(k: string, v: string) { hdr[k] = v; return res; },
      setHeader(k: string, v: string) { hdr[k] = v; }, getHeader(k: string) { return hdr[k]; },
      json(b: any) { resolve({ status, body: b, hdr }); return res; },
      send(b: any) { resolve({ status, body: b, hdr }); return res; },
      end() { resolve({ status, body: undefined, hdr }); return res; }
    };
    router.handle(req, res, () => resolve({ status: 404, body: 'не найден маршрут', hdr }));
  });
}
const ap = (t = AUTH) => ({ authorization: 'ApplePass ' + t });
const REG = '/v1/devices/dev1/registrations/pass.ru.foodflow.card/10000001';

beforeEach(() => { calls.length = 0; registered = new Set(); updatedSerials = { serials: [], lastUpdated: null }; setWalletConfig(CFG); });
afterAll(() => setWalletConfig(undefined));

it('без сертификата — всё 404, кнопки на карте нет', async () => {
  setWalletConfig(null);
  expect((await call(walletRouter, 'post', REG, { headers: ap(), body: { pushToken: 'ab'.repeat(16) } })).status).toBe(404);
  expect((await call(walletRouter, 'get', '/v1/passes/pass.ru.foodflow.card/10000001', { headers: ap() })).status).toBe(404);
  expect((await call(crmRouter, 'get', `/card/${TOKEN}/wallet.pkpass`)).status).toBe(404);
  const card = await call(crmRouter, 'get', `/card/${TOKEN}`);
  expect(card.body.card.appleWalletUrl).toBeUndefined();
  expect(calls.filter(c => c[0] === 'reg')).toHaveLength(0);
});

it('регистрация: 201 новая, 200 повторная; без секрета 401; чужой тип 404; кривой токен 400', async () => {
  const body = { pushToken: 'ab'.repeat(16) };
  expect((await call(walletRouter, 'post', REG, { headers: ap(), body })).status).toBe(201);
  expect((await call(walletRouter, 'post', REG, { headers: ap(), body })).status).toBe(200);
  expect(calls.filter(c => c[0] === 'reg')[0]).toEqual(['reg', 'dev1', 'ab'.repeat(16), 'pass.ru.foodflow.card', '10000001', 'p1']);
  expect((await call(walletRouter, 'post', REG, { headers: ap('c'.repeat(64)), body })).status).toBe(401);
  expect((await call(walletRouter, 'post', REG, { headers: { authorization: 'Bearer ' + AUTH }, body })).status).toBe(401);
  expect((await call(walletRouter, 'post', REG.replace('pass.ru.foodflow.card', 'pass.other'), { headers: ap(), body })).status).toBe(404);
  expect((await call(walletRouter, 'post', REG, { headers: ap(), body: { pushToken: '<script>' } })).status).toBe(400);
  expect(calls.filter(c => c[0] === 'reg')).toHaveLength(2);
});

it('удаление регистрации — только с секретом', async () => {
  expect((await call(walletRouter, 'delete', REG, { headers: ap('x'.repeat(64)) })).status).toBe(401);
  expect((await call(walletRouter, 'delete', REG, { headers: ap() })).status).toBe(200);
  expect(calls.filter(c => c[0] === 'unreg')).toEqual([['unreg', 'dev1', 'pass.ru.foodflow.card', '10000001']]);
});

it('список изменённых карт: 204 пусто, 200 с serialNumbers и lastUpdated', async () => {
  const url = '/v1/devices/dev1/registrations/pass.ru.foodflow.card';
  expect((await call(walletRouter, 'get', url)).status).toBe(204);
  updatedSerials = { serials: ['10000001'], lastUpdated: UPDATED.toISOString() };
  const r = await call(walletRouter, 'get', url + '?passesUpdatedSince=2026-11-13T00:00:00Z');
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ serialNumbers: ['10000001'], lastUpdated: UPDATED.toISOString() });
  expect(calls.at(-1)).toEqual(['list', 'dev1', 'pass.ru.foodflow.card', '2026-11-13T00:00:00Z']);
});

it('свежая карта: 401 без секрета, 200 с типом pkpass и Last-Modified, 304 если не менялась', async () => {
  const url = '/v1/passes/pass.ru.foodflow.card/10000001';
  expect((await call(walletRouter, 'get', url, { headers: ap('z'.repeat(64)) })).status).toBe(401);
  const ok = await call(walletRouter, 'get', url, { headers: { ...ap(), host: 'coffee104.food-flow.ru' } });
  expect(ok.status).toBe(200);
  expect(ok.hdr['Content-Type']).toBe('application/vnd.apple.pkpass');
  expect(ok.hdr['Last-Modified']).toBe(UPDATED.toUTCString());
  const pass = JSON.parse(String(ok.body).slice('PKPASS:'.length));
  expect(pass).toMatchObject({ serialNumber: '10000001', authenticationToken: AUTH, webServiceURL: 'https://coffee104.food-flow.ru/api/wallet/' });
  expect(pass.storeCard.backFields[0].value).toBe('https://coffee104.food-flow.ru/card/?t=' + TOKEN);
  expect((await call(walletRouter, 'get', url, { headers: { ...ap(), 'if-modified-since': UPDATED.toUTCString() } })).status).toBe(304);
  expect((await call(walletRouter, 'get', url, { headers: { ...ap(), 'if-modified-since': new Date(UPDATED.getTime() - 2000).toUTCString() } })).status).toBe(200);
});

it('страница карты: кнопка Apple Wallet и скачивание по секрету ссылки', async () => {
  const card = await call(crmRouter, 'get', `/card/${TOKEN}`, { headers: { host: 'coffee104.food-flow.ru' } });
  expect(card.body.card.appleWalletUrl).toBe(`https://coffee104.food-flow.ru/api/crm/card/${TOKEN}/wallet.pkpass`);
  const dl = await call(crmRouter, 'get', `/card/${TOKEN}/wallet.pkpass`);
  expect(dl.status).toBe(200);
  expect(dl.hdr['Content-Type']).toBe('application/vnd.apple.pkpass');
  expect(dl.hdr['Content-Disposition']).toBe('attachment; filename="card-10000001.pkpass"');
  expect((await call(crmRouter, 'get', `/card/${'0'.repeat(64)}/wallet.pkpass`)).status).toBe(404);
  expect((await call(crmRouter, 'get', '/card/10000001/wallet.pkpass')).status).toBe(404);
});
