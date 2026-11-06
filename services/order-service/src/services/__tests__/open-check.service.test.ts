import { OpenCheckService } from '../open-check.service';

const ENT = '11111111-1111-4111-8111-111111111111';
const REST = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const CHECK = '44444444-4444-4444-8444-444444444444';
const items = [{ menuItemId: '55555555-5555-4555-8555-555555555555', quantity: 2 }];

function makePool(rows: any[] = [{ id: CHECK }]) {
  const calls: { sql: string; params: any[] }[] = [];
  return {
    calls,
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return { rows };
    },
  };
}

describe('отложенные чеки — изоляция организации', () => {
  it('список — только открытые чеки своей организации', async () => {
    const pool = makePool([]);
    await new OpenCheckService(pool).list(ENT, REST);
    expect(pool.calls[0].sql).toMatch(/c\.enterprise_id = \$1 AND c\.status = 'open'/);
    expect(pool.calls[0].sql).toMatch(/c\.restaurant_id = \$2/);
    expect(pool.calls[0].params).toEqual([ENT, REST]);
  });

  it('создание — сначала проверка, что точка своя; чужая точка — null без вставки', async () => {
    const pool = makePool([]);
    const r = await new OpenCheckService(pool).create(ENT, USER, { restaurantId: REST, items });
    expect(r).toBeNull();
    expect(pool.calls[0].sql).toMatch(/FROM restaurants WHERE id = \$1 AND enterprise_id = \$2/);
    expect(pool.calls[0].params).toEqual([REST, ENT]);
    expect(pool.calls.some((c) => /INSERT INTO pos_open_checks/.test(c.sql))).toBe(false);
  });

  it('создание — состав пишется JSON-ом, автор — из токена', async () => {
    const pool = makePool([{ id: REST }]);
    await new OpenCheckService(pool).create(ENT, USER, { restaurantId: REST, label: 'Столик 3', items });
    const ins = pool.calls.find((c) => /INSERT INTO pos_open_checks/.test(c.sql))!;
    expect(ins.params).toEqual([ENT, REST, 'Столик 3', JSON.stringify(items), USER]);
  });

  it('правка — только открытый чек своей организации', async () => {
    const pool = makePool();
    await new OpenCheckService(pool).update(ENT, USER, CHECK, { items });
    expect(pool.calls[0].sql).toMatch(/WHERE id = \$4 AND enterprise_id = \$5 AND status = 'open'/);
    expect(pool.calls[0].params.slice(3)).toEqual([CHECK, ENT]);
  });

  it('удаление — только открытый чек своей организации, статус cancelled', async () => {
    const pool = makePool();
    expect(await new OpenCheckService(pool).cancel(ENT, USER, CHECK)).toBe(true);
    expect(pool.calls[0].sql).toMatch(/SET status = 'cancelled'/);
    expect(pool.calls[0].sql).toMatch(/WHERE id = \$2 AND enterprise_id = \$3 AND status = 'open'/);
    expect(pool.calls[0].params).toEqual([USER, CHECK, ENT]);
  });

  it('удаление несуществующего — false', async () => {
    expect(await new OpenCheckService(makePool([])).cancel(ENT, USER, CHECK)).toBe(false);
  });
});
