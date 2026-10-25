import { InventoryService } from '../inventory.service';

jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

jest.mock('pg', () => {
  const Pool = jest.fn().mockImplementation(() => ({
    connect: jest.fn(),
    query: jest.fn(),
    end: jest.fn()
  }));
  return { __esModule: true, default: { Pool }, Pool };
});

/**
 * Клиент с журналом запросов. Правила подбираются по регулярке на SQL —
 * мок обязан УВАЖАТЬ запрос, а не выдавать готовый ответ независимо от него:
 * иначе тест пройдёт при любой ошибке в SQL.
 */
function makeClient(rules: Array<[RegExp, any]>) {
  const all = [...BASE_RULES_HOLDER.rules, ...rules];
  const queries: { sql: string; params: any[] }[] = [];
  const client: any = {
    queries,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      for (const [pattern, result] of all) {
        if (pattern.test(sql)) {
          return typeof result === 'function' ? result(params) : result;
        }
      }
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn()
  };
  return client;
}

/**
 * Базовые правила держим в объекте, потому что makeClient объявлен выше их
 * определения: прямая ссылка на const дала бы ошибку инициализации.
 */
const BASE_RULES_HOLDER: { rules: Array<[RegExp, any]> } = { rules: [] };

function makeService(client: any) {
  const svc = new InventoryService('postgresql://test');
  (svc as any).pool = { connect: jest.fn(async () => client), query: client.query };
  // FIFO проверяется своими тестами; здесь важен факт и объём списания.
  (svc as any).deductFIFO = jest.fn(async (_w: string, _i: string, qty: number) => ({
    batches: [{ deducted: String(qty), costPrice: '100' }]
  }));
  return svc;
}

/** Правила, нужные любому прогону: склад существует, заказ ещё не проведён. */
BASE_RULES_HOLDER.rules = [
  [/SELECT id FROM warehouses WHERE id = \$1 AND enterprise_id = \$2/, { rows: [{ id: 'wh-1' }], rowCount: 1 }]
];

/** Движения склада, которые реально записались. */
function movements(client: any) {
  return client.queries
    .filter((q: any) => /INSERT INTO stock_movements/.test(q.sql))
    .map((q: any) => ({ itemId: q.params[2], qty: q.params[3], note: q.params[7] }));
}

const ORDER = {
  rows: [{ order_item_id: 'oi-1', menu_item_id: 'mi-1', quantity: 2, order_date: '2026-10-25' }],
  rowCount: 1
};

const NO_TECHCARD = { rows: [], rowCount: 0 };

const STOCK_OK = (params: any[]) => ({ rows: [{ quantity: '100' }], rowCount: 1 });

describe('Списание модификаторов со склада', () => {
  it('списывает позицию склада, умножая расход на количество блюд', async () => {
    // Доп. сыр 0.02 кг на один выбор, в строке заказа 2 блюда → 0.04 кг.
    // Раньше модификатор не списывался вообще: касса брала деньги,
    // а остаток не менялся.
    const client = makeClient([
      [/FROM order_items oi/, ORDER],
      [/FROM tech_card_ingredients tci\s+INNER JOIN inventory_items ii ON tci/, NO_TECHCARD],
      [/FROM order_item_modifiers oim/, {
        rows: [{
          chosen_name: 'Доп. сыр',
          modifier_name: 'Доп. сыр',
          inventory_item_id: 'inv-cheese',
          tech_card_id: null,
          quantity: '0.02'
        }],
        rowCount: 1
      }],
      [/SELECT name FROM inventory_items/, { rows: [{ name: 'Сыр' }], rowCount: 1 }],
      [/UPDATE inventory_stock/, STOCK_OK]
    ]);
    const svc = makeService(client);

    const res = await svc.deductByTechCards('ord-1', 'wh-1', 'user-1', 'ent-1');

    const mv = movements(client);
    expect(mv).toHaveLength(1);
    expect(mv[0].itemId).toBe('inv-cheese');
    expect(mv[0].qty).toBeCloseTo(0.04, 6);
    expect(mv[0].note).toContain('модификатору');
    expect(res.deducted).toHaveLength(1);
  });

  it('списывает полуфабрикат техкарты одной строкой, а не её сырьё', async () => {
    // Соус уже сварен и лежит на складе со своей себестоимостью выпуска —
    // разбирать его обратно на ингредиенты неверно (двойной учёт).
    const client = makeClient([
      [/FROM order_items oi/, ORDER],
      [/FROM tech_card_ingredients tci\s+INNER JOIN inventory_items ii ON tci/, NO_TECHCARD],
      [/FROM order_item_modifiers oim/, {
        rows: [{
          chosen_name: 'Соус Цезарь',
          modifier_name: 'Соус Цезарь',
          inventory_item_id: null,
          tech_card_id: 'tc-sauce',
          quantity: '1'
        }],
        rowCount: 1
      }],
      [/FROM tech_cards tc\s+LEFT JOIN inventory_items/, {
        rows: [{ output_item_id: 'inv-sauce', output_name: 'Соус Цезарь (п/ф)' }],
        rowCount: 1
      }],
      [/UPDATE inventory_stock/, STOCK_OK]
    ]);
    const svc = makeService(client);

    await svc.deductByTechCards('ord-1', 'wh-1', 'user-1', 'ent-1');

    const mv = movements(client);
    expect(mv).toHaveLength(1);
    expect(mv[0].itemId).toBe('inv-sauce');
    expect(mv[0].qty).toBeCloseTo(2, 6);
    expect(mv[0].note).toContain('полуфабрикат');
    // Состав карты не должен запрашиваться: выпуск уже на складе
    expect(client.queries.some((q: any) => /WHERE tci\.tech_card_id = \$1/.test(q.sql))).toBe(false);
  });

  it('по техкарте без выпуска на склад списывает её сырьё', async () => {
    const client = makeClient([
      [/FROM order_items oi/, ORDER],
      [/FROM tech_card_ingredients tci\s+INNER JOIN inventory_items ii ON tci/, NO_TECHCARD],
      [/FROM order_item_modifiers oim/, {
        rows: [{
          chosen_name: 'Двойная котлета',
          modifier_name: 'Двойная котлета',
          inventory_item_id: null,
          tech_card_id: 'tc-patty',
          quantity: '1'
        }],
        rowCount: 1
      }],
      [/FROM tech_cards tc\s+LEFT JOIN inventory_items/, {
        rows: [{ output_item_id: null, output_name: null }],
        rowCount: 1
      }],
      [/WHERE tci\.tech_card_id = \$1/, {
        rows: [{ inventory_item_id: 'inv-beef', quantity: '0.1', is_optional: false, item_name: 'Говядина' }],
        rowCount: 1
      }],
      [/UPDATE inventory_stock/, STOCK_OK]
    ]);
    const svc = makeService(client);

    await svc.deductByTechCards('ord-1', 'wh-1', 'user-1', 'ent-1');

    const mv = movements(client);
    expect(mv).toHaveLength(1);
    expect(mv[0].itemId).toBe('inv-beef');
    // 0.1 кг × 1 выбор × 2 блюда
    expect(mv[0].qty).toBeCloseTo(0.2, 6);
  });

  it('модификатор без складской связи не списывает ничего', async () => {
    // Запрос обязан сам отфильтровать такие строки: иначе списание упадёт
    // с NULL-позицией или спишет неизвестно что.
    const client = makeClient([
      [/FROM order_items oi/, ORDER],
      [/FROM tech_card_ingredients tci\s+INNER JOIN inventory_items ii ON tci/, NO_TECHCARD],
      [/UPDATE inventory_stock/, STOCK_OK]
    ]);
    const svc = makeService(client);

    const res = await svc.deductByTechCards('ord-1', 'wh-1', 'user-1', 'ent-1');

    expect(movements(client)).toHaveLength(0);
    expect(res.deducted).toHaveLength(0);

    // Фильтр должен стоять в самом SQL
    const modQuery = client.queries.find((q: any) => /FROM order_item_modifiers oim/.test(q.sql));
    expect(modQuery).toBeDefined();
    expect(modQuery.sql).toMatch(/mim\.quantity IS NOT NULL/);
    expect(modQuery.sql).toMatch(/inventory_item_id IS NOT NULL OR mim\.tech_card_id IS NOT NULL/);
  });

  it('списывает модификатор, даже когда у самого блюда нет техкарты', async () => {
    // Добавка имеет свой расход независимо от того, описано ли блюдо картой.
    const client = makeClient([
      [/FROM order_items oi/, ORDER],
      [/FROM tech_card_ingredients tci\s+INNER JOIN inventory_items ii ON tci/, NO_TECHCARD],
      [/FROM order_item_modifiers oim/, {
        rows: [{
          chosen_name: 'Сироп',
          modifier_name: 'Сироп',
          inventory_item_id: 'inv-syrup',
          tech_card_id: null,
          quantity: '0.015'
        }],
        rowCount: 1
      }],
      [/SELECT name FROM inventory_items/, { rows: [{ name: 'Сироп карамель' }], rowCount: 1 }],
      [/UPDATE inventory_stock/, STOCK_OK]
    ]);
    const svc = makeService(client);

    const res = await svc.deductByTechCards('ord-1', 'wh-1', 'user-1', 'ent-1');

    expect(movements(client)).toHaveLength(1);
    expect(res.skipped.some(s => /no tech card/.test(s))).toBe(true);
  });

  it('списывает и ингредиенты блюда, и модификатор', async () => {
    const client = makeClient([
      [/FROM order_items oi/, ORDER],
      [/FROM tech_card_ingredients tci\s+INNER JOIN inventory_items ii ON tci/, {
        rows: [{
          inventory_item_id: 'inv-coffee',
          quantity: '0.02',
          cold_loss_percent: '0',
          hot_loss_percent: '0',
          is_optional: false,
          item_name: 'Зерно'
        }],
        rowCount: 1
      }],
      [/FROM order_item_modifiers oim/, {
        rows: [{
          chosen_name: 'Сироп',
          modifier_name: 'Сироп',
          inventory_item_id: 'inv-syrup',
          tech_card_id: null,
          quantity: '0.015'
        }],
        rowCount: 1
      }],
      [/SELECT name FROM inventory_items/, { rows: [{ name: 'Сироп карамель' }], rowCount: 1 }],
      [/UPDATE inventory_stock/, STOCK_OK]
    ]);
    const svc = makeService(client);

    await svc.deductByTechCards('ord-1', 'wh-1', 'user-1', 'ent-1');

    const mv = movements(client);
    expect(mv).toHaveLength(2);
    expect(mv.find((m: any) => m.itemId === 'inv-coffee').qty).toBeCloseTo(0.04, 6);
    expect(mv.find((m: any) => m.itemId === 'inv-syrup').qty).toBeCloseTo(0.03, 6);
  });

  it('неактивная техкарта модификатора попадает в skipped, а не роняет заказ', async () => {
    const client = makeClient([
      [/FROM order_items oi/, ORDER],
      [/FROM tech_card_ingredients tci\s+INNER JOIN inventory_items ii ON tci/, NO_TECHCARD],
      [/FROM order_item_modifiers oim/, {
        rows: [{
          chosen_name: 'Соус',
          modifier_name: 'Соус',
          inventory_item_id: null,
          tech_card_id: 'tc-gone',
          quantity: '1'
        }],
        rowCount: 1
      }],
      [/FROM tech_cards tc\s+LEFT JOIN inventory_items/, { rows: [], rowCount: 0 }],
      [/UPDATE inventory_stock/, STOCK_OK]
    ]);
    const svc = makeService(client);

    const res = await svc.deductByTechCards('ord-1', 'wh-1', 'user-1', 'ent-1');

    expect(movements(client)).toHaveLength(0);
    expect(res.skipped.some(s => /неактивна или удалена/.test(s))).toBe(true);
    // Заказ всё равно проведён
    expect(client.queries.some((q: any) => /COMMIT/.test(q.sql))).toBe(true);
  });

  it('нехватка остатка на модификатор отменяет всю транзакцию', async () => {
    // Иначе часть продуктов списана, часть нет — склад разъезжается.
    const client = makeClient([
      [/FROM order_items oi/, ORDER],
      [/FROM tech_card_ingredients tci\s+INNER JOIN inventory_items ii ON tci/, NO_TECHCARD],
      [/FROM order_item_modifiers oim/, {
        rows: [{
          chosen_name: 'Сироп',
          modifier_name: 'Сироп',
          inventory_item_id: 'inv-syrup',
          tech_card_id: null,
          quantity: '0.015'
        }],
        rowCount: 1
      }],
      [/SELECT name FROM inventory_items/, { rows: [{ name: 'Сироп' }], rowCount: 1 }],
      [/UPDATE inventory_stock/, { rows: [], rowCount: 0 }]
    ]);
    const svc = makeService(client);

    await expect(svc.deductByTechCards('ord-1', 'wh-1', 'user-1', 'ent-1')).rejects.toThrow();
    expect(client.queries.some((q: any) => /ROLLBACK/.test(q.sql))).toBe(true);
  });

  it('повторное списание того же заказа ничего не делает', async () => {
    // Защита от двойного списания при retry из order-service.
    const client = makeClient([
      [/SELECT 1 FROM stock_movements/, { rows: [{ '1': 1 }], rowCount: 1 }]
    ]);
    const svc = makeService(client);

    const res = await svc.deductByTechCards('ord-1', 'wh-1', 'user-1', 'ent-1');

    expect(res.skipped).toContain('already_deducted');
    expect(movements(client)).toHaveLength(0);
  });

  it('расход модификатора берётся по order_item_id, а не по всему заказу', async () => {
    // Иначе добавка, выбранная к одной позиции, списалась бы за каждую
    // строку заказа.
    const client = makeClient([
      [/FROM order_items oi/, ORDER],
      [/FROM tech_card_ingredients tci\s+INNER JOIN inventory_items ii ON tci/, NO_TECHCARD],
      [/UPDATE inventory_stock/, STOCK_OK]
    ]);
    const svc = makeService(client);

    await svc.deductByTechCards('ord-1', 'wh-1', 'user-1', 'ent-1');

    const modQuery = client.queries.find((q: any) => /FROM order_item_modifiers oim/.test(q.sql));
    expect(modQuery.sql).toMatch(/oim\.order_item_id = \$1/);
    expect(modQuery.params[0]).toBe('oi-1');
  });
});
