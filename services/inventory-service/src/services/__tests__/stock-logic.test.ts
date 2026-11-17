/**
 * Логика склада и закупки: FIFO без цены, перемещение партий со сроком и
 * сортом, распределение оплат поставщику по накладным, цена партии из
 * накладной.
 */
import { InventoryService } from '../inventory.service';
import { SupplierService, allocateSupplierPayments } from '../supplier.service';

jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('pg', () => {
  const Pool = jest.fn().mockImplementation(() => ({ connect: jest.fn(), query: jest.fn(), end: jest.fn() }));
  return { __esModule: true, default: { Pool }, Pool };
});

function conn(handler: (sql: string, params: any[]) => any[] | undefined) {
  const log: { sql: string; params: any[] }[] = [];
  return {
    log,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      log.push({ sql, params });
      const rows = handler(sql, params) || [];
      return { rows, rowCount: rows.length };
    }),
    release: jest.fn()
  };
}
const inv = (c: any) => { const s = new InventoryService('x'); (s as any).pool = { connect: async () => c, query: c.query }; return s; };

describe('FIFO', () => {
  it('партия без цены считается по последней цене товара, а не по 0 ₽', async () => {
    const c = conn((sql) => {
      if (/FROM inventory_batches/.test(sql)) return [
        { id: 'b1', quantity: '1', cost_price: '100', received_at: 1 },
        { id: 'b2', quantity: '5', cost_price: null, received_at: 2 }];
      if (/SELECT cost_price FROM inventory_items/.test(sql)) return [{ cost_price: '80' }];
    });
    const r = await inv(c).consumeBatchesFIFO(c, 'w', 'i', 3);
    expect(r.cost).toBeCloseTo(100 + 2 * 80, 6);
    expect(r.parts.map((p) => [p.take, p.costPrice])).toEqual([[1, 100], [2, 80]]);
  });
});

describe('перемещение', () => {
  const exp = new Date(2026, 10, 20);
  const handler = (stockTo: string) => (sql: string) => {
    if (/FROM warehouses WHERE id = ANY/.test(sql)) return [{ id: 'a' }, { id: 'b' }];
    if (/SELECT quantity FROM inventory_stock/.test(sql)) return [{ quantity: '10' }];
    if (/FROM inventory_batches/.test(sql) && /SELECT/.test(sql)) return [
      { id: 'old', quantity: '1', cost_price: '90', expiry_date: exp, variety: 'Колумбия', supplier_id: 's', invoice_id: 'inv', received_at: 't1', batch_number: 'N1' },
      { id: 'new', quantity: '5', cost_price: '110', expiry_date: null, variety: null, supplier_id: 's', invoice_id: 'inv2', received_at: 't2', batch_number: null }];
    if (/UPDATE inventory_stock SET quantity = quantity - /.test(sql)) return [{ quantity: '7' }];
    if (/INSERT INTO inventory_stock/.test(sql)) return [{ quantity: stockTo }];
  };
  const batches = (c: any) => c.log.filter((q: any) => /INSERT INTO inventory_batches/.test(q.sql)).map((q: any) => q.params);

  it('партии переезжают со сроком, сортом, поставщиком и датой поступления', async () => {
    const c = conn(handler('3'));
    await inv(c).transfer({ fromWarehouseId: 'a', toWarehouseId: 'b', inventoryItemId: 'i', quantity: 3, enterpriseId: 'e' });
    expect(batches(c)).toEqual([
      ['i', 'b', 'e', 'N1', 1, 90, exp, 's', 'inv', 'Колумбия', 't1'],
      ['i', 'b', 'e', null, 2, 110, null, 's', 'inv2', null, 't2']]);
  });

  it('минус на складе-получателе закрывается самыми старыми частями', async () => {
    const c = conn(handler('1.5'));   // было −1,5 → стало 1,5
    await inv(c).transfer({ fromWarehouseId: 'a', toWarehouseId: 'b', inventoryItemId: 'i', quantity: 3, enterpriseId: 'e' });
    expect(batches(c).map((p: any) => [p[4], p[5]])).toEqual([[1.5, 110]]);
  });
});

describe('оплата поставщику «в счёт долга»', () => {
  it('гасит старые накладные строками с привязкой, остаток — предоплата', async () => {
    const c = conn((sql) => {
      if (/invoice_id IS NULL AND amount > 0/.test(sql)) return [{ id: 'p1', enterprise_id: 'e', supplier_id: 's', amount: '1500', method: 'transfer', paid_by: 'u', notes: null, created_at: 't' }];
      if (/FROM supply_invoices\s+WHERE supplier_id = \$1 AND status = 'received'/.test(sql)) return [{ id: 'i1', total_amount: '1000' }, { id: 'i2', total_amount: '300' }];
      if (/GROUP BY invoice_id/.test(sql)) return [{ invoice_id: 'i1', s: '200' }];
    });
    await allocateSupplierPayments(c, 's');
    const upd = c.log.find((q) => /UPDATE supplier_payments SET invoice_id/.test(q.sql))!;
    expect(upd.params).toEqual(['p1', 'i1', 800]);
    const ins = c.log.filter((q) => /INSERT INTO supplier_payments/.test(q.sql)).map((q) => [q.params[2], q.params[3] ?? q.params[2]]);
    expect(ins[0]).toEqual(['i2', 300]);
    expect(c.log.filter((q) => /INSERT INTO supplier_payments/.test(q.sql))[1].params.slice(1, 3)).toEqual(['s', 400]);
  });

  it('нечего гасить — оплата остаётся предоплатой', async () => {
    const c = conn((sql) => {
      if (/invoice_id IS NULL AND amount > 0/.test(sql)) return [{ id: 'p1', amount: '500' }];
      if (/status = 'received'/.test(sql)) return [];
    });
    await allocateSupplierPayments(c, 's');
    expect(c.log.some((q) => /UPDATE supplier_payments|INSERT INTO supplier_payments/.test(q.sql))).toBe(false);
  });
});

describe('приёмка накладной', () => {
  function setup(items: any[]) {
    const c = conn((sql) => {
      if (/FROM supply_invoices WHERE/.test(sql)) return [{ id: 'inv', enterprise_id: 'e', warehouse_id: 'w', supplier_id: null, status: 'draft', total_amount: '398', invoice_number: 'ПР-1' }];
      if (/FROM supply_invoice_items/.test(sql)) return items;
    });
    const s = new SupplierService('x');
    (s as any).pool = { connect: async () => c, query: c.query };
    (s as any).createFinanceExpense = jest.fn();
    return { s, c };
  }

  it('цена партии — сумма строки / количество, без округления до копеек', async () => {
    const { s } = setup([{ inventory_item_id: 'i', name: 'Сироп', quantity: '24', price_per_unit: '16.58', total_price: '398' }]);
    const add = jest.fn(async () => ({}));
    await s.confirmInvoice('inv', 'u', { addStockMovement: add }, 'e');
    expect((add.mock.calls[0] as any)[0].costPrice).toBeCloseTo(398 / 24, 4);
  });

  it('позиция без цены — отказ до проводок; цена 0 — можно', async () => {
    const { s, c } = setup([{ inventory_item_id: 'i', name: 'Сироп', quantity: '2', price_per_unit: null, total_price: null }]);
    await expect(s.confirmInvoice('inv', 'u', { addStockMovement: jest.fn() }, 'e')).rejects.toThrow('не указана цена');
    expect(c.log.some((q) => q.sql.trim() === 'ROLLBACK')).toBe(true);
    const ok = setup([{ inventory_item_id: 'i', name: 'Подарок', quantity: '2', price_per_unit: '0', total_price: '0' }]);
    const add = jest.fn(async () => ({}));
    await ok.s.confirmInvoice('inv', 'u', { addStockMovement: add }, 'e');
    expect((add.mock.calls[0] as any)[0].costPrice).toBe(0);
  });
});
