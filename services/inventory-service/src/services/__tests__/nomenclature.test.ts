import { NomenclatureService } from '../nomenclature.service';

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

const EID = 'ent-1';
const OTHER = 'ent-2';

/**
 * Мок БД по правилам «регулярка SQL -> результат». Фиксированный ответ
 * здесь не годится: опечатка в запросе или потерянное условие
 * enterprise_id прошли бы незамеченными.
 */
function makePool(state: {
  groups?: any[];
  items?: any[];
} = {}) {
  const groups = state.groups ?? [];
  const items = state.items ?? [];
  const calls: { sql: string; params: any[] }[] = [];

  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });

    // Проверка владения группой
    if (/SELECT 1 FROM nomenclature_groups WHERE id = \$1 AND enterprise_id = \$2/.test(sql)) {
      const found = groups.filter(g => g.id === params[0] && g.enterprise_id === params[1]);
      return { rows: found.map(() => ({ '?column?': 1 })), rowCount: found.length };
    }

    // Подъём по предкам (защита от цикла)
    if (/WITH RECURSIVE up AS/.test(sql)) {
      const chain: string[] = [];
      let cur = groups.find(g => g.id === params[0]);
      while (cur) {
        chain.push(cur.id);
        cur = cur.parent_id ? groups.find(g => g.id === cur!.parent_id) : undefined;
      }
      const hit = chain.includes(params[1]);
      return { rows: hit ? [{ id: params[1] }] : [], rowCount: hit ? 1 : 0 };
    }

    // Список групп — обязан фильтровать по предприятию и по deleted_at
    if (/FROM nomenclature_groups\s+WHERE enterprise_id = \$1/.test(sql)) {
      const onlyAlive = /deleted_at IS NULL/.test(sql);
      const rows = groups
        .filter(g => g.enterprise_id === params[0])
        .filter(g => (onlyAlive ? !g.deleted_at : true));
      return { rows, rowCount: rows.length };
    }

    // Список позиций из представления
    if (/FROM v_nomenclature/.test(sql)) {
      const onlyAlive = /deleted_at IS NULL/.test(sql);
      let rows = items.filter(i => i.enterprise_id === params[0]);
      if (onlyAlive) rows = rows.filter(i => !i.deleted_at);
      const typeIdx = /item_type = \$(\d+)/.exec(sql);
      if (typeIdx) rows = rows.filter(i => i.item_type === params[Number(typeIdx[1]) - 1]);
      const grpIdx = /nomenclature_group_id = \$(\d+)/.exec(sql);
      if (grpIdx) rows = rows.filter(i => i.nomenclature_group_id === params[Number(grpIdx[1]) - 1]);
      return { rows, rowCount: rows.length };
    }

    if (/^UPDATE (menu_items|inventory_items)/.test(sql.trim())) {
      return { rows: [{ id: params[params.length - 2] }], rowCount: 1 };
    }
    if (/^INSERT INTO nomenclature_groups/.test(sql.trim())) {
      return { rows: [{ id: 'new-group' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  return { pool: { query, connect: jest.fn(), end: jest.fn() }, calls, query };
}

function svc(pool: any): NomenclatureService {
  const s = new NomenclatureService('postgres://test');
  (s as any).pool = pool;
  return s;
}

describe('NomenclatureService — мультитенантность', () => {
  it('список групп запрашивается только по своему предприятию', async () => {
    const { pool, calls } = makePool({
      groups: [
        { id: 'g1', enterprise_id: EID, parent_id: null, name: 'Своя', deleted_at: null },
        { id: 'g2', enterprise_id: OTHER, parent_id: null, name: 'Чужая', deleted_at: null }
      ]
    });
    const rows = await svc(pool).listGroups(EID);
    expect(rows.map(r => r.name)).toEqual(['Своя']);
    // Условие по предприятию должно быть в самом SQL, а не в коде после выборки
    expect(calls[0].sql).toMatch(/enterprise_id = \$1/);
    expect(calls[0].params[0]).toBe(EID);
  });

  it('позиции чужого предприятия не попадают в дерево', async () => {
    const { pool } = makePool({
      items: [
        { id: 'i1', enterprise_id: EID, item_type: 'dish', name: 'Своё', nomenclature_group_id: null },
        { id: 'i2', enterprise_id: OTHER, item_type: 'dish', name: 'Чужое', nomenclature_group_id: null }
      ]
    });
    const items = await svc(pool).listItems(EID);
    expect(items.map(i => i.name)).toEqual(['Своё']);
  });

  it('позицию нельзя перенести в группу другого предприятия', async () => {
    const { pool } = makePool({
      groups: [{ id: 'g-other', enterprise_id: OTHER, parent_id: null, name: 'Чужая', deleted_at: null }]
    });
    await expect(svc(pool).updateItem('i1', 'menu', { groupId: 'g-other' }, EID))
      .rejects.toThrow('GROUP_NOT_FOUND');
  });

  it('группу нельзя создать под чужим родителем', async () => {
    const { pool } = makePool({
      groups: [{ id: 'g-other', enterprise_id: OTHER, parent_id: null, name: 'Чужая', deleted_at: null }]
    });
    await expect(svc(pool).createGroup({ name: 'Новая', parentId: 'g-other' }, EID))
      .rejects.toThrow('PARENT_NOT_FOUND');
  });

  it('UPDATE позиции всегда ограничен предприятием', async () => {
    const { pool, calls } = makePool();
    await svc(pool).updateItem('i1', 'menu', { name: 'Новое имя' }, EID);
    const upd = calls.find(c => /^UPDATE menu_items/.test(c.sql.trim()))!;
    expect(upd.sql).toMatch(/enterprise_id = \$\d+/);
    expect(upd.params).toContain(EID);
  });
});

describe('NomenclatureService — защита дерева от циклов', () => {
  const groups = [
    { id: 'a', enterprise_id: EID, parent_id: null, name: 'A', deleted_at: null },
    { id: 'b', enterprise_id: EID, parent_id: 'a', name: 'B', deleted_at: null },
    { id: 'c', enterprise_id: EID, parent_id: 'b', name: 'C', deleted_at: null }
  ];

  it('группу нельзя перенести в саму себя', async () => {
    const { pool } = makePool({ groups });
    await expect(svc(pool).updateGroup('a', { parentId: 'a' }, EID)).rejects.toThrow('CYCLE');
  });

  it('группу нельзя перенести в собственного внука (цикл длиной 3)', async () => {
    // Этот случай CHECK в БД не ловит: он видит только одну строку.
    const { pool } = makePool({ groups });
    await expect(svc(pool).updateGroup('a', { parentId: 'c' }, EID)).rejects.toThrow('CYCLE');
  });

  it('перенос в независимую ветку разрешён', async () => {
    const { pool } = makePool({
      groups: [...groups, { id: 'd', enterprise_id: EID, parent_id: null, name: 'D', deleted_at: null }]
    });
    await expect(svc(pool).updateGroup('c', { parentId: 'd' }, EID)).resolves.toBeDefined();
  });

  it('isDescendantOf поднимается по всей цепочке предков', async () => {
    const { pool } = makePool({ groups });
    await expect(svc(pool).isDescendantOf('c', 'a')).resolves.toBe(true);
    await expect(svc(pool).isDescendantOf('a', 'c')).resolves.toBe(false);
  });
});

describe('NomenclatureService — сборка дерева', () => {
  const groups = [
    { id: 'g1', enterprise_id: EID, parent_id: null, name: 'Заготовки', display_order: 0, deleted_at: null },
    { id: 'g2', enterprise_id: EID, parent_id: 'g1', name: 'Соусы', display_order: 1, deleted_at: null }
  ];
  const items = [
    { id: 'i1', enterprise_id: EID, nomenclature_group_id: 'g2', item_type: 'prepared', name: 'Соус тар-тар', deleted_at: null },
    { id: 'i2', enterprise_id: EID, nomenclature_group_id: null, item_type: 'dish', name: 'Бургер', deleted_at: null }
  ];

  it('вложенность групп сохраняется, позиции ложатся в свою группу', async () => {
    const { pool } = makePool({ groups, items });
    const tree = await svc(pool).getTree(EID);
    expect(tree.groups).toHaveLength(1);
    expect(tree.groups[0].name).toBe('Заготовки');
    expect(tree.groups[0].children).toHaveLength(1);
    expect(tree.groups[0].children[0].items.map((i: any) => i.name)).toEqual(['Соус тар-тар']);
  });

  it('позиция без группы не теряется — уходит в ungrouped', async () => {
    const { pool } = makePool({ groups, items });
    const tree = await svc(pool).getTree(EID);
    expect(tree.ungrouped.map((i: any) => i.name)).toEqual(['Бургер']);
  });

  it('позиция в скрытой группе не исчезает: узел всплывает в корень', async () => {
    // Группа удалена и в выборку не попала — если бы код молча отбрасывал
    // такие позиции, они пропали бы с экрана без единой ошибки.
    const { pool } = makePool({
      groups: [{ id: 'g1', enterprise_id: EID, parent_id: 'gone', name: 'Сирота', display_order: 0, deleted_at: null }],
      items: [{ id: 'i1', enterprise_id: EID, nomenclature_group_id: 'g1', item_type: 'dish', name: 'Блюдо', deleted_at: null }]
    });
    const tree = await svc(pool).getTree(EID);
    expect(tree.groups).toHaveLength(1);
    expect(tree.groups[0].items.map((i: any) => i.name)).toEqual(['Блюдо']);
  });

  it('фильтр по типу доходит до SQL, а не отрабатывает в памяти', async () => {
    const { pool, calls } = makePool({ groups, items });
    await svc(pool).getTree(EID, { itemType: 'prepared' });
    const sel = calls.find(c => /FROM v_nomenclature/.test(c.sql))!;
    expect(sel.sql).toMatch(/item_type = \$\d+/);
    expect(sel.params).toContain('prepared');
  });
});

describe('NomenclatureService — мягкое удаление', () => {
  it('по умолчанию удалённые позиции скрыты', async () => {
    const { pool, calls } = makePool({
      items: [
        { id: 'i1', enterprise_id: EID, item_type: 'dish', name: 'Живое', nomenclature_group_id: null, deleted_at: null },
        { id: 'i2', enterprise_id: EID, item_type: 'dish', name: 'Удалённое', nomenclature_group_id: null, deleted_at: '2026-01-01' }
      ]
    });
    const items = await svc(pool).listItems(EID);
    expect(items.map(i => i.name)).toEqual(['Живое']);
    expect(calls[0].sql).toMatch(/deleted_at IS NULL/);
  });

  it('includeDeleted показывает удалённые', async () => {
    const { pool } = makePool({
      items: [
        { id: 'i1', enterprise_id: EID, item_type: 'dish', name: 'Живое', nomenclature_group_id: null, deleted_at: null },
        { id: 'i2', enterprise_id: EID, item_type: 'dish', name: 'Удалённое', nomenclature_group_id: null, deleted_at: '2026-01-01' }
      ]
    });
    const items = await svc(pool).listItems(EID, { includeDeleted: true });
    expect(items.map(i => i.name)).toEqual(['Живое', 'Удалённое']);
  });

  it('удаление помечает deleted_at, а не стирает строку', async () => {
    const { pool, calls } = makePool();
    await svc(pool).deleteItem('i1', 'inventory', EID);
    const upd = calls.find(c => /inventory_items/.test(c.sql))!;
    expect(upd.sql).toMatch(/SET deleted_at = CURRENT_TIMESTAMP/);
    expect(upd.sql).not.toMatch(/DELETE FROM/);
  });

  it('повторное удаление не проходит (условие deleted_at IS NULL)', async () => {
    const { pool, calls } = makePool();
    await svc(pool).deleteItem('i1', 'menu', EID);
    expect(calls[0].sql).toMatch(/deleted_at IS NULL/);
  });
});

describe('NomenclatureService — адресация источника', () => {
  it('блюдо правится в menu_items', async () => {
    const { pool, calls } = makePool();
    await svc(pool).updateItem('i1', 'menu', { name: 'X' }, EID);
    expect(calls[0].sql).toMatch(/UPDATE menu_items/);
  });

  it('позиция склада правится в inventory_items', async () => {
    const { pool, calls } = makePool();
    await svc(pool).updateItem('i1', 'inventory', { name: 'X' }, EID);
    expect(calls[0].sql).toMatch(/UPDATE inventory_items/);
  });

  it('поле «место приготовления» не уходит в таблицу склада', async () => {
    // prep_station_id есть только у menu_items: отправка его в inventory_items
    // дала бы 500 «column does not exist».
    const { pool, calls } = makePool();
    await svc(pool).updateItem('i1', 'inventory', { prepStationId: 'st-1', name: 'X' }, EID);
    expect(calls[0].sql).not.toMatch(/prep_station_id/);
  });

  it('единица измерения не правится у блюда через этот сервис', async () => {
    const { pool, calls } = makePool();
    await svc(pool).updateItem('i1', 'menu', { unit: 'кг', name: 'X' }, EID);
    expect(calls[0].sql).not.toMatch(/unit =/);
  });

  it('пустой набор полей не порождает запрос', async () => {
    const { pool, calls } = makePool();
    const r = await svc(pool).updateItem('i1', 'menu', {}, EID);
    expect(r).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
