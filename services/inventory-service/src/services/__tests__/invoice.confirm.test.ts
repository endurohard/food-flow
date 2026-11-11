/**
 * Приёмка накладной — одна транзакция.
 *
 * Зачем. Раньше каждая позиция проводилась отдельной транзакцией внутри
 * addStockMovement, а статус накладной — своей. Сбой на третьей позиции
 * оставлял первые две на складе при накладной-черновике, и повторное
 * «Принять» оприходовало их второй раз. Здесь проверяется, что движения идут
 * через соединение приёмки и откатываются вместе с ней, что партия получает
 * поставщика и накладную, и что позиция без товара не пропадает молча.
 */
import { SupplierService, InvoiceError } from '../supplier.service';
import { InventoryService } from '../inventory.service';

jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('pg', () => {
  const Pool = jest.fn().mockImplementation(() => ({ connect: jest.fn(), query: jest.fn(), end: jest.fn() }));
  return { __esModule: true, default: { Pool }, Pool };
});

const INVOICE = { id: 'inv-1', enterprise_id: 'e', warehouse_id: 'w', supplier_id: 's-1', invoice_number: 'ПН-7', total_amount: '300', status: 'draft' };

function makeClient(items: any[], invoice: any = INVOICE) {
  const log: string[] = [];
  const client: any = {
    log,
    query: jest.fn(async (sql: string) => {
      log.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
      if (/FROM supply_invoices/.test(sql)) return { rows: [invoice], rowCount: 1 };
      if (/FROM supply_invoice_items/.test(sql)) return { rows: items, rowCount: items.length };
      return { rows: [], rowCount: 1 };
    }),
    release: jest.fn()
  };
  return client;
}

function supplierWith(client: any) {
  const s = new SupplierService('postgresql://test');
  (s as any).pool = { connect: jest.fn(async () => client), query: client.query };
  (s as any).createFinanceExpense = jest.fn(async () => undefined);
  return s;
}

const item = (id: string, extra: any = {}) =>
  ({ id, inventory_item_id: 'item-' + id, name: 'Товар ' + id, quantity: '2', price_per_unit: '50', ...extra });

describe('confirmInvoice: одна транзакция на всю накладную', () => {
  it('движения идут через соединение приёмки, партия знает поставщика и накладную', async () => {
    const client = makeClient([item('a'), item('b')]);
    const inv = { addStockMovement: jest.fn(async () => ({ id: 'm' })) };
    await supplierWith(client).confirmInvoice('inv-1', 'user-1', inv, 'e');

    expect(inv.addStockMovement).toHaveBeenCalledTimes(2);
    for (const call of inv.addStockMovement.mock.calls as any[]) {
      expect(call[1]).toBe(client);                       // та же транзакция
      expect(call[0]).toMatchObject({ supplierId: 's-1', invoiceId: 'inv-1', movementType: 'receipt', costPrice: 50 });
    }
    expect(client.log.filter((q: string) => q === 'BEGIN')).toHaveLength(1);
    expect(client.log.filter((q: string) => q === 'COMMIT')).toHaveLength(1);
  });

  it('сбой на второй позиции откатывает всё: ни статуса, ни долга, ни первой позиции', async () => {
    const client = makeClient([item('a'), item('b')]);
    const inv = { addStockMovement: jest.fn()
      .mockResolvedValueOnce({ id: 'm1' })
      .mockRejectedValueOnce(new Error('boom')) };
    await expect(supplierWith(client).confirmInvoice('inv-1', 'u', inv, 'e')).rejects.toThrow('boom');
    expect(client.log).toContain('ROLLBACK');
    expect(client.log).not.toContain('COMMIT');
    expect(client.log.some((q: string) => /^UPDATE supply_invoices/.test(q))).toBe(false);
    expect(client.log.some((q: string) => /^UPDATE suppliers/.test(q))).toBe(false);
  });

  it('позиция без товара из справочника останавливает приёмку до проводок', async () => {
    const client = makeClient([item('a'), item('b', { inventory_item_id: null, name: 'Укроп' })]);
    const inv = { addStockMovement: jest.fn() };
    const p = supplierWith(client).confirmInvoice('inv-1', 'u', inv, 'e');
    await expect(p).rejects.toBeInstanceOf(InvoiceError);
    await expect(supplierWith(makeClient([item('b', { inventory_item_id: null, name: 'Укроп' })])).confirmInvoice('inv-1', 'u', inv, 'e'))
      .rejects.toThrow(/Укроп/);
    expect(inv.addStockMovement).not.toHaveBeenCalled();
  });

  it('пустая накладная и накладная без склада не принимаются', async () => {
    const inv = { addStockMovement: jest.fn() };
    await expect(supplierWith(makeClient([])).confirmInvoice('inv-1', 'u', inv, 'e')).rejects.toThrow('нет позиций');
    await expect(supplierWith(makeClient([item('a')], { ...INVOICE, warehouse_id: null })).confirmInvoice('inv-1', 'u', inv, 'e'))
      .rejects.toThrow('склад');
  });
});

describe('addStockMovement внутри чужой транзакции', () => {
  function conn() {
    const log: string[] = [];
    return {
      log,
      query: jest.fn(async (sql: string) => {
        log.push(sql.trim().split(/\s+/)[0]);
        if (/INSERT INTO stock_movements/.test(sql)) return { rows: [{ id: 'm1' }], rowCount: 1 };
        if (/INSERT INTO inventory_stock/.test(sql)) return { rows: [{ quantity: '5' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
      release: jest.fn()
    };
  }

  it('с переданным соединением не открывает и не закрывает транзакцию', async () => {
    const c = conn();
    const svc = new InventoryService('postgresql://test');
    (svc as any).pool = { connect: jest.fn() };
    await svc.addStockMovement({ warehouseId: 'w', inventoryItemId: 'i', movementType: 'receipt', quantity: 5, costPrice: 10,
      supplierId: 's-1', invoiceId: 'inv-1' }, c);
    expect(c.log).not.toContain('BEGIN');
    expect(c.log).not.toContain('COMMIT');
    expect(c.release).not.toHaveBeenCalled();
    expect((svc as any).pool.connect).not.toHaveBeenCalled();
    // партия получила поставщика и накладную
    const batchInsert = (c.query.mock.calls as any[]).find(([sql]) => /INSERT INTO inventory_batches/.test(sql));
    // по имени колонки, а не по хвосту списка: в конец добавляются новые поля
    const cols = /inventory_batches \(([^)]*)\)/.exec(batchInsert[0])![1].split(',').map((x: string) => x.trim());
    expect(batchInsert[1][cols.indexOf('supplier_id')]).toBe('s-1');
    expect(batchInsert[1][cols.indexOf('invoice_id')]).toBe('inv-1');
  });

  it('без соединения — своя транзакция, как раньше', async () => {
    const c = conn();
    const svc = new InventoryService('postgresql://test');
    (svc as any).pool = { connect: jest.fn(async () => c) };
    await svc.addStockMovement({ warehouseId: 'w', inventoryItemId: 'i', movementType: 'receipt', quantity: 5, costPrice: 10 });
    expect(c.log[0]).toBe('BEGIN');
    expect(c.log).toContain('COMMIT');
    expect(c.release).toHaveBeenCalled();
  });
});

describe('ошибки приёмки — по-русски и с кодом', () => {
  it('уже принятая накладная — 409 «Накладная уже принята», движений нет', async () => {
    const client = makeClient([item('1')], { ...INVOICE, status: 'received' });
    const inv = new InventoryService('postgresql://test');
    const spy = jest.spyOn(inv, 'addStockMovement');
    await expect(supplierWith(client).confirmInvoice('inv-1', 'u', inv, 'e'))
      .rejects.toMatchObject({ name: 'InvoiceError', status: 409, message: 'Накладная уже принята' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('нет накладной (или чужая) — 404 «Накладная не найдена»', async () => {
    const client = makeClient([], undefined as any);
    client.query = jest.fn(async () => ({ rows: [], rowCount: 0 }));
    await expect(supplierWith(client).confirmInvoice('inv-x', 'u', new InventoryService('postgresql://test'), 'e'))
      .rejects.toMatchObject({ name: 'InvoiceError', status: 404, message: 'Накладная не найдена' });
  });
});
