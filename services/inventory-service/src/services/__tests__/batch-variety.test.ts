/**
 * Сорт в партии (миграция 064): «Кофе в зёрнах» — один товар, Колумбия и
 * Эфиопия — партии. Без выбора гостя — FIFO; модификатор «на Эфиопии»
 * просит списать ингредиент из партий этого сорта, не хватило — с других,
 * и это видно в движении и в ответе списания.
 */
import { InventoryService } from '../inventory.service';
import { InvoiceItemService } from '../invoice-item.service';

jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('pg', () => {
  const Pool = jest.fn().mockImplementation(() => ({ connect: jest.fn(), query: jest.fn(), end: jest.fn() }));
  return { __esModule: true, default: { Pool }, Pool };
});

function client(rules: Array<[RegExp, any]>) {
  const queries: { sql: string; params: any[] }[] = [];
  return {
    queries,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      for (const [re, r] of rules) if (re.test(sql)) return typeof r === 'function' ? r(params, sql) : r;
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn()
  } as any;
}
const svc = (c: any) => { const s = new InventoryService('postgresql://test'); (s as any).pool = { connect: jest.fn(async () => c), query: c.query }; return s; };

describe('consumeBatchesFIFO с выбранным сортом', () => {
  // Мок честно сортирует партии так, как велит ORDER BY: выбранный сорт первым,
  // дальше по received_at — иначе тест прошёл бы при любом запросе
  const BATCHES = [
    { id: 'col', quantity: '5', cost_price: '100', variety: 'Колумбия', received_at: 1 },
    { id: 'eth', quantity: '1', cost_price: '300', variety: 'Эфиопия', received_at: 2 }
  ];
  const sorted = (params: any[], sql: string) => {
    const pref = /IS NOT DISTINCT FROM \$3/.test(sql) ? params[2] : null;
    const rows = [...BATCHES].sort((a, b) =>
      (pref ? Number((b.variety || '').toLowerCase() === pref) - Number((a.variety || '').toLowerCase() === pref) : 0)
      || a.received_at - b.received_at);
    return { rows, rowCount: rows.length };
  };

  it('без сорта — чистый FIFO: старая Колумбия первой', async () => {
    const c = client([[/FROM inventory_batches/, sorted]]);
    const r = await svc(c).consumeBatchesFIFO(c, 'w', 'beans', 0.5);
    expect(r).toMatchObject({ consumed: 0.5, cost: 50, preferredTaken: 0 });
    expect(c.queries[0].sql).not.toMatch(/IS NOT DISTINCT FROM/);
    expect(c.queries[0].params).toEqual(['w', 'beans']);
    const upd = c.queries.filter((q: any) => /UPDATE inventory_batches/.test(q.sql));
    expect(upd[0].params).toEqual([0.5, 'col']);
  });

  it('«Эфиопия» — сначала её партия, сравнение без учёта регистра', async () => {
    const c = client([[/FROM inventory_batches/, sorted]]);
    const r = await svc(c).consumeBatchesFIFO(c, 'w', 'beans', 0.8, ' ЭФИОПИЯ ');
    expect(c.queries[0].params).toEqual(['w', 'beans', 'эфиопия']);
    expect(c.queries[0].sql).toMatch(/ORDER BY \(lower\(variety\) IS NOT DISTINCT FROM \$3\) DESC, received_at ASC/);
    expect(r).toMatchObject({ consumed: 0.8, cost: 0.8 * 300, preferredTaken: 0.8 });
    const upd = c.queries.filter((q: any) => /UPDATE inventory_batches/.test(q.sql));
    expect(upd[0].params).toEqual([0.8, 'eth']);
  });

  it('сорта не хватило — остаток с других партий, preferredTaken показывает сколько вышло из сорта', async () => {
    const c = client([[/FROM inventory_batches/, sorted]]);
    const r = await svc(c).consumeBatchesFIFO(c, 'w', 'beans', 3, 'Эфиопия');
    expect(r.preferredTaken).toBeCloseTo(1, 9);
    expect(r.consumed).toBe(3);
    expect(r.cost).toBeCloseTo(300 + 2 * 100, 6);
  });
});

describe('списание продажи: модификатор выбирает сорт ингредиента', () => {
  const rules = (picks: any[], ingredients: any[]) => client([
    [/SELECT id FROM warehouses WHERE id = \$1 AND enterprise_id = \$2/, { rows: [{ id: 'w' }], rowCount: 1 }],
    [/FROM order_items oi/, { rows: [{ order_item_id: 'oi-1', menu_item_id: 'esp', quantity: 2, order_date: '2026-11-11' }], rowCount: 1 }],
    [/FROM tech_cards tc\s+LEFT JOIN inventory_items ii ON ii\.id = tc\.output_item_id\s+WHERE tc\.menu_item_id/, { rows: [{ id: 'tc', write_off_method: 'ingredients' }], rowCount: 1 }],
    [/FROM tech_card_ingredients tci/, { rows: ingredients, rowCount: ingredients.length }],
    [/mim\.variety_item_id IS NOT NULL/, { rows: picks, rowCount: picks.length }],
    [/INSERT INTO inventory_stock/, { rows: [{ quantity: '10' }], rowCount: 1 }]
  ]);
  const BEANS = { inventory_item_id: 'beans', quantity: '0.018', item_name: 'Кофе в зёрнах', is_optional: false };
  const MILK = { inventory_item_id: 'milk', quantity: '0.15', item_name: 'Молоко', is_optional: false };

  function run(c: any, fifo: (item: string, qty: number, pref?: string) => any) {
    const s = svc(c);
    const calls: any[] = [];
    (s as any).consumeBatchesFIFO = jest.fn(async (_c: any, _w: string, item: string, qty: number, pref?: string) => {
      calls.push({ item, qty, pref }); return fifo(item, qty, pref);
    });
    (s as any).lastCost = jest.fn(async () => 0);
    return { s, calls };
  }
  const notes = (c: any) => c.queries.filter((q: any) => /INSERT INTO stock_movements/.test(q.sql)).map((q: any) => ({ item: q.params[2], note: q.params[7] }));

  it('сорт уходит только в свой ингредиент; молоко — обычный FIFO; в движении записан сорт', async () => {
    const c = rules([{ variety_item_id: 'beans', variety: 'Эфиопия', name: 'На Эфиопии' }], [BEANS, MILK]);
    const { s, calls } = run(c, (_i, qty, pref) => ({ consumed: qty, cost: qty * 10, uncovered: 0, preferredTaken: pref ? qty : 0 }));
    const res = await s.deductByTechCards('ord', 'w', 'u', 'e');
    expect(calls).toEqual([{ item: 'beans', qty: 0.036, pref: 'Эфиопия' }, { item: 'milk', qty: 0.3, pref: undefined }]);
    expect(notes(c).find((n: any) => n.item === 'beans').note).toContain('сорт «Эфиопия»');
    expect(notes(c).find((n: any) => n.item === 'milk').note).not.toContain('сорт');
    expect(res.skipped.join(' ')).not.toContain('не хватило');
  });

  it('сорта не хватило — списано с других партий и это есть в ответе и в движении', async () => {
    const c = rules([{ variety_item_id: 'beans', variety: 'Эфиопия', name: 'На Эфиопии' }], [BEANS]);
    const { s } = run(c, (_i, qty) => ({ consumed: qty, cost: 0, uncovered: 0, preferredTaken: 0.01 }));
    const res = await s.deductByTechCards('ord', 'w', 'u', 'e');
    expect(notes(c)[0].note).toMatch(/сорта не хватило 0\.026, взято с других партий/);
    expect(res.skipped.join(' ')).toMatch(/Кофе в зёрнах: сорта «Эфиопия» не хватило 0\.026/);
  });

  it('сорт выбран для ингредиента, которого нет в техкарте, — предупреждение, списание как обычно', async () => {
    const c = rules([{ variety_item_id: 'other', variety: 'Кения', name: 'На Кении' }], [BEANS]);
    const { s, calls } = run(c, (_i, qty) => ({ consumed: qty, cost: 0, uncovered: 0, preferredTaken: 0 }));
    const res = await s.deductByTechCards('ord', 'w', 'u', 'e');
    expect(calls[0].pref).toBeUndefined();
    expect(res.skipped.join(' ')).toContain('«На Кении»: ингредиента для выбора сорта нет в техкарте');
  });

  it('запрос выбора сорта — по строке заказа и только модификаторы с парой ингредиент+сорт', async () => {
    const c = rules([], [BEANS]);
    const { s } = run(c, (_i, qty) => ({ consumed: qty, cost: 0, uncovered: 0, preferredTaken: 0 }));
    await s.deductByTechCards('ord', 'w', 'u', 'e');
    const q = c.queries.find((x: any) => /mim\.variety_item_id IS NOT NULL/.test(x.sql));
    expect(q.sql).toMatch(/oim\.order_item_id = \$1 AND mim\.variety_item_id IS NOT NULL AND mim\.variety IS NOT NULL/);
    expect(q.params).toEqual(['oi-1']);
  });
});

describe('сорт из накладной попадает в партию', () => {
  it('приход: variety — в колонку партии, пустой сорт — NULL', async () => {
    for (const [given, want] of [['  Колумбия ', 'Колумбия'], ['', null], [undefined, null]] as const) {
      const c = client([[/INSERT INTO inventory_stock|UPDATE inventory_stock/, { rows: [{ quantity: '5' }], rowCount: 1 }]]);
      const s = svc(c);
      await s.addStockMovement({ warehouseId: 'w', inventoryItemId: 'beans', movementType: 'receipt', quantity: 5, costPrice: 1500, variety: given as any }, c);
      const ins = c.queries.find((q: any) => /INSERT INTO inventory_batches/.test(q.sql))!;
      const cols = /inventory_batches \(([^)]*)\)/.exec(ins.sql)![1].split(',').map((x: string) => x.trim());
      expect(ins.params[cols.indexOf('variety')]).toBe(want);
    }
  });

  it('позиция накладной хранит сорт', async () => {
    const queries: any[] = [];
    const c: any = { query: jest.fn(async (sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      if (/FROM supply_invoices/.test(sql)) return { rows: [{ id: 'inv', enterprise_id: 'e', supplier_id: null, status: 'draft' }] };
      if (/FROM inventory_items/.test(sql)) return { rows: [{ id: 'beans', name: 'Кофе в зёрнах', unit: 'кг', enterprise_id: 'e' }] };
      if (/INSERT INTO supply_invoice_items/.test(sql)) return { rows: [{ id: 'row' }] };
      return { rows: [], rowCount: 1 };
    }), release: jest.fn() };
    const s = new InvoiceItemService('postgresql://test');
    (s as any).pool = { connect: jest.fn(async () => c) };
    await s.add('inv', 'e', { inventoryItemId: 'beans', quantity: 1, pricePerUnit: 1500, variety: ' Эфиопия ' });
    const ins = queries.find((q) => /INSERT INTO supply_invoice_items/.test(q.sql));
    const cols = /supply_invoice_items\s*\(([^)]*)\)/.exec(ins.sql)![1].split(',').map((x: string) => x.trim());
    expect(ins.params[cols.indexOf('variety')]).toBe('Эфиопия');
  });
});

describe('остатки по сортам в списке позиций', () => {
  it('by_variety — по живым партиям товара, с фильтром склада', async () => {
    const c = client([]);
    await svc(c).listItems({ enterpriseId: 'e', warehouseId: 'w' });
    const sql = c.queries.find((q: any) => /AS by_variety/.test(q.sql))!.sql;
    expect(sql).toMatch(/b\.inventory_item_id = i\.id AND b\.is_depleted = false AND b\.quantity > 0 AND b\.warehouse_id = \$\d+\s+GROUP BY 1\) v\) AS by_variety/);
  });
});
