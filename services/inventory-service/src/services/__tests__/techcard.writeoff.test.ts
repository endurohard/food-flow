import { InventoryService } from '../inventory.service';

jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

jest.mock('pg', () => {
  const Pool = jest.fn().mockImplementation(() => ({
    connect: jest.fn(), query: jest.fn(), end: jest.fn()
  }));
  return { __esModule: true, default: { Pool }, Pool };
});

/**
 * Мок уважает SQL: правило выбирается регуляркой по запросу. Фиксированный
 * ответ независимо от запроса пропустил бы ошибку в самом SQL.
 */
function makeClient(rules: Array<[RegExp, any]>) {
  const base: Array<[RegExp, any]> = [
    [/SELECT id FROM warehouses WHERE id = \$1 AND enterprise_id = \$2/, { rows: [{ id: 'wh-1' }], rowCount: 1 }],
    [/UPDATE inventory_stock/, { rows: [{ quantity: '100' }], rowCount: 1 }]
  ];
  const all = [...base, ...rules];
  const queries: { sql: string; params: any[] }[] = [];
  const client: any = {
    queries,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      for (const [pattern, result] of all) {
        if (pattern.test(sql)) return typeof result === 'function' ? result(params) : result;
      }
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn()
  };
  return client;
}

function makeService(client: any) {
  const svc = new InventoryService('postgresql://test');
  (svc as any).pool = { connect: jest.fn(async () => client), query: client.query };
  (svc as any).deductFIFO = jest.fn(async (_w: string, _i: string, qty: number) => ({
    batches: [{ deducted: String(qty), costPrice: '100' }]
  }));
  return svc;
}

function movements(client: any) {
  return client.queries
    .filter((q: any) => /INSERT INTO stock_movements/.test(q.sql))
    .map((q: any) => ({ itemId: q.params[2], qty: q.params[3], note: q.params[7] }));
}

const ORDER = {
  rows: [{ order_item_id: 'oi-1', menu_item_id: 'mi-1', quantity: 2, order_date: '2026-10-25' }],
  rowCount: 1
};

// Выборка метода списания: отдельный запрос с LEFT JOIN на позицию выпуска.
const CARD_META = /SELECT tc\.id, tc\.write_off_method/;
// Выборка состава карты.
const INGREDIENTS = /FROM tech_card_ingredients tci\s+INNER JOIN inventory_items ii ON tci/;

const RAW_INGREDIENTS = {
  rows: [{ inventory_item_id: 'inv-flour', quantity: '0.5', cold_loss_percent: '0',
           hot_loss_percent: '0', is_optional: false, item_name: 'Мука' }],
  rowCount: 1
};

describe('Метод списания техкарты', () => {
  it('метод ingredients списывает сырьё, как раньше', async () => {
    const client = makeClient([
      [/FROM order_items oi/, ORDER],
      [CARD_META, { rows: [{ id: 'tc-1', write_off_method: 'ingredients',
                             output_item_id: null, output_quantity: null, output_name: null }], rowCount: 1 }],
      [INGREDIENTS, RAW_INGREDIENTS]
    ]);
    const svc = makeService(client);

    await svc.deductByTechCards('ord-1', 'wh-1', 'user-1', 'ent-1');

    const mv = movements(client);
    expect(mv).toHaveLength(1);
    expect(mv[0].itemId).toBe('inv-flour');
    expect(mv[0].qty).toBeCloseTo(1.0, 6);   // 0.5 × 2 блюда
  });

  it('метод finished списывает готовую позицию, а НЕ сырьё', async () => {
    // Сырьё ушло со склада ещё при выпуске партии. Списать его повторно —
    // двойной учёт: остаток уедет в минус на ровном месте.
    const client = makeClient([
      [/FROM order_items oi/, ORDER],
      [CARD_META, { rows: [{ id: 'tc-1', write_off_method: 'finished',
                             output_item_id: 'inv-cake', output_quantity: '0.3',
                             output_name: 'Торт готовый' }], rowCount: 1 }],
      [INGREDIENTS, RAW_INGREDIENTS]
    ]);
    const svc = makeService(client);

    await svc.deductByTechCards('ord-1', 'wh-1', 'user-1', 'ent-1');

    const mv = movements(client);
    expect(mv).toHaveLength(1);
    expect(mv[0].itemId).toBe('inv-cake');
    expect(mv[0].qty).toBeCloseTo(0.6, 6);   // 0.3 выхода × 2 блюда
    expect(mv.some((m: any) => m.itemId === 'inv-flour')).toBe(false);
  });

  it('при методе finished состав карты вообще не запрашивается', async () => {
    // Лишний запрос к составу безвреден по данным, но означает, что ветка
    // не отработала и сырьё может списаться следующей же правкой.
    const client = makeClient([
      [/FROM order_items oi/, ORDER],
      [CARD_META, { rows: [{ id: 'tc-1', write_off_method: 'finished',
                             output_item_id: 'inv-cake', output_quantity: '0.3',
                             output_name: 'Торт готовый' }], rowCount: 1 }],
      [INGREDIENTS, RAW_INGREDIENTS]
    ]);
    const svc = makeService(client);

    await svc.deductByTechCards('ord-1', 'wh-1', 'user-1', 'ent-1');

    expect(client.queries.some((q: any) => INGREDIENTS.test(q.sql))).toBe(false);
  });

  it('finished без заданного выхода ничего не списывает и говорит почему', async () => {
    // Карта настроена наполовину. Списать ноль молча нельзя: учёт разойдётся
    // незаметно, и причину потом не найти.
    const client = makeClient([
      [/FROM order_items oi/, ORDER],
      [CARD_META, { rows: [{ id: 'tc-1', write_off_method: 'finished',
                             output_item_id: 'inv-cake', output_quantity: null,
                             output_name: 'Торт готовый' }], rowCount: 1 }],
      [INGREDIENTS, RAW_INGREDIENTS]
    ]);
    const svc = makeService(client);

    const res = await svc.deductByTechCards('ord-1', 'wh-1', 'user-1', 'ent-1');

    expect(movements(client)).toHaveLength(0);
    expect(res.skipped.join(' ')).toMatch(/не задан выход/);
  });

  it('у блюда нет карты — это пропуск, а не ошибка', async () => {
    const client = makeClient([
      [/FROM order_items oi/, ORDER],
      [CARD_META, { rows: [], rowCount: 0 }]
    ]);
    const svc = makeService(client);

    const res = await svc.deductByTechCards('ord-1', 'wh-1', 'user-1', 'ent-1');

    expect(movements(client)).toHaveLength(0);
    expect(res.skipped.join(' ')).toMatch(/no tech card/);
  });

  it('карта есть, но состав пуст — отдельная причина, не «нет карты»', async () => {
    // Пустая карта тихо обнуляет учёт по блюду: по сообщению должно быть
    // видно, что карта существует, а состав забыли заполнить.
    const client = makeClient([
      [/FROM order_items oi/, ORDER],
      [CARD_META, { rows: [{ id: 'tc-1', write_off_method: 'ingredients',
                             output_item_id: null, output_quantity: null, output_name: null }], rowCount: 1 }],
      [INGREDIENTS, { rows: [], rowCount: 0 }]
    ]);
    const svc = makeService(client);

    const res = await svc.deductByTechCards('ord-1', 'wh-1', 'user-1', 'ent-1');

    expect(res.skipped.join(' ')).toMatch(/без ингредиентов/);
    expect(res.skipped.join(' ')).not.toMatch(/no tech card/);
  });

  it('метод берётся из версии, действовавшей на дату заказа', async () => {
    // Иначе вчерашняя продажа пересчиталась бы по сегодняшнему методу.
    const client = makeClient([
      [/FROM order_items oi/, ORDER],
      [CARD_META, { rows: [{ id: 'tc-1', write_off_method: 'ingredients',
                             output_item_id: null, output_quantity: null, output_name: null }], rowCount: 1 }],
      [INGREDIENTS, RAW_INGREDIENTS]
    ]);
    const svc = makeService(client);

    await svc.deductByTechCards('ord-1', 'wh-1', 'user-1', 'ent-1');

    const q = client.queries.find((x: any) => CARD_META.test(x.sql))!;
    expect(q.sql).toMatch(/effective_from <= \$2/);
    expect(q.sql).toMatch(/effective_to IS NULL OR tc\.effective_to >= \$2/);
    expect(q.sql).toMatch(/LIMIT 1/);
    expect(q.params[1]).toBe('2026-10-25');
  });

  it('модификаторы списываются и при методе finished', async () => {
    // Добавка имеет свой расход независимо от того, как списывается блюдо.
    const client = makeClient([
      [/FROM order_items oi/, ORDER],
      [CARD_META, { rows: [{ id: 'tc-1', write_off_method: 'finished',
                             output_item_id: 'inv-cake', output_quantity: '0.3',
                             output_name: 'Торт готовый' }], rowCount: 1 }],
      [/FROM order_item_modifiers oim/, {
        rows: [{ chosen_name: 'Доп. сыр', modifier_name: 'Доп. сыр',
                 inventory_item_id: 'inv-cheese', tech_card_id: null, quantity: '0.02' }],
        rowCount: 1
      }],
      [/SELECT name FROM inventory_items/, { rows: [{ name: 'Сыр' }], rowCount: 1 }]
    ]);
    const svc = makeService(client);

    await svc.deductByTechCards('ord-1', 'wh-1', 'user-1', 'ent-1');

    const mv = movements(client);
    expect(mv.map((m: any) => m.itemId).sort()).toEqual(['inv-cake', 'inv-cheese']);
  });
});
