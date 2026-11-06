/** Смена пароля сотрудника владельцем/админом. */
import bcrypt from 'bcryptjs';

const ENT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const outside: { sql: string; params: any[] }[] = [];
const inside: { sql: string; params: any[] }[] = [];
let role: string | null = 'cashier';

jest.mock('pg', () => {
  class Pool {
    async query(sql: string, params: any[] = []) {
      outside.push({ sql, params });
      if (/SELECT role FROM enterprise_users WHERE enterprise_id = \$1 AND user_id = \$2/.test(sql)) {
        return { rows: role && params[0] === ENT && params[1] === USER ? [{ role }] : [] };
      }
      return { rows: [] };
    }
    async connect() {
      return { release: () => {}, query: async (sql: string, params: any[] = []) => { inside.push({ sql, params }); return { rows: [], rowCount: 1 }; } };
    }
  }
  return { default: { Pool }, Pool };
});
jest.mock('../../config', () => ({ config: { bcrypt: { saltRounds: 4 }, database: { url: 'x' } } }));

import { EnterpriseService } from '../enterprise.service';

beforeEach(() => { outside.length = 0; inside.length = 0; role = 'cashier'; });
const svc = () => new EnterpriseService('postgres://x/y');

it('сотруднику своей организации — новый хеш и все входы погашены, одной транзакцией', async () => {
  expect(await svc().setStaffPassword(ENT, USER, 'new-pass-123')).toBe('ok');
  expect(inside[0].sql).toBe('BEGIN');
  const upd = inside.find((q) => /UPDATE users SET password_hash/.test(q.sql))!;
  expect(await bcrypt.compare('new-pass-123', upd.params[0])).toBe(true);
  expect(upd.params.slice(1)).toEqual([USER, ENT]);
  // Повторная проверка принадлежности и роли прямо в UPDATE — от гонки с переводом в owner
  expect(upd.sql).toMatch(/eu\.enterprise_id = \$3 AND eu\.user_id = \$2 AND eu\.role <> 'owner'/);
  const rev = inside.find((q) => /UPDATE refresh_tokens SET revoked_at = NOW\(\)/.test(q.sql))!;
  expect(rev.params).toEqual([USER]);
  expect(inside.at(-1)!.sql).toBe('COMMIT');
});

it('чужой организации — not_found, ничего не меняем', async () => {
  role = null;
  expect(await svc().setStaffPassword(ENT, USER, 'new-pass-123')).toBe('not_found');
  expect(inside).toHaveLength(0);
});

it('владельцу — owner, ничего не меняем', async () => {
  role = 'owner';
  expect(await svc().setStaffPassword(ENT, USER, 'new-pass-123')).toBe('owner');
  expect(inside).toHaveLength(0);
});
