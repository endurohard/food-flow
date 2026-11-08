import { InventoryService } from '../inventory.service';

jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('pg', () => {
  const Pool = jest.fn().mockImplementation(() => ({ connect: jest.fn(), query: jest.fn(), end: jest.fn() }));
  return { __esModule: true, default: { Pool }, Pool };
});

function makeConn(o: { sales?: any[]; back?: any[]; lines?: any[]; done?: boolean; stock?: string; warehouses?: number }) {
  const queries: { sql: string; params: any[] }[] = [];
  const conn: any = {
    queries,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      if (/FROM orders WHERE id = \$1 AND enterprise_id/.test(sql)) return { rows: [{ id: 'o1', order_number: 'POS-1' }] };
      if (/notes LIKE \$2/.test(sql)) return { rows: o.done ? [{}] : [], rowCount: o.done ? 1 : 0 };
      if (/FROM order_items WHERE order_id/.test(sql)) return { rows: o.lines || [] };
      if (/movement_type = 'sale'\s+GROUP BY/.test(sql)) return { rows: o.sales || [] };
      if (/reference_type = 'order_return' AND reference_id = \$1\s+GROUP BY/.test(sql)) return { rows: o.back || [] };
      if (/FROM warehouses WHERE id = ANY/.test(sql)) return { rows: [], rowCount: o.warehouses ?? 2 };
      if (/SELECT quantity FROM inventory_stock/.test(sql)) return { rows: o.stock !== undefined ? [{ quantity: o.stock }] : [] };
      if (/FROM inventory_batches/.test(sql) && /SELECT/.test(sql)) return { rows: [{ id: 'b1', quantity: '10', cost_price: '100' }] };
      if (/RETURNING quantity/.test(sql)) return { rows: [{ quantity: '5' }] };
      return { rows: [], rowCount: 1 };
    }),
    release: jest.fn(),
  };
  return conn;
}
const svc = (conn: any) => { const s = new InventoryService('x'); (s as any).pool = { connect: async () => conn, query: conn.query }; return s; };
const returns = (c: any) => c.queries.filter((q: any) => /INSERT INTO stock_movements/.test(q.sql) && /'return'/.test(q.sql));

describe('returnByOrder', () => {
  const lines = [{ id: 'l1', quantity: 2 }, { id: 'l2', quantity: 1 }];
  const sales = [
    { warehouse_id: 'w', inventory_item_id: 'bean', order_item_id: 'l1', qty: '0.018', cost: '1000' },
    { warehouse_id: 'w', inventory_item_id: 'milk', order_item_id: 'l1', qty: '0.300', cost: '80' },
    { warehouse_id: 'w', inventory_item_id: 'cake', order_item_id: 'l2', qty: '1', cost: '150' },
  ];

  it('возвращает ровно расход строки пропорционально штукам и по той же себестоимости', async () => {
    const c = makeConn({ lines, sales });
    const r = await svc(c).returnByOrder({ orderId: 'o1', refundId: 'rf', enterpriseId: 'e', items: [{ orderItemId: 'l1', quantity: 1 }] });
    expect(r.returned).toEqual([{ inventoryItemId: 'bean', quantity: 0.009 }, { inventoryItemId: 'milk', quantity: 0.15 }]);
    const mv = returns(c);
    expect(mv).toHaveLength(2);
    expect(mv[0].params[4]).toBe(1000);   // себестоимость как при продаже
    expect(mv[0].params[7]).toContain('[возврат rf]');
    expect(mv[0].params[8]).toBe('l1');
  });

  it('уже возвращённое второй раз не возвращается', async () => {
    const c = makeConn({ lines, sales, back: [{ warehouse_id: 'w', inventory_item_id: 'cake', order_item_id: 'l2', qty: '1' }] });
    const r = await svc(c).returnByOrder({ orderId: 'o1', refundId: 'rf2', enterpriseId: 'e', items: [{ orderItemId: 'l2', quantity: 1 }] });
    expect(r.returned).toEqual([]);
  });

  it('повтор с тем же refundId ничего не делает', async () => {
    const c = makeConn({ lines, sales, done: true });
    const r = await svc(c).returnByOrder({ orderId: 'o1', refundId: 'rf', enterpriseId: 'e', items: [{ orderItemId: 'l1', quantity: 1 }] });
    expect(r).toEqual({ returned: [], replayed: true });
    expect(returns(c)).toHaveLength(0);
  });

  it('старые списания без привязки к строке — пропорционально всему чеку', async () => {
    const c = makeConn({ lines, sales: [{ warehouse_id: 'w', inventory_item_id: 'bean', order_item_id: null, qty: '0.030', cost: '1000' }] });
    const r = await svc(c).returnByOrder({ orderId: 'o1', refundId: 'rf3', enterpriseId: 'e', items: [{ orderItemId: 'l2', quantity: 1 }] });
    expect(r.returned).toEqual([{ inventoryItemId: 'bean', quantity: 0.01 }]);   // 1 из 3 штук чека
  });
});

describe('transfer', () => {
  const base = { fromWarehouseId: 'a', toWarehouseId: 'b', inventoryItemId: 'i', quantity: 2, enterpriseId: 'e' };
  it('с исходного склада по FIFO, на целевой — партией по той же цене; два движения с одним id', async () => {
    const c = makeConn({ stock: '5' });
    const r = await svc(c).transfer(base);
    expect(r.costPrice).toBe(100);
    const mv = c.queries.filter((q: any) => /INSERT INTO stock_movements/.test(q.sql));
    expect(mv.map((q: any) => q.sql.match(/'(transfer|transfer_in)'/)[1])).toEqual(['transfer', 'transfer_in']);
    expect(mv[0].params[5]).toBe(mv[1].params[5]);
    const batch = c.queries.find((q: any) => /INSERT INTO inventory_batches/.test(q.sql));
    expect(batch.params).toEqual(['i', 'b', 'e', 2, 100]);
  });
  it('больше, чем есть на складе отправки, — отказ без движений', async () => {
    const c = makeConn({ stock: '1' });
    await expect(svc(c).transfer(base)).rejects.toThrow(/TRANSFER_INSUFFICIENT/);
    expect(c.queries.some((q: any) => /INSERT INTO stock_movements/.test(q.sql))).toBe(false);
  });
  it('склад чужого предприятия — отказ', async () => {
    const c = makeConn({ stock: '5', warehouses: 1 });
    await expect(svc(c).transfer(base)).rejects.toThrow('TRANSFER_WAREHOUSE_NOT_FOUND');
  });
  it('тот же склад — отказ', async () => {
    await expect(svc(makeConn({})).transfer({ ...base, toWarehouseId: 'a' })).rejects.toThrow('TRANSFER_SAME_WAREHOUSE');
  });
});
