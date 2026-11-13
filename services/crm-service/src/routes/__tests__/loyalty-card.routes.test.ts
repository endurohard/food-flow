/**
 * Маршруты карты клиента: открытая карта без входа, ссылка для кассира,
 * отзыв ссылки только владельцем/админом, ответ без лишних данных.
 */
import crmRouter from '../crm.routes';

jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

let authCtx: { enterpriseRole?: string; enterpriseId?: string } = { enterpriseRole: 'cashier', enterpriseId: 'ent-own' };
jest.mock('../../middleware/auth.middleware', () => ({
  authenticateUser: (req: any, _res: any, next: any) => {
    req.userId = 'user-1'; req.userRole = 'customer';
    req.enterpriseRole = authCtx.enterpriseRole; req.enterpriseId = authCtx.enterpriseId; next();
  },
  authenticateInternal: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next()
}));

const seen: any[] = [];
let linkRow: any = { card_token: 'f'.repeat(64), card_number: '10000001', first_name: 'Анна', phone: '+7 (999) 123-45-67', enterprise_name: 'Кофейня 104' };
jest.mock('../../services/crm.service', () => {
  const actual = jest.requireActual('../../services/crm.service');
  return {
    ...actual,
    CRMService: class {
      getCardByToken(t: string) { seen.push(['card', t]); return Promise.resolve(t === 'a'.repeat(64) ? { number: '10000001' } : null); }
      getCardLink(p: string, e: string, rotate: boolean) { seen.push(['link', p, e, rotate]); return Promise.resolve(linkRow); }
    }
  };
});

async function call(method: string, path: string, params: any, body: any = {}, headers: any = {}) {
  const layer = (crmRouter as any).stack.find((l: any) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error('нет роута ' + path);
  const req: any = { params, body, query: {}, headers };
  let status = 200; let payload: any; const hdr: any = {};
  const res: any = { status(c: number) { status = c; return res; }, json(b: any) { payload = b; return res; }, set(k: string, v: string) { hdr[k] = v; return res; } };
  const handlers = layer.route.stack.map((s: any) => s.handle);
  for (const h of handlers) { let next = false; await h(req, res, () => { next = true; }); if (!next) break; }
  return { status, body: payload, hdr, handlers: handlers.length };
}
const PID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => { seen.length = 0; authCtx = { enterpriseRole: 'cashier', enterpriseId: 'ent-own' }; });

it('открытая карта — без authenticateUser, no-store, 404 на неизвестную', async () => {
  const ok = await call('get', '/card/:token', { token: 'a'.repeat(64) });
  expect(ok.handlers).toBe(1);
  expect(ok.status).toBe(200);
  expect(ok.hdr['Cache-Control']).toBe('no-store');
  const nf = await call('get', '/card/:token', { token: 'b'.repeat(64) });
  expect(nf.status).toBe(404);
  expect(nf.body.error).toBe('Карта не найдена');
});

it('кассир получает ссылку своей организации на домене, с которого пришёл', async () => {
  const r = await call('post', '/customers/:profileId/card-link', { profileId: PID }, {}, { 'x-forwarded-host': 'kofe104.food-flow.ru' });
  expect(r.status).toBe(200);
  expect(seen).toEqual([['link', PID, 'ent-own', false]]);
  expect(r.body.url).toBe('https://kofe104.food-flow.ru/card/?t=' + 'f'.repeat(64));
  expect(r.body.phone).toBe('+79991234567');
  expect(r.body.smsUri).toBe('sms:+79991234567?&body=' + encodeURIComponent(r.body.message));
  expect(r.body.message).toBe('Анна, ваша карта гостя «Кофейня 104»: ' + r.body.url);
  expect(r.body.telegramUrl).toMatch(/^https:\/\/t\.me\/share\/url\?url=https%3A%2F%2Fkofe104/);
});

it('без телефона — smsUri null', async () => {
  linkRow = { ...linkRow, phone: null };
  const r = await call('post', '/customers/:profileId/card-link', { profileId: PID }, {});
  expect(r.body.smsUri).toBeNull();
  linkRow = { ...linkRow, phone: '+7 (999) 123-45-67' };
});

it('отозвать ссылку — только владелец или админ', async () => {
  const cashier = await call('post', '/customers/:profileId/card-link', { profileId: PID }, { rotate: true });
  expect(cashier.status).toBe(403);
  expect(seen).toHaveLength(0);
  authCtx.enterpriseRole = 'owner';
  const owner = await call('post', '/customers/:profileId/card-link', { profileId: PID }, { rotate: true });
  expect(owner.status).toBe(200);
  expect(seen).toEqual([['link', PID, 'ent-own', true]]);
});

it('без предприятия — 403, кривой id — 400', async () => {
  authCtx.enterpriseId = undefined;
  expect((await call('post', '/customers/:profileId/card-link', { profileId: PID })).status).toBe(403);
  authCtx.enterpriseId = 'ent-own';
  expect((await call('post', '/customers/:profileId/card-link', { profileId: 'x' })).status).toBe(400);
  expect(seen).toHaveLength(0);
});
