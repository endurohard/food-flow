import { NomenclatureService } from '../nomenclature.service';

jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

jest.mock('pg', () => {
  const Pool = jest.fn().mockImplementation(() => ({
    connect: jest.fn(), query: jest.fn(), end: jest.fn()
  }));
  return { __esModule: true, default: { Pool }, Pool };
});

const EID = 'ent-1';

/**
 * Мок БД по правилам «регулярка SQL -> результат». Базовые правила
 * (позиция существует) обязательны: иначе каждый кейс падает на первом
 * служебном запросе, а не на проверяемой логике.
 */
function makePool(state: {
  item?: any; sales?: any[]; totals?: any; stock?: any[]; deliveries?: any[];
  batches?: any[]; cards?: any[]; ingredients?: any[];
} = {}) {
  const calls: { sql: string; params: any[] }[] = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });

    if (/FROM v_nomenclature/.test(sql)) {
      const it = state.item;
      // Представление обязано фильтровать по source и предприятию
      const ok = it && it.id === params[0] && it.source === params[1] && it.enterprise_id === params[2];
      return { rows: ok ? [it] : [], rowCount: ok ? 1 : 0 };
    }
    if (/COUNT\(DISTINCT o\.id\)/.test(sql)) {
      return { rows: [state.totals || { qty: '0', revenue: '0', orders: 0 }], rowCount: 1 };
    }
    if (/FROM order_items oi/.test(sql)) {
      return { rows: state.sales || [], rowCount: (state.sales || []).length };
    }
    if (/FROM inventory_stock s/.test(sql)) {
      return { rows: state.stock || [], rowCount: (state.stock || []).length };
    }
    if (/FROM supply_invoice_items sii/.test(sql)) {
      return { rows: state.deliveries || [], rowCount: (state.deliveries || []).length };
    }
    if (/FROM inventory_batches b/.test(sql)) {
      return { rows: state.batches || [], rowCount: (state.batches || []).length };
    }
    if (/FROM tech_cards/.test(sql)) {
      return { rows: state.cards || [], rowCount: (state.cards || []).length };
    }
    if (/FROM tech_card_ingredients tci/.test(sql)) {
      return { rows: state.ingredients || [], rowCount: (state.ingredients || []).length };
    }
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query, connect: jest.fn(), end: jest.fn() }, calls };
}

function svc(pool: any): NomenclatureService {
  const s = new NomenclatureService('postgres://test');
  (s as any).pool = pool;
  return s;
}

const DISH = { id: 'i1', source: 'menu', enterprise_id: EID, name: 'Бургер', item_type: 'dish' };
const GOOD = { id: 'i2', source: 'inventory', enterprise_id: EID, name: 'Зерно', item_type: 'good' };

describe('Карточка позиции — состав разделов', () => {
  it('несуществующая позиция даёт null, а не пустую карточку', async () => {
    const { pool } = makePool({ item: null });
    await expect(svc(pool).getCard('nope', 'menu', EID)).resolves.toBeNull();
  });

  it('чужая позиция не отдаётся даже при верном id', async () => {
    const { pool } = makePool({ item: { ...DISH, enterprise_id: 'ent-2' } });
    await expect(svc(pool).getCard('i1', 'menu', EID)).resolves.toBeNull();
  });

  it('у блюда есть все четыре раздела', async () => {
    const { pool } = makePool({ item: DISH });
    const card = await svc(pool).getCard('i1', 'menu', EID);
    expect(card.item.name).toBe('Бургер');
    expect(card.sales).toBeDefined();
    expect(card.purchase).toBeDefined();
    expect(card.cooking).toBeDefined();
  });
});

describe('Карточка — вкладка ПРОДАЖИ', () => {
  it('у блюда продажи считаются', async () => {
    const { pool } = makePool({
      item: DISH,
      totals: { qty: '12', revenue: '4800', orders: 7 },
      sales: [{ order_number: 'A-1', quantity: '2' }]
    });
    const card = await svc(pool).getCard('i1', 'menu', EID);
    expect(card.sales.applicable).toBe(true);
    expect(card.sales.total.orders).toBe(7);
    expect(card.sales.recent).toHaveLength(1);
  });

  it('у позиции склада раздел помечен неприменимым, а не пустым молча', async () => {
    const { pool } = makePool({ item: GOOD });
    const card = await svc(pool).getCard('i2', 'inventory', EID);
    expect(card.sales.applicable).toBe(false);
    expect(card.sales.reason).toMatch(/не продаётся/);
  });

  it('отменённые заказы исключены из суммы', async () => {
    const { pool, calls } = makePool({ item: DISH });
    await svc(pool).getCard('i1', 'menu', EID);
    const q = calls.find(c => /COUNT\(DISTINCT o\.id\)/.test(c.sql))!;
    expect(q.sql).toMatch(/status NOT IN \('cancelled'\)/);
  });

  it('продажи ограничены заведениями своего предприятия', async () => {
    const { pool, calls } = makePool({ item: DISH });
    await svc(pool).getCard('i1', 'menu', EID);
    const q = calls.find(c => /COUNT\(DISTINCT o\.id\)/.test(c.sql))!;
    expect(q.sql).toMatch(/restaurants WHERE enterprise_id = \$2/);
    expect(q.params).toContain(EID);
  });

  it('период продаж реально ограничивает выборку, а не только передаётся', async () => {
    const { pool, calls } = makePool({ item: DISH });
    await svc(pool).getCard('i1', 'menu', EID, 90);
    const q = calls.find(c => /COUNT\(DISTINCT o\.id\)/.test(c.sql))!;
    // Параметра мало: при `AND ($3 IS NOT NULL)` он тоже присутствует,
    // а отбора по дате нет — проверяем само условие по created_at.
    expect(q.sql).toMatch(/o\.created_at >= NOW\(\) - \(\$3 \|\| ' days'\)::interval/);
    expect(q.params).toContain('90');
  });
});

describe('Карточка — вкладка ЗАКУПКА', () => {
  it('у позиции склада есть остатки, поставки и партии', async () => {
    const { pool } = makePool({
      item: GOOD,
      stock: [{ warehouse: 'Основной', quantity: '10.000' }],
      deliveries: [{ invoice_number: 'INV-1', quantity: '5' }],
      batches: [{ batch_number: 'B-1', quantity: '5' }]
    });
    const card = await svc(pool).getCard('i2', 'inventory', EID);
    expect(card.purchase.applicable).toBe(true);
    expect(card.purchase.stock).toHaveLength(1);
    expect(card.purchase.deliveries).toHaveLength(1);
    expect(card.purchase.batches).toHaveLength(1);
  });

  it('у блюда раздел закупки помечен неприменимым', async () => {
    const { pool } = makePool({ item: DISH });
    const card = await svc(pool).getCard('i1', 'menu', EID);
    expect(card.purchase.applicable).toBe(false);
    expect(card.purchase.reason).toMatch(/не закупается/);
  });

  it('остатки берутся только со складов своего предприятия', async () => {
    const { pool, calls } = makePool({ item: GOOD });
    await svc(pool).getCard('i2', 'inventory', EID);
    const q = calls.find(c => /FROM inventory_stock s/.test(c.sql))!;
    expect(q.sql).toMatch(/w\.enterprise_id = \$2/);
  });

  it('израсходованные партии не показываются', async () => {
    const { pool, calls } = makePool({ item: GOOD });
    await svc(pool).getCard('i2', 'inventory', EID);
    const q = calls.find(c => /FROM inventory_batches b/.test(c.sql))!;
    expect(q.sql).toMatch(/is_depleted = false/);
  });

  it('партии идут в порядке FIFO — старые первыми', async () => {
    const { pool, calls } = makePool({ item: GOOD });
    await svc(pool).getCard('i2', 'inventory', EID);
    const q = calls.find(c => /FROM inventory_batches b/.test(c.sql))!;
    expect(q.sql).toMatch(/ORDER BY b\.received_at ASC/);
  });
});

describe('Карточка — вкладка ПРИГОТОВЛЕНИЕ', () => {
  const current = { id: 'tc-1', name: 'Актуальная', is_current: true, effective_from: '2026-01-01' };
  const future = { id: 'tc-2', name: 'Будущая', is_current: false, effective_from: '2027-01-01' };

  it('у блюда карта ищется по menu_item_id', async () => {
    const { pool, calls } = makePool({ item: DISH, cards: [current] });
    await svc(pool).getCard('i1', 'menu', EID);
    const q = calls.find(c => /FROM tech_cards/.test(c.sql))!;
    expect(q.sql).toMatch(/menu_item_id = \$1/);
  });

  it('у заготовки карта ищется по output_item_id', async () => {
    // Заготовка производится техкартой, а не продаётся по ней: поиск по
    // menu_item_id вернул бы пустоту и вкладка выглядела бы «нет техкарты».
    const { pool, calls } = makePool({ item: GOOD, cards: [current] });
    await svc(pool).getCard('i2', 'inventory', EID);
    const q = calls.find(c => /FROM tech_cards/.test(c.sql))!;
    expect(q.sql).toMatch(/output_item_id = \$1/);
  });

  it('выбирается действующая версия, а не первая по списку', async () => {
    const { pool } = makePool({ item: DISH, cards: [future, current] });
    const card = await svc(pool).getCard('i1', 'menu', EID);
    expect(card.cooking.card.name).toBe('Актуальная');
  });

  it('если действующей нет — берётся самая свежая, вкладка не пустеет', async () => {
    const { pool } = makePool({ item: DISH, cards: [future] });
    const card = await svc(pool).getCard('i1', 'menu', EID);
    expect(card.cooking.card.name).toBe('Будущая');
  });

  it('ингредиенты грузятся для выбранной версии, а не для первой', async () => {
    const { pool, calls } = makePool({
      item: DISH, cards: [future, current],
      ingredients: [{ name: 'Хлеб', quantity: '2' }]
    });
    const card = await svc(pool).getCard('i1', 'menu', EID);
    const q = calls.find(c => /FROM tech_card_ingredients tci/.test(c.sql))!;
    expect(q.params[0]).toBe('tc-1');
    expect(card.cooking.ingredients).toHaveLength(1);
  });

  it('все версии возвращаются списком для истории', async () => {
    const { pool } = makePool({ item: DISH, cards: [future, current] });
    const card = await svc(pool).getCard('i1', 'menu', EID);
    expect(card.cooking.versions).toHaveLength(2);
  });

  it('нет техкарты — раздел применим, но карта пустая', async () => {
    // «Техкарты ещё нет» и «механизм сломан» — разные состояния.
    const { pool } = makePool({ item: DISH, cards: [] });
    const card = await svc(pool).getCard('i1', 'menu', EID);
    expect(card.cooking.applicable).toBe(true);
    expect(card.cooking.card).toBeNull();
    expect(card.cooking.ingredients).toEqual([]);
  });

  it('техкарта ограничена предприятием', async () => {
    const { pool, calls } = makePool({ item: DISH, cards: [current] });
    await svc(pool).getCard('i1', 'menu', EID);
    const q = calls.find(c => /FROM tech_cards/.test(c.sql))!;
    expect(q.sql).toMatch(/enterprise_id = \$2/);
    expect(q.params).toContain(EID);
  });
});
