/**
 * Инвентаризация: создание по товарам предприятия, ввод факта только в
 * черновик, проведение от остатка на момент проведения, суммы расхождений.
 */
import { InventoryCountService } from '../inventory-count.service';

jest.mock('pg', () => {
  const Pool = jest.fn().mockImplementation(() => ({ connect: jest.fn(), query: jest.fn(), end: jest.fn() }));
  return { __esModule: true, default: { Pool }, Pool };
});

const ENT = 'ent-1';
function client(handler: (sql: string, params: any[]) => any[] = () => []) {
  const log: { sql: string; params: any[] }[] = [];
  return {
    log,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      log.push({ sql, params });
      const rows = handler(sql, params);
      return { rows, rowCount: rows.length };
    }),
    release: jest.fn()
  };
}
function svcWith(c: any) {
  const s = new InventoryCountService('postgresql://test');
  (s as any).pool = { connect: jest.fn(async () => c), query: c.query };
  return s;
}
const words = (c: any) => c.log.map((q: any) => q.sql.trim().split(/\s+/)[0]);

describe('create', () => {
  it('номер, строки на все живые товары предприятия', async () => {
    const c = client((sql) => {
      if (/FROM warehouses WHERE id/.test(sql)) return [{}];
      if (/next_inventory_count_number/.test(sql)) return [{ n: 'ИН-2026-00001' }];
      if (/INSERT INTO inventory_counts/.test(sql)) return [{ id: 'cnt', count_number: 'ИН-2026-00001' }];
      if (/INSERT INTO inventory_count_items/.test(sql)) return [{}, {}, {}];
      return [];
    });
    const r = await svcWith(c).create(ENT, 'u1', { warehouseId: 'wh' });
    expect(r.count_number).toBe('ИН-2026-00001');
    const rows = c.log.find((q) => /INSERT INTO inventory_count_items/.test(q.sql))!;
    expect(rows.sql).toMatch(/deleted_at IS NULL/);
    expect(rows.params).toEqual(['cnt', ENT, null]);
  });

  it('чужой склад — 404, ничего не создано', async () => {
    const c = client(() => []);
    await expect(svcWith(c).create(ENT, 'u1', { warehouseId: 'alien' })).rejects.toMatchObject({ status: 404 });
    expect(c.log.some((q) => /INSERT INTO inventory_counts/.test(q.sql))).toBe(false);
    expect(words(c)).toContain('ROLLBACK');
  });
});

describe('saveCounts', () => {
  it('проведённый документ не меняется', async () => {
    const c = client((sql) => /FROM inventory_counts WHERE id/.test(sql) ? [{ id: 'cnt', status: 'posted' }] : []);
    await expect(svcWith(c).saveCounts('cnt', ENT, [{ inventoryItemId: 'i1', countedQty: 1 }])).rejects.toMatchObject({ status: 409 });
  });

  it('чужой товар — отказ', async () => {
    const c = client((sql) => /FROM inventory_counts WHERE id/.test(sql) ? [{ id: 'cnt', status: 'draft' }] : []);
    await expect(svcWith(c).saveCounts('cnt', ENT, [{ inventoryItemId: 'alien', countedQty: 1 }])).rejects.toMatchObject({ status: 404 });
  });

  it('факт и «не посчитано» (null) пишутся upsert-ом', async () => {
    const c = client((sql) => {
      if (/FROM inventory_counts WHERE id/.test(sql)) return [{ id: 'cnt', status: 'draft' }];
      if (/FROM inventory_items WHERE id = ANY/.test(sql)) return [{ id: 'i1' }, { id: 'i2' }];
      return [];
    });
    await svcWith(c).saveCounts('cnt', ENT, [{ inventoryItemId: 'i1', countedQty: 2.3456 }, { inventoryItemId: 'i2', countedQty: null }]);
    const ups = c.log.filter((q) => /INSERT INTO inventory_count_items/.test(q.sql));
    expect(ups.map((q) => q.params)).toEqual([['cnt', 'i1', 2.346], ['cnt', 'i2', null]]);
  });
});

describe('post', () => {
  function setup(stock: Record<string, number>, rows: any[], cost = 50) {
    return client((sql, p) => {
      if (/FROM inventory_counts WHERE id/.test(sql)) return [{ id: 'cnt', status: 'draft', warehouse_id: 'wh', count_number: 'ИН-1' }];
      if (/counted_qty IS NOT NULL ORDER BY/.test(sql)) return rows;
      if (/FROM inventory_stock WHERE warehouse_id/.test(sql)) return p[1] in stock ? [{ quantity: String(stock[p[1]]) }] : [];
      if (/AS cost/.test(sql)) return [{ cost: String(cost) }];
      if (/UPDATE inventory_counts SET status = 'posted'/.test(sql)) return [{ id: 'cnt', status: 'posted', shortage_value: p[2], surplus_value: p[3] }];
      return [];
    });
  }

  it('недостача — «минус» по FIFO, излишек — «плюс» по цене, совпало — без движения', async () => {
    const c = setup({ i1: 10, i2: 4, i3: 7 }, [
      { id: 'r1', inventory_item_id: 'i1', counted_qty: '8' },     // −2
      { id: 'r2', inventory_item_id: 'i2', counted_qty: '5.5' },   // +1,5
      { id: 'r3', inventory_item_id: 'i3', counted_qty: '7' }      // 0
    ]);
    const writer = { addStockMovement: jest.fn(async (d: any) => (d.movementType === 'adjustment_minus' ? { cost_price: '45' } : {})) };
    const r = await svcWith(c).post('cnt', ENT, 'u1', writer);
    expect(writer.addStockMovement).toHaveBeenCalledTimes(2);
    const [minus, plus] = writer.addStockMovement.mock.calls.map((x: any) => x[0]);
    expect(minus).toMatchObject({ movementType: 'adjustment_minus', quantity: 2, costPrice: undefined, referenceType: 'inventory_count', referenceId: 'cnt' });
    expect(plus).toMatchObject({ movementType: 'adjustment_plus', quantity: 1.5, costPrice: 50 });
    // движения — в той же транзакции
    expect(writer.addStockMovement.mock.calls[0][1]).toBe(c);
    const upd = c.log.filter((q) => /UPDATE inventory_count_items SET expected_qty/.test(q.sql)).map((q) => q.params);
    expect(upd).toEqual([['r1', 10, -2, 45, -90], ['r2', 4, 1.5, 50, 75], ['r3', 7, 0, 50, 0]]);
    expect(r).toMatchObject({ status: 'posted', shortage_value: 90, surplus_value: 75, adjusted: 2, counted: 3 });
  });

  it('товара не было на складе — расхождение от нуля', async () => {
    const c = setup({}, [{ id: 'r1', inventory_item_id: 'i9', counted_qty: '3' }]);
    const writer = { addStockMovement: jest.fn(async () => ({})) };
    await svcWith(c).post('cnt', ENT, 'u1', writer);
    expect(writer.addStockMovement.mock.calls[0][0]).toMatchObject({ movementType: 'adjustment_plus', quantity: 3 });
  });

  it('ничего не посчитано — отказ; «непосчитанные = 0» обнуляет пустые строки', async () => {
    await expect(svcWith(setup({}, [])).post('cnt', ENT, 'u1', { addStockMovement: jest.fn() })).rejects.toThrow('проводить нечего');
    const c = setup({ i1: 2 }, [{ id: 'r1', inventory_item_id: 'i1', counted_qty: '0' }]);
    await svcWith(c).post('cnt', ENT, 'u1', { addStockMovement: jest.fn(async () => ({})) }, { zeroUncounted: true });
    expect(c.log.some((q) => /SET counted_qty = 0/.test(q.sql))).toBe(true);
  });

  it('ошибка движения — откат всего документа', async () => {
    const c = setup({ i1: 10 }, [{ id: 'r1', inventory_item_id: 'i1', counted_qty: '1' }]);
    const writer = { addStockMovement: jest.fn(async () => { throw new Error('boom'); }) };
    await expect(svcWith(c).post('cnt', ENT, 'u1', writer)).rejects.toThrow('boom');
    expect(words(c)).toContain('ROLLBACK');
    expect(c.log.some((q) => /SET status = 'posted'/.test(q.sql))).toBe(false);
  });
});
