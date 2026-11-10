/**
 * Общий Telegram-бот платформы: подключает и отключает только супер-админ.
 * Владелец организации не должен ни видеть его статус, ни подменить токен —
 * иначе он перехватил бы уведомления всех организаций без своего бота.
 */
let role = 'super_admin';
jest.mock('../../middleware/enterprise.middleware', () => ({
  authenticateUser: (req: any, _res: any, next: any) => { req.userId = 'u-1'; req.userRole = role; next(); }
}));
jest.mock('pg', () => ({ __esModule: true, default: { Pool: class { query() { return { rows: [] }; } } } }));
jest.mock('../../services/enterprise.service', () => ({ EnterpriseService: class {} }));

import { createPlatformBotRoutes } from '../telegram.routes';

const calls: string[] = [];
const tg: any = {
  getPlatformStatus: async () => { calls.push('status'); return { connected: true, botUsername: 'foodflow_bot' }; },
  savePlatformBot: async (token: string) => { calls.push('save:' + token); return { botUsername: 'foodflow_bot' }; },
  removePlatformBot: async () => { calls.push('remove'); }
};

async function call(method: string, body: any = {}) {
  const router: any = createPlatformBotRoutes(tg);
  const layer = router.stack.find((l: any) => l.route && l.route.path === '/' && l.route.methods[method]);
  const req: any = { params: {}, body, query: {}, headers: {} };
  let status = 200; let out: any;
  const res: any = { status(c: number) { status = c; return res; }, json(b: any) { out = b; return res; } };
  for (const h of layer.route.stack.map((s: any) => s.handle)) {
    let next = false;
    await h(req, res, () => { next = true; });
    if (!next) break;
  }
  return { status, body: out };
}

beforeEach(() => { role = 'super_admin'; calls.length = 0; });

describe('/api/enterprises/platform/telegram-bot', () => {
  it.each(['get', 'put', 'delete'])('%s: не супер-админ получает 403 и ничего не меняется', async (m) => {
    role = 'restaurant_owner';
    const r = await call(m, { token: '1234567890:AAH' + 'x'.repeat(32) });
    expect(r.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('супер-админ подключает бот; ответ без токена', async () => {
    const token = '1234567890:AAH' + 'x'.repeat(32);
    const r = await call('put', { token });
    expect(r.status).toBe(200);
    expect(calls[0]).toBe('save:' + token);
    expect(JSON.stringify(r.body)).not.toContain(token);
  });

  it('без токена — 400', async () => {
    expect((await call('put', {})).status).toBe(400);
  });

  it('супер-админ отключает бот', async () => {
    expect((await call('delete')).status).toBe(200);
    expect(calls).toEqual(['remove']);
  });
});
