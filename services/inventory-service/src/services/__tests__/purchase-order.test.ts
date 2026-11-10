/**
 * Заказы поставщикам: создание, правила статусов, накладная по заказу,
 * запись полученного при приёмке.
 */
import { PurchaseOrderService, PurchaseOrderError, receiveFromInvoice } from '../purchase-order.service';
import { SupplierService } from '../supplier.service';

jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('pg', () => {
  const Pool = jest.fn().mockImplementation(() => ({ connect: jest.fn(), query: jest.fn(), end: jest.fn() }));
  return { __esModule: true, default: { Pool }, Pool };
});

const ENT = 'ent-1';

/** Клиент с журналом; handler отвечает строками по тексту запроса. */
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
  const s = new PurchaseOrderService('postgresql://test');
  (s as any).pool = { connect: jest.fn(async () => c), query: c.query };
  return s;
}
const words = (c: any) => c.log.map((q: any) => q.sql.trim().split(/\s+/)[0]);

describe('create', () => {
  it('номер из счётчика, склад по умолчанию — основной, позиции в той же транзакции', async () => {
    const c = client((sql) => {
      if (/FROM suppliers WHERE id/.test(sql)) return [{}];
      if (/FROM inventory_items WHERE id = ANY/.test(sql)) return [{ id: 'i1' }, { id: 'i2' }];
      if (/FROM warehouses WHERE enterprise_id/.test(sql)) return [{ id: 'wh-main' }];
      if (/next_purchase_order_number/.test(sql)) return [{ n: 'ЗК-2026-00003' }];
      if (/INSERT INTO purchase_orders/.test(sql)) return [{ id: 'po-1', order_number: 'ЗК-2026-00003' }];
      return [];
    });
    const po = await svcWith(c).create(ENT, 'u1', { supplierId: 'sup', items: [
      { inventoryItemId: 'i1', quantity: 5, pricePerUnit: 40 }, { inventoryItemId: 'i2', quantity: 2 }] });
    expect(po.order_number).toBe('ЗК-2026-00003');
    const ins = c.log.find((q) => /INSERT INTO purchase_orders/.test(q.sql))!;
    expect(ins.params.slice(0, 4)).toEqual([ENT, 'sup', 'wh-main', 'ЗК-2026-00003']);
    expect(c.log.filter((q) => /INSERT INTO purchase_order_items/.test(q.sql))).toHaveLength(2);
    expect(words(c)[0]).toBe('BEGIN');
    expect(words(c)).toContain('COMMIT');
  });

  it('чужой товар — отказ и откат', async () => {
    const c = client((sql) => /FROM inventory_items WHERE id = ANY/.test(sql) ? [{ id: 'i1' }] : []);
    await expect(svcWith(c).create(ENT, 'u1', { items: [{ inventoryItemId: 'i1', quantity: 1 }, { inventoryItemId: 'alien', quantity: 1 }] }))
      .rejects.toMatchObject({ status: 403 });
    expect(words(c)).toContain('ROLLBACK');
    expect(c.log.some((q) => /INSERT INTO purchase_orders/.test(q.sql))).toBe(false);
  });
});

describe('правила статусов', () => {
  const order = (over: any) => client((sql) => /FROM purchase_orders WHERE id = \$1 AND enterprise_id = \$2 FOR UPDATE/.test(sql)
    ? [{ id: 'po-1', status: 'draft', supplier_id: 'sup', order_number: 'ЗК-1', warehouse_id: 'wh', ...over }]
    : /COUNT\(\*\)::int AS n FROM purchase_order_items/.test(sql) ? [{ n: over.__items ?? 1 }] : [{ id: 'po-1' }]);

  it('отправить нельзя без поставщика и без позиций', async () => {
    await expect(svcWith(order({ supplier_id: null })).send('po-1', ENT)).rejects.toThrow('поставщика');
    await expect(svcWith(order({ __items: 0 })).send('po-1', ENT)).rejects.toThrow('нет позиций');
  });

  it('полученный заказ не меняется и не отменяется', async () => {
    await expect(svcWith(order({ status: 'received' })).setItem('po-1', ENT, { inventoryItemId: 'i1', quantity: 1 })).rejects.toThrow('в работе');
    await expect(svcWith(order({ status: 'received' })).cancel('po-1', ENT)).rejects.toThrow('закрыт');
  });

  it('чужой заказ — 404', async () => {
    const c = client(() => []);
    await expect(svcWith(c).send('po-x', ENT)).rejects.toMatchObject({ status: 404 });
  });
});

describe('накладная по заказу', () => {
  function setup(over: { draft?: any; rest?: any[] } = {}) {
    return client((sql) => {
      if (/FROM purchase_orders WHERE id = \$1 AND enterprise_id = \$2 FOR UPDATE/.test(sql))
        return [{ id: 'po-1', status: 'sent', supplier_id: 'sup', warehouse_id: 'wh', order_number: 'ЗК-2026-00003' }];
      if (/FROM supply_invoices WHERE purchase_order_id/.test(sql)) return over.draft ? [over.draft] : [];
      if (/FROM purchase_order_items i JOIN inventory_items/.test(sql)) return over.rest ?? [
        { inventory_item_id: 'i1', name: 'Мука', unit: 'кг', qty: '3', price: '40' }];
      if (/next_invoice_number/.test(sql)) return [{ n: 'ПР-2026-00010' }];
      if (/INSERT INTO supply_invoices/.test(sql)) return [{ id: 'inv-9' }];
      if (/UPDATE supply_invoices SET total_amount/.test(sql)) return [{ id: 'inv-9', invoice_number: 'ПР-2026-00010', total_amount: '120' }];
      return [];
    });
  }

  it('черновик накладной на остаток к получению по цене заказа, со ссылкой на заказ', async () => {
    const c = setup();
    const r = await svcWith(c).createInvoice('po-1', ENT);
    expect(r.existing).toBe(false);
    const inv = c.log.find((q) => /INSERT INTO supply_invoices/.test(q.sql))!;
    expect(inv.params).toEqual([ENT, 'wh', 'sup', 'ПР-2026-00010', 'po-1', 'По заказу ЗК-2026-00003']);
    const item = c.log.find((q) => /INSERT INTO supply_invoice_items/.test(q.sql))!;
    expect(item.params).toEqual(['inv-9', 'i1', 'Мука', 3, 'кг', 40, 120]);
  });

  it('уже есть непринятая накладная по заказу — вторую не создаём', async () => {
    const c = setup({ draft: { id: 'inv-1', status: 'draft' } });
    const r = await svcWith(c).createInvoice('po-1', ENT);
    expect(r).toEqual({ invoice: { id: 'inv-1', status: 'draft' }, existing: true });
    expect(c.log.some((q) => /INSERT INTO supply_invoices/.test(q.sql))).toBe(false);
  });

  it('всё уже получено — накладная не нужна', async () => {
    await expect(svcWith(setup({ rest: [] })).createInvoice('po-1', ENT)).rejects.toThrow('всё уже получено');
  });
});

describe('приёмка накладной по заказу', () => {
  it('полученное пишется в заказ, статус — из остатка', async () => {
    const c = client();
    await receiveFromInvoice(c, 'inv-9', 'po-1');
    expect(c.log[0].sql).toMatch(/SET received_quantity = poi\.received_quantity \+ x\.q/);
    expect(c.log[0].params).toEqual(['inv-9', 'po-1']);
    expect(c.log[1].sql).toMatch(/THEN 'received' ELSE 'partially_received'/);
    expect(c.log[1].sql).toMatch(/status <> 'cancelled'/);
  });

  it('confirmInvoice вызывает запись в заказ в своей транзакции', async () => {
    const c = client((sql) => {
      if (/FROM supply_invoices/.test(sql)) return [{ id: 'inv-9', enterprise_id: ENT, warehouse_id: 'wh', supplier_id: 'sup',
        status: 'draft', total_amount: '120', purchase_order_id: 'po-1', invoice_number: 'ПР-10' }];
      if (/FROM supply_invoice_items/.test(sql)) return [{ inventory_item_id: 'i1', name: 'Мука', quantity: '3', price_per_unit: '40' }];
      return [];
    });
    const s = new SupplierService('postgresql://test');
    (s as any).pool = { connect: jest.fn(async () => c), query: c.query };
    (s as any).createFinanceExpense = jest.fn();
    await s.confirmInvoice('inv-9', 'u1', { addStockMovement: jest.fn(async () => ({})) }, ENT);
    const i = c.log.findIndex((q) => /UPDATE purchase_order_items/.test(q.sql));
    expect(i).toBeGreaterThan(-1);
    expect(c.log.findIndex((q) => q.sql.trim() === 'COMMIT')).toBeGreaterThan(i);
  });
});

it('PurchaseOrderError несёт код ответа', () => {
  expect(new PurchaseOrderError('x', 409).status).toBe(409);
});
