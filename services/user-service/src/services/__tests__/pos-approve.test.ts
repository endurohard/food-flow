/** PIN администратора подтверждает возврат на кассе. */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const queries: { sql: string; params: any[] }[] = [];
let session: any = { id: 's1', approve_failures: 0, locked: false };
let admins: any[] = [];

jest.mock('pg', () => {
  class Pool {
    async query(sql: string, params: any[] = []) {
      queries.push({ sql, params });
      if (/FROM cash_register_sessions/.test(sql)) return { rows: session ? [session] : [] };
      if (/eu.role IN \('owner', 'admin'\)/.test(sql)) return { rows: admins };
      return { rows: [] };
    }
    async connect() { return { query: async () => ({ rows: [] }), release: () => {} }; }
  }
  return { default: { Pool }, Pool };
});
jest.mock('../../config', () => ({ config: { database: { url: 'x' }, jwt: { secret: 'sec' }, bcrypt: { saltRounds: 4 } } }));

import { AuthService } from '../auth.service';

const P = { enterpriseId: 'e1', cashierId: 'c1', registerId: 'r1', sessionId: 's1', action: 'refund' };
const svc = () => new AuthService('x');

beforeEach(async () => {
  queries.length = 0;
  session = { id: 's1', approve_failures: 0, locked: false };
  admins = [{ id: 'adm', first_name: 'Анна', last_name: 'Админ', email: 'a@x', pin_hash: await bcrypt.hash('5823', 4) }];
});

it('верный PIN админа — допуск на это действие и эту смену', async () => {
  const r = await svc().approvePosAction({ ...P, pin: '5823' });
  expect(r.approverName).toBe('Анна Админ');
  const t: any = jwt.verify(r.approvalToken, 'sec');
  expect(t).toMatchObject({ typ: 'pos_approval', approverId: 'adm', enterpriseId: 'e1', sessionId: 's1', cashierId: 'c1', action: 'refund' });
  expect(t.exp - t.iat).toBe(300);
});

it('PIN ищется только среди владельца и админов организации', async () => {
  await svc().approvePosAction({ ...P, pin: '5823' });
  const q = queries.find((x) => /FROM enterprise_users eu JOIN users u/.test(x.sql))!;
  expect(q.sql).toMatch(/eu.enterprise_id = \$1 AND eu.role IN \('owner', 'admin'\)/);
  expect(q.params).toEqual(['e1']);
});

it('неверный PIN — 401 и счётчик ошибок растёт', async () => {
  await expect(svc().approvePosAction({ ...P, pin: '0000' })).rejects.toMatchObject({ statusCode: 401 });
  expect(queries.some((x) => /approve_failures \+ 1 >= 5/.test(x.sql))).toBe(true);
});

it('после блокировки — 429 и PIN даже не проверяется', async () => {
  session.locked = true;
  await expect(svc().approvePosAction({ ...P, pin: '5823' })).rejects.toMatchObject({ statusCode: 429 });
  expect(queries.some((x) => /eu.role IN/.test(x.sql))).toBe(false);
});

it('чужая или неактивная смена кассы — 403', async () => {
  session = null;
  await expect(svc().approvePosAction({ ...P, pin: '5823' })).rejects.toMatchObject({ statusCode: 403 });
  const q = queries[0];
  expect(q.sql).toMatch(/user_id = \$2 AND register_id = \$3 AND status = 'active' AND expires_at > NOW\(\)/);
});

it('никто из админов не задал PIN — понятная подсказка', async () => {
  admins = [];
  await expect(svc().approvePosAction({ ...P, pin: '5823' })).rejects.toMatchObject({ statusCode: 409, code: 'NO_ADMIN_PIN' });
});
