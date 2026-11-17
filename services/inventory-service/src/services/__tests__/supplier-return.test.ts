/**
 * Возврат поставщику: проверки до проводок, партии этой накладной первыми,
 * точная сумма при возврате всей строки, долг уменьшается.
 */
import { SupplierReturnService } from '../supplier-return.service';
import { allocateSupplierPayments } from '../supplier.service';

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

const INV = { id: 'inv', enterprise_id: 'e', warehouse_id: 'w', supplier_id: 's', status: 'received', invoice_number: 'ПР-7', total_amount: '1000', paid_amount: '0', returned_amount: '0' };
const LINE = { id: 'l1', invoice_id: 'inv', inventory_item_id: 'i', name: 'Молоко', unit: 'л', quantity: '3', price_per_unit: '33.33', total_price: '100' };

function setup(opts: { inv?: any; prev?: any[]; stock?: string; batches?: any[] } = {}) {
  const c = conn((sql) => {
    if (/FROM supply_invoices WHERE id = \$1 AND enterprise_id = \$2 FOR UPDATE/.test(sql)) return [opts.inv || INV];
    if (/FROM supply_invoice_items WHERE invoice_id/.test(sql)) return [LINE];
    if (/SUM\(ri\.quantity\) AS q, SUM\(ri\.total\)/.test(sql)) return opts.prev || [];
    if (/SELECT quantity FROM inventory_stock/.test(sql)) return [{ quantity: opts.stock ?? '10' }];
    if (/next_supplier_return_number/.test(sql)) return [{ n: 'ВЗ-2026-00001' }];
    if (/INSERT INTO supplier_returns/.test(sql)) return [{ id: 'r1', return_number: 'ВЗ-2026-00001' }];
    if (/FROM inventory_batches/.test(sql)) return opts.batches || [{ id: 'b1', quantity: '3', cost_price: '30' }];
  });
  const s = new SupplierReturnService('x');
  (s as any).pool = { connect: async () => c, query: c.query };
  return { s, c };
}
const has = (c: any, re: RegExp) => c.log.some((q: any) => re.test(q.sql));

describe('возврат поставщику', () => {
  it('часть строки: склад, движение, долг по накладной и поставщику', async () => {
    const { s, c } = setup();
    await s.create('inv', 'e', 'u', { items: [{ invoiceItemId: 'l1', quantity: 1 }], reason: 'defect' });
    const mv = c.log.find((q) => /INSERT INTO stock_movements/.test(q.sql))!;
    expect(mv.params.slice(0, 4)).toEqual(['e', 'w', 'i', 1]);
    expect(mv.params[7]).toMatch(/ВЗ-2026-00001.*ПР-7.*брак/);
    const ret = c.log.find((q) => /INSERT INTO supplier_returns/.test(q.sql))!;
    expect(ret.params[5]).toBeCloseTo(33.33, 2);
    expect(c.log.find((q) => /UPDATE supply_invoices SET returned_amount/.test(q.sql))!.params).toEqual(['inv', 33.33]);
    expect(c.log.find((q) => /UPDATE suppliers SET balance = balance - /.test(q.sql))!.params).toEqual([33.33, 's']);
    expect(has(c, /^COMMIT$/)).toBe(true);
  });

  it('вся строка после частичного возврата — ровно остаток суммы, без копеечного хвоста', async () => {
    const { s, c } = setup({ prev: [{ invoice_item_id: 'l1', q: '1', t: '33.33' }] });
    await s.create('inv', 'e', 'u', { items: [{ invoiceItemId: 'l1', quantity: 2 }] });
    expect(c.log.find((q) => /INSERT INTO supplier_returns/.test(q.sql))!.params[5]).toBe(66.67);
  });

  it('больше принятого — отказ до проводок', async () => {
    const { s, c } = setup({ prev: [{ invoice_item_id: 'l1', q: '2.5', t: '83' }] });
    await expect(s.create('inv', 'e', 'u', { items: [{ invoiceItemId: 'l1', quantity: 1 }] })).rejects.toThrow('не больше 0,5');
    expect(has(c, /INSERT INTO|UPDATE inventory/)).toBe(false);
    expect(has(c, /^ROLLBACK$/)).toBe(true);
  });

  it('товара на складе меньше — отказ', async () => {
    const { s, c } = setup({ stock: '0.5' });
    await expect(s.create('inv', 'e', 'u', { items: [{ invoiceItemId: 'l1', quantity: 1 }] })).rejects.toThrow('на складе только 0,5');
    expect(has(c, /INSERT INTO/)).toBe(false);
  });

  it('по черновику нельзя', async () => {
    const { s } = setup({ inv: { ...INV, status: 'draft' } });
    await expect(s.create('inv', 'e', 'u', { items: [{ invoiceItemId: 'l1', quantity: 1 }] })).rejects.toThrow('только по принятой');
  });

  it('партии этой накладной списываются первыми', async () => {
    const { s, c } = setup({ batches: [{ id: 'mine', quantity: '0.4', cost_price: '30' }, { id: 'old', quantity: '5', cost_price: '20' }] });
    await s.create('inv', 'e', 'u', { items: [{ invoiceItemId: 'l1', quantity: 1 }] });
    const sel = c.log.find((q) => /FROM inventory_batches/.test(q.sql))!;
    expect(sel.sql).toMatch(/invoice_id IS NOT DISTINCT FROM \$3::uuid\) DESC/);
    expect(sel.params[2]).toBe('inv');
    const item = c.log.find((q) => /INSERT INTO supplier_return_items/.test(q.sql))!;
    expect(item.params[7]).toBeCloseTo(0.4 * 30 + 0.6 * 20, 2);
  });
});

describe('оплата «в счёт долга» после возврата', () => {
  it('гасит накладную только на сумму за вычетом возврата', async () => {
    const c = conn((sql) => {
      if (/invoice_id IS NULL AND amount > 0/.test(sql)) return [{ id: 'p1', enterprise_id: 'e', supplier_id: 's', amount: '1000', method: 'cash', created_at: 't' }];
      if (/status = 'received'/.test(sql)) return [{ id: 'i1', total_amount: '1000', returned_amount: '300' }];
    });
    await allocateSupplierPayments(c, 's');
    expect(c.log.find((q) => /UPDATE supplier_payments SET invoice_id/.test(q.sql))!.params).toEqual(['p1', 'i1', 700]);
    expect(c.log.filter((q) => /INSERT INTO supplier_payments/.test(q.sql))[0].params.slice(1, 3)).toEqual(['s', 300]);
  });
});
