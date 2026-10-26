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
 * Мок базы по дереву заготовок: cards[itemId] — карта, выпускающая позицию,
 * ings[cardId] — её состав. Правила подбираются по SQL, чтобы опечатка в
 * запросе ломала тест, а не проходила незамеченной.
 */
function makePool(tree: { cards?: Record<string, any>; ings?: Record<string, any[]> } = {}) {
  const cards = tree.cards || {};
  const ings = tree.ings || {};
  const calls: { sql: string; params: any[] }[] = [];

  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (/FROM tech_cards\s+WHERE output_item_id = \$1/.test(sql)) {
      const c = cards[params[0]];
      // Мок УВАЖАЕТ SQL: фильтр по предприятию применяем, только если он
      // реально записан в запросе. Иначе мок сам реализует проверяемое
      // поведение, и удаление условия из кода тест не поймает.
      const scoped = /enterprise_id = \$2/.test(sql);
      const ok = !!c && (!scoped || params[1] === EID);
      return { rows: ok ? [c] : [], rowCount: ok ? 1 : 0 };
    }
    // Запрос карты блюда из getCooking — другой: по menu_item_id/output_item_id
    // с вычислением is_current. Без правила getCooking выходил бы раньше, и
    // проверка SQL-признака has_nested молча не состоялась бы.
    if (/FROM tech_cards\s+WHERE (menu_item_id|output_item_id|\$\{col\})/.test(sql)
        || /is_current/.test(sql)) {
      return { rows: [{ id: 'tc-1', name: 'К', is_current: true }], rowCount: 1 };
    }
    if (/FROM v_tech_card_ingredients/.test(sql)) {
      const rows = ings[params[0]] || [];
      return { rows, rowCount: rows.length };
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

function ing(over: any = {}) {
  return {
    id: 'ti-1', inventory_item_id: 'raw-1', name: 'Капуста', sku: 'C1',
    item_type: 'good', unit: 'кг', package_unit: null, package_size: null,
    gross: '1.2', cold_loss_percent: '0', hot_loss_percent: '0',
    net: '1.2', output_weight: '1.2', is_optional: false, cost_price: '100',
    ...over
  };
}

describe('Раскрытие вложенной заготовки — масштабирование', () => {
  // Кимчи: 1 кг выхода из 1.2 кг капусты.
  const base = {
    cards: { 'prep-kimchi': { id: 'tc-kimchi', name: 'Кимчи', output_quantity: '1' } },
    ings: { 'tc-kimchi': [ing()] }
  };

  it('количества пересчитываются под фактический расход, а не за цикл', async () => {
    // В блюдо идёт 0.036 кг кимчи → капусты 1.2 × 0.036 = 0.0432.
    // Показ 1.2 кг был бы враньём: столько уходит на целую варку.
    const { pool } = makePool(base);
    const r = await svc(pool).expandNested('prep-kimchi', EID, 0.036);
    expect(r.scaled).toBe(true);
    expect(r.ingredients[0].gross).toBeCloseTo(0.0432, 6);
  });

  it('исходное количество за цикл сохраняется рядом', async () => {
    const { pool } = makePool(base);
    const r = await svc(pool).expandNested('prep-kimchi', EID, 0.036);
    expect(r.ingredients[0].gross_per_run).toBe('1.2');
  });

  it('себестоимость считается от пересчитанного брутто', async () => {
    const { pool } = makePool(base);
    const r = await svc(pool).expandNested('prep-kimchi', EID, 0.036);
    expect(r.ingredients[0].cost).toBeCloseTo(4.32, 4);   // 0.0432 × 100
  });

  it('выход за цикл больше единицы делит правильно', async () => {
    // Карта даёт 4 кг за варку; нужно 2 кг → половина состава.
    const { pool } = makePool({
      cards: { 'prep-kimchi': { id: 'tc-kimchi', name: 'Кимчи', output_quantity: '4' } },
      ings: { 'tc-kimchi': [ing({ gross: '1.2' })] }
    });
    const r = await svc(pool).expandNested('prep-kimchi', EID, 2);
    expect(r.ingredients[0].gross).toBeCloseTo(0.6, 6);
  });

  it('потери считаются каскадом уже от пересчитанного брутто', async () => {
    // 1 кг сырья, расход 0.5 → брутто 0.5; хол 10% → нетто 0.45;
    // гор 20% → выход 0.36. Расчёт потерь от нецелевого брутто дал бы другое.
    const { pool } = makePool({
      cards: { 'p': { id: 'tc', name: 'К', output_quantity: '1' } },
      ings: { 'tc': [ing({ gross: '1', cold_loss_percent: '10', hot_loss_percent: '20' })] }
    });
    const r = await svc(pool).expandNested('p', EID, 0.5);
    expect(r.ingredients[0].net).toBeCloseTo(0.45, 6);
    expect(r.ingredients[0].output_weight).toBeCloseTo(0.36, 6);
  });

  it('нулевой выход карты не даёт деления на ноль и честно помечается', async () => {
    const { pool } = makePool({
      cards: { 'p': { id: 'tc', name: 'К', output_quantity: '0' } },
      ings: { 'tc': [ing({ gross: '1.2' })] }
    });
    const r = await svc(pool).expandNested('p', EID, 0.5);
    expect(r.scaled).toBe(false);
    expect(r.scaleNote).toMatch(/не задан выход/);
    expect(Number.isFinite(r.ingredients[0].gross)).toBe(true);
    expect(r.ingredients[0].gross).toBeCloseTo(1.2, 6);   // как есть, за цикл
  });

  it('пустой выход карты обрабатывается так же', async () => {
    const { pool } = makePool({
      cards: { 'p': { id: 'tc', name: 'К', output_quantity: null } },
      ings: { 'tc': [ing()] }
    });
    const r = await svc(pool).expandNested('p', EID, 0.5);
    expect(r.scaled).toBe(false);
    expect(Number.isFinite(r.ingredients[0].gross)).toBe(true);
  });
});

describe('Раскрытие — что раскрывать, а что нет', () => {
  it('у позиции без техкарты раскрывать нечего — null, а не пустой объект', async () => {
    const { pool } = makePool({ cards: {}, ings: {} });
    await expect(svc(pool).expandNested('raw-1', EID, 1)).resolves.toBeNull();
  });

  it('карта чужого предприятия не раскрывается', async () => {
    const { pool } = makePool({
      cards: { 'p': { id: 'tc', name: 'К', output_quantity: '1' } },
      ings: { 'tc': [ing()] }
    });
    await expect(svc(pool).expandNested('p', 'ent-2', 1)).resolves.toBeNull();
  });

  it('берётся только действующая на сегодня версия карты', async () => {
    const { pool, calls } = makePool({
      cards: { 'p': { id: 'tc', name: 'К', output_quantity: '1' } },
      ings: { 'tc': [ing()] }
    });
    await svc(pool).expandNested('p', EID, 1);
    const q = calls.find(c => /FROM tech_cards/.test(c.sql))!;
    expect(q.sql).toMatch(/effective_from <= CURRENT_DATE/);
    expect(q.sql).toMatch(/effective_to IS NULL OR effective_to >= CURRENT_DATE/);
    expect(q.sql).toMatch(/is_active = true/);
    expect(q.sql).toMatch(/LIMIT 1/);
  });
});

describe('Раскрытие — вложенность и защита от зацикливания', () => {
  // соус → (масло, кимчи) ; кимчи → капуста
  const deep = {
    cards: {
      'prep-sauce': { id: 'tc-sauce', name: 'Соус', output_quantity: '1' },
      'prep-kimchi': { id: 'tc-kimchi', name: 'Кимчи', output_quantity: '1' }
    },
    ings: {
      'tc-sauce': [
        ing({ id: 'a', inventory_item_id: 'raw-oil', name: 'Масло', item_type: 'good', gross: '0.2' }),
        ing({ id: 'b', inventory_item_id: 'prep-kimchi', name: 'Кимчи', item_type: 'prepared', gross: '0.5' })
      ],
      'tc-kimchi': [ing({ id: 'c', inventory_item_id: 'raw-cab', name: 'Капуста', gross: '1.2' })]
    }
  };

  it('по умолчанию раскрывается один уровень', async () => {
    const { pool } = makePool(deep);
    const r = await svc(pool).expandNested('prep-sauce', EID, 1);
    const kimchi = r.ingredients.find((i: any) => i.inventory_item_id === 'prep-kimchi');
    expect(kimchi.nested).toBeNull();
  });

  it('depth=2 раскрывает второй уровень с накопленным масштабом', async () => {
    // 1 соуса → 0.5 кимчи → капусты 1.2 × 0.5 = 0.6
    const { pool } = makePool(deep);
    const r = await svc(pool).expandNested('prep-sauce', EID, 1, 2);
    const kimchi = r.ingredients.find((i: any) => i.inventory_item_id === 'prep-kimchi');
    expect(kimchi.nested).not.toBeNull();
    expect(kimchi.nested.ingredients[0].gross).toBeCloseTo(0.6, 6);
  });

  it('обычное сырьё не пытается раскрываться', async () => {
    const { pool, calls } = makePool(deep);
    const r = await svc(pool).expandNested('prep-sauce', EID, 1, 3);
    const oil = r.ingredients.find((i: any) => i.inventory_item_id === 'raw-oil');
    expect(oil.nested).toBeNull();
    // Проверяем и сам факт: за картой для сырья в базу ходить не должны —
    // иначе `nested: true` без спуска прошло бы незамеченным.
    const askedForOil = calls.some(c => /FROM tech_cards\s+WHERE output_item_id/.test(c.sql)
                                        && c.params[0] === 'raw-oil');
    expect(askedForOil).toBe(false);
  });

  it('у сырья nested именно null, а не произвольное значение', async () => {
    // `nested: true` вместо null сломало бы фронт: он проверяет наличие
    // объекта и попытался бы прочитать .ingredients у булева.
    const { pool } = makePool(deep);
    const r = await svc(pool).expandNested('prep-sauce', EID, 1, 3);
    const oil = r.ingredients.find((i: any) => i.inventory_item_id === 'raw-oil');
    expect(oil.nested === null).toBe(true);
  });

  it('цикл в данных не уходит в бесконечность и помечается', async () => {
    // Грязные данные: соус содержит сам себя. Сохранить такое нельзя,
    // но прочитать существующее — можно, и падать сервис не должен.
    const { pool } = makePool({
      cards: { 'p': { id: 'tc', name: 'Соус', output_quantity: '1' } },
      ings: { 'tc': [ing({ inventory_item_id: 'p', name: 'Соус', item_type: 'prepared' })] }
    });
    const r = await svc(pool).expandNested('p', EID, 1, 5);
    expect(r.ingredients[0].nested.cycle).toBe(true);
    expect(r.ingredients[0].nested.reason).toMatch(/[Цц]иклич/);
  });

  it('глубина ограничена сверху даже при огромном depth', async () => {
    // Длинная цепочка РАЗНЫХ заготовок: p0 → p1 → p2 → ... Защита от цикла
    // здесь не сработает (повторов нет), поэтому проверяется именно потолок.
    const cards: Record<string, any> = {};
    const ings: Record<string, any[]> = {};
    for (let i = 0; i < 12; i++) {
      cards[`p${i}`] = { id: `tc${i}`, name: `П${i}`, output_quantity: '1' };
      ings[`tc${i}`] = [ing({ inventory_item_id: `p${i + 1}`, name: `П${i + 1}`, item_type: 'prepared' })];
    }
    const { pool, calls } = makePool({ cards, ings });
    await svc(pool).expandNested('p0', EID, 1, 9999);
    // Потолок 5 уровней: запросов карт ровно столько, не больше.
    const cardQueries = calls.filter(c => /FROM tech_cards\s+WHERE output_item_id/.test(c.sql)).length;
    expect(cardQueries).toBeLessThanOrEqual(5);
  });

  it('глубина 5 — это именно пять уровней, а не меньше', async () => {
    const cards: Record<string, any> = {};
    const ings: Record<string, any[]> = {};
    for (let i = 0; i < 12; i++) {
      cards[`p${i}`] = { id: `tc${i}`, name: `П${i}`, output_quantity: '1' };
      ings[`tc${i}`] = [ing({ inventory_item_id: `p${i + 1}`, name: `П${i + 1}`, item_type: 'prepared' })];
    }
    const { pool } = makePool({ cards, ings });
    const r = await svc(pool).expandNested('p0', EID, 1, 5);
    let node = r, levels = 1;
    while (node.ingredients[0] && node.ingredients[0].nested) {
      node = node.ingredients[0].nested;
      levels++;
    }
    expect(levels).toBe(5);
  });
});

describe('Признак наличия вложенности в карточке', () => {
  it('состав карточки помечает строки, которые можно раскрыть', async () => {
    const { pool, calls } = makePool();
    const s = svc(pool);
    await (s as any).getCooking('mi-1', 'menu', EID);
    const q = calls.find(c => /FROM v_tech_card_ingredients/.test(c.sql));
    // Без этой проверки тест прошёл бы и когда запроса вообще нет:
    // «не нашли — значит нечего проверять» — зелёная галочка ни о чём.
    expect(q).toBeDefined();
    // Граница слова обязательна: без неё переименование алиаса в
    // has_nested_unused прошло бы как совпадение подстроки.
    expect(q!.sql).toMatch(/AS has_nested\b(?!_)/);
    // Проверять только item_type недостаточно: заготовка без действующей
    // карты раскрывать нечего, и шеврон вёл бы в пустоту.
    expect(q!.sql).toMatch(/FROM tech_cards t/);
    expect(q!.sql).toMatch(/t\.enterprise_id = \$2/);
    expect(q!.params[1]).toBe(EID);
  });
});
