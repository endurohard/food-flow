/** Создание кассира: всё одной транзакцией, PIN хешем в той же вставке. */
import bcrypt from 'bcryptjs';

const ENT = '22222222-2222-4222-8222-222222222222';
const outside: string[] = [];
const inside: { sql: string; params: any[] }[] = [];

jest.mock('pg', () => {
  class Pool {
    // Любой запрос мимо транзакции — ошибка: он не видит незакоммиченного кассира
    async query(sql: string) { outside.push(sql); return { rows: [] }; }
    async connect() {
      return {
        release: () => {},
        query: async (sql: string, params: any[] = []) => {
          inside.push({ sql, params });
          if (/SELECT id FROM users WHERE email/.test(sql)) return { rows: [] };
          if (/SELECT id FROM enterprises WHERE id/.test(sql)) return { rows: [{ id: ENT }] };
          if (/INSERT INTO users/.test(sql)) {
            return { rows: [{ id: 'u-new', email: params[0], first_name: params[2], last_name: params[3], phone: null }] };
          }
          return { rows: [], rowCount: 1 };
        },
      };
    }
  }
  return { default: { Pool }, Pool };
});

jest.mock('../../config', () => ({ config: { bcrypt: { saltRounds: 4 }, database: { url: 'x' } } }));

import { EnterpriseService } from '../enterprise.service';

beforeEach(() => { outside.length = 0; inside.length = 0; });

it('кассир создаётся одной транзакцией вместе с PIN', async () => {
  const svc = new EnterpriseService('postgres://x/y');
  const c = await svc.createCashier(ENT, {
    email: 'Kiosk@Example.com', password: 'secret1', firstName: 'Анна', pin: '4321',
  });
  expect(c.enterpriseRole).toBe('cashier');
  expect(outside).toEqual([]);

  const sqls = inside.map((q) => q.sql.trim().split(/\s+/)[0]);
  expect(sqls[0]).toBe('BEGIN');
  expect(sqls[sqls.length - 1]).toBe('COMMIT');

  const ins = inside.find((q) => /INSERT INTO users/.test(q.sql))!;
  const cols = /INSERT INTO users \(([^)]*)\)/.exec(ins.sql)![1].split(',').map((x) => x.trim());
  const vals = /VALUES \(([^)]*)\)/.exec(ins.sql)![1].split(',').map((x) => x.trim());
  expect(cols).toHaveLength(vals.length);
  // В VALUES есть литералы ('customer', false) — параметр ищем по номеру $N
  const pinParam = /^\$(\d+)$/.exec(vals[cols.indexOf('pin_hash')]);
  expect(pinParam).not.toBeNull();
  const pinHash = ins.params[Number(pinParam![1]) - 1];
  expect(await bcrypt.compare('4321', pinHash)).toBe(true);
  expect(ins.params[0]).toBe('kiosk@example.com');

  const eu = inside.find((q) => /INSERT INTO enterprise_users/.test(q.sql))!;
  expect(eu.sql).toMatch(/'cashier'/);
  expect(eu.params).toEqual([ENT, 'u-new']);

  // Кадровая карточка — иначе кассира не видно в «Персонале»
  const sp = inside.find((q) => /INSERT INTO staff_profiles/.test(q.sql))!;
  expect(sp).toBeDefined();
  expect(sp.sql).toMatch(/'cashier'/);
  expect(sp.params).toEqual(['u-new', ENT]);
});

describe('PIN кассиру из «Персонала»', () => {
  it('UPDATE только по кассиру этой организации', async () => {
    const svc = new EnterpriseService('postgres://x/y');
    await svc.setCashierPin(ENT, 'u-1', '5678');
    expect(outside).toHaveLength(1);
    const sql = outside[0];
    expect(sql).toMatch(/eu\.enterprise_id = \$3/);
    expect(sql).toMatch(/eu\.role = 'cashier'/);
    expect(sql).toMatch(/u\.id = \$2/);
  });
});
