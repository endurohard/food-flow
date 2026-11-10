/**
 * Позиции накладной: фасовка → единицы склада, сумма считается сервером,
 * правка только черновика, товар своего предприятия, фасовка запоминается.
 */
import { InvoiceItemService, computeLine } from '../invoice-item.service';

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
  const s = new InvoiceItemService('postgresql://test');
  (s as any).pool = { connect: jest.fn(async () => c), query: c.query };
  return s;
}
const draft = (over: any = {}) => (sql: string) => {
  if (/FROM supply_invoices\s+WHERE id = \$1/.test(sql)) return [{ id: 'inv', enterprise_id: ENT, supplier_id: 'sup', status: 'draft', ...over }];
  if (/FROM inventory_items WHERE id = \$1 AND enterprise_id = \$2/.test(sql)) return over.noItem ? [] : [{ id: 'i1', name: 'Мука', unit: 'кг' }];
  if (/INSERT INTO supply_invoice_items|UPDATE supply_invoice_items/.test(sql)) return [{ id: 'row' }];
  if (/SELECT \* FROM supply_invoice_items/.test(sql)) return [{ id: 'row', inventory_item_id: 'i9', name: 'Сахар', unit: 'кг' }];
  if (/DELETE FROM supply_invoice_items/.test(sql)) return over.noRow ? [] : [{}];
  return [];
};

describe('computeLine', () => {
  it('3 мешка по 50 кг по 2 400 ₽ → 150 кг по 48 ₽, сумма 7 200', () => {
    expect(computeLine({ pack: { name: 'мешок', size: 50, count: 3, price: 2400 } })).toEqual({ quantity: 150, pricePerUnit: 48, total: 7200 });
  });
  it('сумма — из документа, а не из округлённой цены за единицу', () => {
    // коробка 12 шт по 199 ₽: 16,58 ₽/шт, но 2 коробки — ровно 398 ₽
    expect(computeLine({ pack: { name: 'коробка', size: 12, count: 2, price: 199 } })).toEqual({ quantity: 24, pricePerUnit: 16.58, total: 398 });
  });
  it('без фасовки — количество × цена', () => {
    expect(computeLine({ quantity: 2.5, pricePerUnit: 89.9 })).toEqual({ quantity: 2.5, pricePerUnit: 89.9, total: 224.75 });
  });
  it('пустое количество — ошибка', () => {
    expect(() => computeLine({ quantity: 0, pricePerUnit: 1 })).toThrow('больше нуля');
  });
});

describe('add', () => {
  it('позиция в единицах склада, имя и единица — из карточки товара, фасовка запоминается', async () => {
    const c = client(draft());
    await svcWith(c).add('inv', ENT, { inventoryItemId: 'i1', name: 'чужое имя', pack: { name: ' мешок ', size: 50, count: 3, price: 2400 } });
    const ins = c.log.find((q) => /INSERT INTO supply_invoice_items/.test(q.sql))!;
    expect(ins.params).toEqual(['inv', 'i1', 'Мука', 150, 'кг', 48, 7200, 'мешок', 50, 3, 2400]);
    const pk = c.log.find((q) => /INSERT INTO item_packages/.test(q.sql))!;
    expect(pk.params).toEqual([ENT, 'i1', 'sup', 'мешок', 50, 2400]);
    expect(c.log.some((q) => /UPDATE supply_invoices\s+SET total_amount/.test(q.sql))).toBe(true);
  });

  it('товар другого предприятия — 404 и откат', async () => {
    const c = client(draft({ noItem: true }));
    await expect(svcWith(c).add('inv', ENT, { inventoryItemId: 'alien', quantity: 1, pricePerUnit: 1 })).rejects.toMatchObject({ status: 404 });
    expect(c.log.some((q) => q.sql.trim() === 'ROLLBACK')).toBe(true);
    expect(c.log.some((q) => /INSERT INTO supply_invoice_items/.test(q.sql))).toBe(false);
  });

  it('принятую накладную не меняем', async () => {
    const c = client(draft({ status: 'received' }));
    await expect(svcWith(c).add('inv', ENT, { inventoryItemId: 'i1', quantity: 1, pricePerUnit: 1 })).rejects.toThrow('уже принята');
  });

  it('чужая накладная — 404 (enterprise в условии)', async () => {
    const c = client(() => []);
    await expect(svcWith(c).add('inv', ENT, { inventoryItemId: 'i1', quantity: 1, pricePerUnit: 1 })).rejects.toMatchObject({ status: 404 });
    expect(c.log.find((q) => /FROM supply_invoices/.test(q.sql))!.params).toEqual(['inv', ENT]);
  });
});

describe('update / remove', () => {
  it('без товара в запросе — остаётся прежний, фасовка снимается', async () => {
    const c = client(draft());
    await svcWith(c).update('inv', ENT, 'row', { quantity: 8, pricePerUnit: 70 });
    const up = c.log.find((q) => /UPDATE supply_invoice_items/.test(q.sql))!;
    expect(up.params).toEqual(['row', 'inv', 'i9', 'Сахар', 'кг', 8, 70, 560, null, null, null, null]);
    expect(c.log.some((q) => /INSERT INTO item_packages/.test(q.sql))).toBe(false);
  });

  it('удаление пересчитывает сумму; нет позиции — 404', async () => {
    const c = client(draft());
    await svcWith(c).remove('inv', ENT, 'row');
    expect(c.log.some((q) => /UPDATE supply_invoices\s+SET total_amount/.test(q.sql))).toBe(true);
    await expect(svcWith(client(draft({ noRow: true }))).remove('inv', ENT, 'x')).rejects.toMatchObject({ status: 404 });
  });
});

it('фасовки: сначала этого поставщика', async () => {
  const c = client(() => [{ id: 'p', name: 'мешок', units_per_pack: '50', last_pack_price: '2400', supplier_id: 'sup', supplier_name: 'Фермер' }]);
  const r = await svcWith(c).packages(ENT, 'i1', 'sup');
  expect(r).toEqual([{ id: 'p', name: 'мешок', unitsPerPack: 50, lastPackPrice: 2400, supplierId: 'sup', supplierName: 'Фермер' }]);
  expect(c.log[0].sql).toMatch(/IS NOT DISTINCT FROM \$3::uuid\) DESC/);
  expect(c.log[0].params).toEqual([ENT, 'i1', 'sup']);
});
