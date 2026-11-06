/** Вход кассира одним PIN с привязанного планшета. */
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const ENT = '22222222-2222-4222-8222-222222222222';
const REG = '33333333-3333-4333-8333-333333333333';
const DEV = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'a'.repeat(64);
const HASH = crypto.createHash('sha256').update(TOKEN).digest('hex');

const queries: { sql: string; params: any[] }[] = [];
const db: any = {};

function answer(sql: string, params: any[]) {
  queries.push({ sql, params });
  if (/FROM cash_register_devices d[\s\S]*WHERE d\.token_hash = \$1 AND d\.revoked_at IS NULL/.test(sql)) {
    return { rows: params[0] === HASH && db.device ? [db.device] : [] };
  }
  if (/FROM enterprise_users eu[\s\S]*eu\.enterprise_id = \$1 AND eu\.role = 'cashier'[\s\S]*u\.pin_hash IS NOT NULL/.test(sql)) {
    return { rows: params[0] === ENT ? db.cashiers : [] };
  }
  if (/FROM cash_register_sessions/.test(sql)) return { rows: [] };
  return { rows: [], rowCount: 1 };
}

jest.mock('pg', () => {
  class Pool {
    async query(sql: string, params: any[] = []) { return answer(sql, params); }
    async connect() {
      return { query: async (sql: string, params: any[] = []) => answer(sql, params), release: () => {} };
    }
  }
  return { default: { Pool }, Pool };
});

jest.mock('../../config', () => ({
  config: {
    database: { url: 'x' },
    jwt: { secret: 's', accessExpiresIn: '1h', refreshSecret: 'r' },
    bcrypt: { saltRounds: 4 },
  },
}));

import { AuthService, AuthError } from '../auth.service';

const cashier = (id: string, pin: string) => ({
  id, email: id + '@x.ru', first_name: 'К', last_name: '', phone: null, role: 'customer',
  pin_hash: bcrypt.hashSync(pin, 4),
});

beforeEach(() => {
  queries.length = 0;
  db.device = {
    id: DEV, enterprise_id: ENT, register_id: REG, locked: false, lock_min: null,
    register_name: 'Касса 1', restaurant_id: 'r1', register_status: 'open',
  };
  db.cashiers = [cashier('u-anna', '1111'), cashier('u-dan', '4321')];
});

const svc = () => new AuthService('postgres://x/y');
const sqlOf = (re: RegExp) => queries.filter((q) => re.test(q.sql));

it('PIN находит своего кассира, выдаёт токены и сессию на кассе планшета', async () => {
  const r = await svc().pinLogin(TOKEN, '4321');
  expect(r.user.id).toBe('u-dan');
  expect(r.user.pin_hash).toBeUndefined();
  expect(r.user.enterprise_role).toBe('cashier');
  expect(r.tokens.accessToken).toBeTruthy();
  expect(r.register.id).toBe(REG);
  const ins = sqlOf(/INSERT INTO cash_register_sessions/)[0];
  expect(ins.params.slice(1, 3)).toEqual(['u-dan', REG]);
  // Серия ошибок сбрасывается при успехе
  expect(sqlOf(/SET failed_attempts = 0/)[0].params).toEqual([DEV]);
});

it('ищет кассиров только организации планшета', async () => {
  await svc().pinLogin(TOKEN, '4321');
  const q = sqlOf(/FROM enterprise_users eu/)[0];
  expect(q.params).toEqual([ENT]);
  expect(q.sql).toMatch(/eu\.is_active = true/);
  expect(q.sql).toMatch(/u\.is_active = true/);
});

it('неизвестный или отвязанный планшет — 401 DEVICE_UNKNOWN, кассиров не ищем', async () => {
  db.device = null;
  await expect(svc().pinLogin(TOKEN, '4321')).rejects.toMatchObject({ statusCode: 401, code: 'DEVICE_UNKNOWN' });
  expect(sqlOf(/FROM enterprise_users eu/)).toHaveLength(0);
});

it('неверный PIN — 401 и счётчик ошибок устройства растёт', async () => {
  const e: any = await svc().pinLogin(TOKEN, '9999').catch((x) => x);
  expect(e).toBeInstanceOf(AuthError);
  expect(e.code).toBe('INVALID_PIN');
  const upd = sqlOf(/SET failed_attempts = failed_attempts \+ 1/)[0];
  expect(upd.params[0]).toBe(DEV);
  expect(upd.sql).toMatch(/failed_attempts \+ 1 >= \$2/);
  expect(upd.params[1]).toBe(5);
  expect(sqlOf(/INSERT INTO cash_register_sessions/)).toHaveLength(0);
});

it('заблокированный планшет — 429 без проверки PIN', async () => {
  db.device.locked = true;
  db.device.lock_min = 4;
  await expect(svc().pinLogin(TOKEN, '4321')).rejects.toMatchObject({ statusCode: 429, code: 'PIN_LOCKED' });
  expect(sqlOf(/FROM enterprise_users eu/)).toHaveLength(0);
});
