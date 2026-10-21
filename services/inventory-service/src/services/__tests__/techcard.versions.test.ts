import { TechCardService } from '../techcard.service';

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

/** Клиент с журналом запросов — проверяем, что именно ушло в БД. */
function makeClient(overrides: Record<string, any> = {}) {
  const queries: { sql: string; params: any[] }[] = [];
  const client: any = {
    queries,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      for (const [pattern, result] of Object.entries(overrides)) {
        if (new RegExp(pattern).test(sql)) {
          return typeof result === 'function' ? result(params) : result;
        }
      }
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn()
  };
  return client;
}

function makeService(client: any) {
  const svc = new TechCardService('postgresql://test');
  (svc as any).pool = {
    connect: jest.fn(async () => client),
    query: client.query
  };
  return svc;
}

const sourceCard = {
  id: 'tc-old',
  menu_item_id: 'mi-1',
  enterprise_id: 'e-1',
  effective_from: '2026-01-01',
  yield_weight: '0.2',
  cooking_instructions: 'варить',
  name: 'Суп',
  output_item_id: null,
  output_quantity: '1'
};

describe('Версии техкарты — создание', () => {
  it('закрывает прежнюю версию днём раньше новой', async () => {
    // Без этого два периода пересекутся и списание возьмёт двойной состав
    const client = makeClient({
      'SELECT \\* FROM tech_cards': { rows: [sourceCard], rowCount: 1 },
      'INSERT INTO tech_cards': { rows: [{ ...sourceCard, id: 'tc-new', effective_from: '2026-06-01' }], rowCount: 1 },
      'FROM tech_card_ingredients WHERE tech_card_id': { rows: [], rowCount: 0 }
    });
    const svc = makeService(client);
    jest.spyOn(svc, 'getById').mockResolvedValue({ id: 'tc-new' } as any);

    await svc.createVersion('tc-old', { effectiveFrom: '2026-06-01' }, 'e-1');

    const close = client.queries.find((q: any) => /UPDATE tech_cards SET effective_to/.test(q.sql));
    expect(close).toBeDefined();
    expect(close.params[0]).toBe('2026-06-01');
    expect(close.sql).toMatch(/INTERVAL '1 day'/);
  });

  it('новая версия открывается бессрочной', async () => {
    const client = makeClient({
      'SELECT \\* FROM tech_cards': { rows: [sourceCard], rowCount: 1 },
      'INSERT INTO tech_cards': { rows: [{ id: 'tc-new' }], rowCount: 1 },
      'FROM tech_card_ingredients WHERE tech_card_id': { rows: [], rowCount: 0 }
    });
    const svc = makeService(client);
    jest.spyOn(svc, 'getById').mockResolvedValue({ id: 'tc-new' } as any);

    await svc.createVersion('tc-old', { effectiveFrom: '2026-06-01' }, 'e-1');

    const ins = client.queries.find((q: any) => /INSERT INTO tech_cards/.test(q.sql));
    expect(ins.sql).toMatch(/NULL\)/);
  });

  it('дата новой версии не может быть раньше текущей', async () => {
    // Иначе получился бы вывернутый период: effective_to < effective_from
    const client = makeClient({
      'SELECT \\* FROM tech_cards': { rows: [sourceCard], rowCount: 1 }
    });
    const svc = makeService(client);

    await expect(
      svc.createVersion('tc-old', { effectiveFrom: '2025-01-01' }, 'e-1')
    ).rejects.toThrow(/позже начала/);
  });

  it('состав копируется, если новый не задан', async () => {
    // Версия без ингредиентов ничего не спишет и тихо обнулит учёт
    const client = makeClient({
      'SELECT \\* FROM tech_cards': { rows: [sourceCard], rowCount: 1 },
      'INSERT INTO tech_cards': { rows: [{ id: 'tc-new' }], rowCount: 1 },
      'FROM tech_card_ingredients WHERE tech_card_id': {
        rows: [
          { inventory_item_id: 'i-1', quantity: '0.3', unit: 'kg', cold_loss_percent: '10', hot_loss_percent: '5', is_optional: false },
          { inventory_item_id: 'i-2', quantity: '0.1', unit: 'kg', cold_loss_percent: '0', hot_loss_percent: '0', is_optional: true }
        ],
        rowCount: 2
      }
    });
    const svc = makeService(client);
    jest.spyOn(svc, 'getById').mockResolvedValue({ id: 'tc-new' } as any);

    await svc.createVersion('tc-old', { effectiveFrom: '2026-06-01' }, 'e-1');

    const inserts = client.queries.filter((q: any) => /INSERT INTO tech_card_ingredients/.test(q.sql));
    expect(inserts).toHaveLength(2);
    // Потери переносятся как есть
    expect(inserts[0].params[4]).toBe('10');
    expect(inserts[0].params[5]).toBe('5');
    expect(inserts[1].params[6]).toBe(true);
  });

  it('новый состав заменяет прежний, а не добавляется к нему', async () => {
    const client = makeClient({
      'SELECT \\* FROM tech_cards': { rows: [sourceCard], rowCount: 1 },
      'INSERT INTO tech_cards': { rows: [{ id: 'tc-new' }], rowCount: 1 },
      'FROM tech_card_ingredients WHERE tech_card_id': { rows: [{ inventory_item_id: 'old' }], rowCount: 1 }
    });
    const svc = makeService(client);
    jest.spyOn(svc, 'getById').mockResolvedValue({ id: 'tc-new' } as any);

    await svc.createVersion('tc-old', {
      effectiveFrom: '2026-06-01',
      ingredients: [{ inventoryItemId: 'i-new', quantity: 1 }]
    }, 'e-1');

    const inserts = client.queries.filter((q: any) => /INSERT INTO tech_card_ingredients/.test(q.sql));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[1]).toBe('i-new');
  });

  it('исходная карта блокируется FOR UPDATE', async () => {
    // Две параллельные версии на одну дату иначе обе пройдут проверку
    const client = makeClient({
      'SELECT \\* FROM tech_cards': { rows: [sourceCard], rowCount: 1 },
      'INSERT INTO tech_cards': { rows: [{ id: 'tc-new' }], rowCount: 1 },
      'FROM tech_card_ingredients WHERE tech_card_id': { rows: [], rowCount: 0 }
    });
    const svc = makeService(client);
    jest.spyOn(svc, 'getById').mockResolvedValue({ id: 'tc-new' } as any);

    await svc.createVersion('tc-old', { effectiveFrom: '2026-06-01' }, 'e-1');

    const sel = client.queries.find((q: any) => /SELECT \* FROM tech_cards/.test(q.sql));
    expect(sel.sql).toMatch(/FOR UPDATE/);
  });

  it('всё происходит в одной транзакции', async () => {
    const client = makeClient({
      'SELECT \\* FROM tech_cards': { rows: [sourceCard], rowCount: 1 },
      'INSERT INTO tech_cards': { rows: [{ id: 'tc-new' }], rowCount: 1 },
      'FROM tech_card_ingredients WHERE tech_card_id': { rows: [], rowCount: 0 }
    });
    const svc = makeService(client);
    jest.spyOn(svc, 'getById').mockResolvedValue({ id: 'tc-new' } as any);

    await svc.createVersion('tc-old', { effectiveFrom: '2026-06-01' }, 'e-1');

    const sqls = client.queries.map((q: any) => q.sql);
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('сбой откатывает всё: прежняя версия не остаётся закрытой', async () => {
    // Иначе блюдо осталось бы вообще без действующей техкарты
    const client = makeClient({
      'SELECT \\* FROM tech_cards': { rows: [sourceCard], rowCount: 1 },
      'INSERT INTO tech_cards': () => { throw new Error('сбой вставки'); }
    });
    const svc = makeService(client);

    await expect(
      svc.createVersion('tc-old', { effectiveFrom: '2026-06-01' }, 'e-1')
    ).rejects.toThrow(/сбой вставки/);

    expect(client.queries.map((q: any) => q.sql)).toContain('ROLLBACK');
  });

  it('несуществующая карта возвращает null, а не падает', async () => {
    const client = makeClient({ 'SELECT \\* FROM tech_cards': { rows: [], rowCount: 0 } });
    const svc = makeService(client);

    const res = await svc.createVersion('нет-такой', { effectiveFrom: '2026-06-01' }, 'e-1');

    expect(res).toBeNull();
  });
});

describe('Версии техкарты — история', () => {
  it('возвращает версии от новых к старым', async () => {
    const client = makeClient({
      'FROM tech_cards': {
        rows: [
          { id: 'v2', effective_from: '2026-06-01', effective_to: null, is_current: true },
          { id: 'v1', effective_from: '2026-01-01', effective_to: '2026-05-31', is_current: false }
        ],
        rowCount: 2
      }
    });
    const svc = makeService(client);

    const res = await svc.getVersions('mi-1', 'e-1');

    expect(res).toHaveLength(2);
    expect(res[0].id).toBe('v2');
    const sel = client.queries.find((q: any) => /FROM tech_cards/.test(q.sql));
    expect(sel.sql).toMatch(/ORDER BY effective_from DESC/);
  });

  it('помечает действующую сегодня версию', async () => {
    const client = makeClient({ 'FROM tech_cards': { rows: [], rowCount: 0 } });
    const svc = makeService(client);

    await svc.getVersions('mi-1', 'e-1');

    const sel = client.queries.find((q: any) => /FROM tech_cards/.test(q.sql));
    expect(sel.sql).toMatch(/is_current/);
    expect(sel.sql).toMatch(/CURRENT_DATE/);
  });

  it('архивные версии не показываются', async () => {
    const client = makeClient({ 'FROM tech_cards': { rows: [], rowCount: 0 } });
    const svc = makeService(client);

    await svc.getVersions('mi-1', 'e-1');

    const sel = client.queries.find((q: any) => /FROM tech_cards/.test(q.sql));
    expect(sel.sql).toMatch(/is_active = true/);
  });
});
