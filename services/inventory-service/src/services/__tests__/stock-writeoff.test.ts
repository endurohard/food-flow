import { InventoryService } from '../inventory.service';

jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('pg', () => {
  const Pool = jest.fn().mockImplementation(() => ({ connect: jest.fn(), query: jest.fn(), end: jest.fn() }));
  return { __esModule: true, default: { Pool }, Pool };
});

const batch = (id: string, qty: number, cost: number, at: string) =>
  ({ id, quantity: String(qty), cost_price: String(cost), received_at: at });

/** Клиент: партии по FIFO (уважает ORDER BY из SQL), цена позиции, журнал запросов. */
function makeConn(batches: any[], itemCost = '50', stockAfter?: string) {
  const queries: { sql: string; params: any[] }[] = [];
  const conn: any = {
    queries,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      if (/FROM inventory_batches/.test(sql) && /SELECT/.test(sql)) {
        const desc = /ORDER BY received_at\s+DESC/i.test(sql);
        const rows = [...batches].sort((a, b) => (+new Date(a.received_at) - +new Date(b.received_at)) * (desc ? -1 : 1));
        return { rows, rowCount: rows.length };
      }
      if (/SELECT cost_price FROM inventory_items/.test(sql)) return { rows: [{ cost_price: itemCost }], rowCount: 1 };
      if (/INSERT INTO stock_movements/.test(sql)) return { rows: [{ id: 'm1' }], rowCount: 1 };
      if (/INSERT INTO inventory_stock/.test(sql) && stockAfter !== undefined) return { rows: [{ quantity: stockAfter }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn()
  };
  return conn;
}

const svcWith = (conn: any) => {
  const s = new InventoryService('postgresql://test');
  (s as any).pool = { connect: jest.fn(async () => conn), query: conn.query };
  return s;
};
const batchUpdates = (c: any) => c.queries.filter((q: any) => /UPDATE inventory_batches/.test(q.sql));

describe('consumeBatchesFIFO — без исключения при нехватке', () => {
  it('берёт со старой партии, затем со следующей; стоимость по ценам партий', async () => {
    const conn = makeConn([batch('new', 10, 300, '2026-10-02'), batch('old', 1, 100, '2026-10-01')]);
    const r = await svcWith(conn).consumeBatchesFIFO(conn, 'w', 'i', 1.5);
    expect(r).toEqual({ consumed: 1.5, cost: 1 * 100 + 0.5 * 300, uncovered: 0 });
    const u = batchUpdates(conn);
    expect(u[0].sql).toMatch(/is_depleted = true/);
    expect(u[0].params).toEqual(['old']);
    expect(u[1].params).toEqual([0.5, 'new']);
  });

  it('партий не хватает — списывает что есть и возвращает непокрытое, а не бросает', async () => {
    const conn = makeConn([batch('a', 0.2, 100, '2026-10-01')]);
    const r = await svcWith(conn).consumeBatchesFIFO(conn, 'w', 'i', 0.5);
    expect(r.consumed).toBeCloseTo(0.2);
    expect(r.uncovered).toBeCloseTo(0.3);
    expect(r.cost).toBeCloseTo(20);
  });
});

describe('addStockMovement — партии при ручном движении', () => {
  it('ручное списание уменьшает партии по FIFO и пишет себестоимость партии', async () => {
    const conn = makeConn([batch('a', 5, 120, '2026-10-01')]);
    await svcWith(conn).addStockMovement({ warehouseId: 'w', inventoryItemId: 'i', movementType: 'write_off', quantity: 2, enterpriseId: 'e' });
    expect(batchUpdates(conn)).toHaveLength(1);
    expect(batchUpdates(conn)[0].params).toEqual([2, 'a']);
    const mov = conn.queries.find((q: any) => /INSERT INTO stock_movements/.test(q.sql));
    expect(mov.params[5]).toBeCloseTo(120);
    const stock = conn.queries.find((q: any) => /INSERT INTO inventory_stock/.test(q.sql));
    expect(stock.params[2]).toBe(-2);
  });

  it('корректировка «минус» тоже снимает партии', async () => {
    const conn = makeConn([batch('a', 5, 120, '2026-10-01')]);
    await svcWith(conn).addStockMovement({ warehouseId: 'w', inventoryItemId: 'i', movementType: 'adjustment_minus', quantity: 1, enterpriseId: 'e' });
    expect(batchUpdates(conn)).toHaveLength(1);
  });

  it('приход партии не трогает, а создаёт новую', async () => {
    const conn = makeConn([batch('a', 5, 120, '2026-10-01')]);
    await svcWith(conn).addStockMovement({ warehouseId: 'w', inventoryItemId: 'i', movementType: 'receipt', quantity: 3, costPrice: 90, enterpriseId: 'e' });
    expect(batchUpdates(conn)).toHaveLength(0);
    const ins = conn.queries.find((q: any) => /INSERT INTO inventory_batches/.test(q.sql));
    expect(ins.params[4]).toBe(3);
    expect(ins.params[5]).toBe(90);
  });

  it('приход после ухода в минус: партия только на то, что осталось после покрытия минуса', async () => {
    // Было −0,4, пришло 1 → остаток 0,6; партия 0,6, а не 1 (0,4 уже продано)
    const conn = makeConn([], '50', '0.600');
    await svcWith(conn).addStockMovement({ warehouseId: 'w', inventoryItemId: 'i', movementType: 'receipt', quantity: 1, costPrice: 90, enterpriseId: 'e' });
    const ins = conn.queries.find((q: any) => /INSERT INTO inventory_batches/.test(q.sql));
    expect(ins.params[4]).toBeCloseTo(0.6);
  });

  it('приход меньше минуса — партия не создаётся вовсе', async () => {
    const conn = makeConn([], '50', '-0.200');
    await svcWith(conn).addStockMovement({ warehouseId: 'w', inventoryItemId: 'i', movementType: 'receipt', quantity: 0.3, costPrice: 90, enterpriseId: 'e' });
    expect(conn.queries.some((q: any) => /INSERT INTO inventory_batches/.test(q.sql))).toBe(false);
  });

  it('корректировка «плюс» создаёт партию по последней цене позиции — остаток и партии сходятся', async () => {
    const conn = makeConn([], '77');
    await svcWith(conn).addStockMovement({ warehouseId: 'w', inventoryItemId: 'i', movementType: 'adjustment_plus', quantity: 4, enterpriseId: 'e' });
    const ins = conn.queries.find((q: any) => /INSERT INTO inventory_batches/.test(q.sql));
    expect(ins).toBeTruthy();
    expect(ins.params[4]).toBe(4);
    expect(ins.params[5]).toBe(77);
  });
});
