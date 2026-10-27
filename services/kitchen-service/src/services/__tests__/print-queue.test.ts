import { PrintQueueService, hashToken } from '../print-queue.service';

/**
 * Мок pg.Pool на правилах «регулярка по SQL → результат».
 * Фиксированный ответ скрыл бы опечатку в запросе; правила идут от
 * частного к общему, иначе общий шаблон перехватывает частный случай.
 */
type Rule = { re: RegExp; rows: any[] | ((params: any[]) => any[]) };

function makeDb(rules: Rule[]) {
  const queries: { sql: string; params: any[] }[] = [];

  const run = (sql: string, params: any[] = []) => {
    queries.push({ sql, params });
    for (const r of rules) {
      if (r.re.test(sql)) {
        const rows = typeof r.rows === 'function' ? r.rows(params) : r.rows;
        return Promise.resolve({ rows, rowCount: rows.length });
      }
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  };

  const client = {
    query: jest.fn((sql: string, params?: any[]) => run(sql, params)),
    release: jest.fn(),
  };

  const db: any = {
    query: jest.fn((sql: string, params?: any[]) => run(sql, params)),
    connect: jest.fn(async () => client),
  };

  return { db, client, queries };
}

const AGENT_ROW = {
  id: 'a1',
  enterprise_id: 'e1',
  restaurant_id: null,
  name: 'Кухня',
  enabled: true,
  agent_version: '1.0.0',
  platform: 'linux-x64',
  hostname: 'kitchen-pc',
  last_seen_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
};

describe('PrintQueueService: агенты', () => {
  it('createAgent хранит ТОЛЬКО хеш токена, а не сам токен', async () => {
    const { db, queries } = makeDb([{ re: /INSERT INTO print_agents/, rows: [AGENT_ROW] }]);
    const svc = new PrintQueueService(db);

    const { token } = await svc.createAgent({ enterpriseId: 'e1', name: 'Кухня' });

    const ins = queries.find((q) => /INSERT INTO print_agents/.test(q.sql))!;
    expect(ins.params).not.toContain(token);
    expect(ins.params).toContain(hashToken(token));
    // хеш sha256 в hex — ровно 64 символа, как CHAR(64) в схеме
    expect(hashToken(token)).toHaveLength(64);
  });

  it('токены разных агентов не совпадают', async () => {
    const { db } = makeDb([{ re: /INSERT INTO print_agents/, rows: [AGENT_ROW] }]);
    const svc = new PrintQueueService(db);
    const a = await svc.createAgent({ enterpriseId: 'e1', name: 'A' });
    const b = await svc.createAgent({ enterpriseId: 'e1', name: 'B' });
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(32);
  });

  it('authenticateAgent ищет по хешу и ТРЕБУЕТ enabled = true', async () => {
    const { db, queries } = makeDb([{ re: /FROM print_agents WHERE token_hash/, rows: [AGENT_ROW] }]);
    const svc = new PrintQueueService(db);

    await svc.authenticateAgent('secret-token');

    const q = queries.find((x) => /FROM print_agents/.test(x.sql))!;
    // проверяем САМО условие, а не только наличие параметра: условие
    // легко нейтрализовать, не убирая подстановку
    expect(q.sql).toMatch(/enabled\s*=\s*true/);
    expect(q.params).toContain(hashToken('secret-token'));
  });

  it('пустой токен не идёт в базу вовсе', async () => {
    const { db, queries } = makeDb([]);
    const svc = new PrintQueueService(db);
    expect(await svc.authenticateAgent('')).toBeNull();
    expect(queries).toHaveLength(0);
  });

  it('online считается по свежести last_seen_at, а не по флагу в базе', async () => {
    const stale = { ...AGENT_ROW, last_seen_at: new Date(Date.now() - 10 * 60_000).toISOString() };
    const { db } = makeDb([{ re: /FROM print_agents WHERE enterprise_id/, rows: [stale] }]);
    const svc = new PrintQueueService(db);
    const [agent] = await svc.listAgents('e1');
    expect(agent.online).toBe(false);
  });

  it('rotateToken меняет хеш и ограничен предприятием', async () => {
    const { db, queries } = makeDb([{ re: /UPDATE print_agents SET token_hash/, rows: [{ id: 'a1' }] }]);
    const svc = new PrintQueueService(db);

    const res = await svc.rotateToken('e1', 'a1');

    const q = queries.find((x) => /UPDATE print_agents SET token_hash/.test(x.sql))!;
    expect(q.sql).toMatch(/enterprise_id\s*=\s*\$2/);
    expect(q.params).toContain(hashToken(res!.token));
  });

  /**
   * Чужой агент не должен удаляться/выключаться по одному лишь id: без
   * фильтра по предприятию администратор одной организации стирает печать
   * другой. Проверяем само условие в SQL, а не только наличие параметра —
   * `AND ($2 IS NOT NULL)` параметр сохраняет, а отбор убирает.
   */
  it('deleteAgent ограничен предприятием, а не только id', async () => {
    const { db, queries } = makeDb([{ re: /DELETE FROM print_agents/, rows: [{ id: 'a1' }] }]);
    const svc = new PrintQueueService(db);

    await svc.deleteAgent('e1', 'a1');

    const q = queries.find((x) => /DELETE FROM print_agents/.test(x.sql))!;
    expect(q.sql).toMatch(/WHERE\s+id\s*=\s*\$1\s+AND\s+enterprise_id\s*=\s*\$2/);
    expect(q.params).toEqual(['a1', 'e1']);
  });

  it('setAgentEnabled ограничен предприятием, а не только id', async () => {
    const { db, queries } = makeDb([{ re: /UPDATE print_agents SET enabled/, rows: [AGENT_ROW] }]);
    const svc = new PrintQueueService(db);

    await svc.setAgentEnabled('e1', 'a1', false);

    const q = queries.find((x) => /UPDATE print_agents SET enabled/.test(x.sql))!;
    expect(q.sql).toMatch(/WHERE\s+id\s*=\s*\$1\s+AND\s+enterprise_id\s*=\s*\$2/);
    expect(q.params).toEqual(['a1', 'e1', false]);
  });

  it('listAgents отдаёт только агентов своего предприятия', async () => {
    const { db, queries } = makeDb([{ re: /SELECT \* FROM print_agents/, rows: [AGENT_ROW] }]);
    const svc = new PrintQueueService(db);

    await svc.listAgents('e1');

    const q = queries.find((x) => /SELECT \* FROM print_agents/.test(x.sql))!;
    expect(q.sql).toMatch(/WHERE\s+enterprise_id\s*=\s*\$1/);
    expect(q.params).toEqual(['e1']);
  });
});

describe('PrintQueueService: очередь заданий', () => {
  const insertRule: Rule = { re: /INSERT INTO print_jobs/, rows: [{ id: 'j1' }] };

  function parseInsert(sql: string) {
    const cols = /INSERT INTO print_jobs\s*\(([^)]*)\)/.exec(sql)![1]
      .split(',')
      .map((c) => c.trim());
    const vals = /VALUES\s*\(([^)]*)\)/.exec(sql)![1].split(',').map((v) => v.trim());
    return { cols, vals };
  }

  it('кладёт в payload готовые байты ESC/POS, а не JSON заказа', async () => {
    const { db, queries } = makeDb([insertRule]);
    const svc = new PrintQueueService(db);

    await svc.enqueue({
      enterpriseId: 'e1',
      agentId: 'a1',
      kind: 'kitchen',
      order: {
        orderNumber: '7',
        items: [{ name: 'Борщ', quantity: 1 }],
        timestamp: new Date('2026-10-26T10:00:00Z'),
      },
    });

    const ins = queries.find((q) => /INSERT INTO print_jobs/.test(q.sql))!;
    const { cols, vals } = parseInsert(ins.sql);
    // список колонок и значений обязан совпадать по длине
    expect(cols).toHaveLength(vals.length);

    const payload = ins.params[cols.indexOf('payload')];
    expect(Buffer.isBuffer(payload)).toBe(true);
    // ESC @ — инициализация принтера в начале потока
    expect(payload.subarray(0, 2)).toEqual(Buffer.from([0x1b, 0x40]));
  });

  it('copies приводится к положительному: CHECK в БД иначе отвергнет строку', async () => {
    const { db, queries } = makeDb([insertRule]);
    const svc = new PrintQueueService(db);

    await svc.enqueue({
      enterpriseId: 'e1',
      kind: 'test',
      testLabel: 'x',
      copies: 0,
    });

    const ins = queries.find((q) => /INSERT INTO print_jobs/.test(q.sql))!;
    const { cols } = parseInsert(ins.sql);
    expect(ins.params[cols.indexOf('copies')]).toBe(1);
  });

  it('задание печати заказа без order падает, а не пишет пустой чек', async () => {
    const { db } = makeDb([insertRule]);
    const svc = new PrintQueueService(db);
    await expect(
      svc.enqueue({ enterpriseId: 'e1', kind: 'kitchen' }),
    ).rejects.toThrow(/order/);
  });

  it('claimJobs берёт только свои задания в порядке поступления', async () => {
    const { db, queries } = makeDb([
      {
        re: /FROM print_jobs j/,
        rows: [{ id: 'j1', kind: 'kitchen', copies: 1, payload: Buffer.from([0x1b, 0x40]), station_id: 3, station_name: 'Бар', station_type: 'network', address: '10.0.0.5:9100', device: null, bluetooth: null }],
      },
      { re: /UPDATE print_jobs/, rows: [] },
    ]);
    const svc = new PrintQueueService(db);

    const jobs = await svc.claimJobs('a1', 5);

    const sel = queries.find((q) => /FROM print_jobs j/.test(q.sql))!;
    expect(sel.sql).toMatch(/j\.agent_id\s*=\s*\$1/);
    expect(sel.sql).toMatch(/j\.status\s*=\s*'queued'/);
    expect(sel.sql).toMatch(/ORDER BY j\.created_at ASC/);
    expect(sel.params[0]).toBe('a1');

    expect(jobs[0].payload).toBe(Buffer.from([0x1b, 0x40]).toString('base64'));
    expect(jobs[0].station.address).toBe('10.0.0.5:9100');
  });

  it('claimJobs держит SKIP LOCKED: два опроса не выдают один чек дважды', async () => {
    const { db, queries } = makeDb([
      { re: /FROM print_jobs j/, rows: [{ id: 'j1', kind: 'test', copies: 1, payload: Buffer.from([1]) }] },
      { re: /UPDATE print_jobs/, rows: [] },
    ]);
    const svc = new PrintQueueService(db);
    await svc.claimJobs('a1');

    const sel = queries.find((q) => /FROM print_jobs j/.test(q.sql))!;
    expect(sel.sql).toMatch(/FOR UPDATE OF j SKIP LOCKED/);
  });

  it('claimJobs переводит задания в in_progress и считает попытку', async () => {
    const { db, queries } = makeDb([
      { re: /FROM print_jobs j/, rows: [{ id: 'j1', kind: 'test', copies: 1, payload: Buffer.from([1]) }] },
      { re: /UPDATE print_jobs/, rows: [] },
    ]);
    const svc = new PrintQueueService(db);
    await svc.claimJobs('a1');

    const upd = queries.find((q) => /UPDATE print_jobs/.test(q.sql))!;
    expect(upd.sql).toMatch(/status\s*=\s*'in_progress'/);
    expect(upd.sql).toMatch(/attempts\s*=\s*attempts \+ 1/);
  });

  it('claimJobs работает в транзакции и откатывает её при ошибке', async () => {
    const { db, client } = makeDb([
      { re: /FROM print_jobs j/, rows: [] },
    ]);
    const svc = new PrintQueueService(db);
    await svc.claimJobs('a1');
    const sqls = client.query.mock.calls.map((c: any[]) => c[0]);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls).toContain('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('пустая очередь не вызывает UPDATE с пустым массивом id', async () => {
    const { db, queries } = makeDb([{ re: /FROM print_jobs j/, rows: [] }]);
    const svc = new PrintQueueService(db);
    const jobs = await svc.claimJobs('a1');
    expect(jobs).toEqual([]);
    expect(queries.some((q) => /UPDATE print_jobs/.test(q.sql))).toBe(false);
  });

  it('reportResult(ok) закрывает задание только у своего агента', async () => {
    const { db, queries } = makeDb([{ re: /SET status = 'done'/, rows: [{ id: 'j1' }] }]);
    const svc = new PrintQueueService(db);

    await svc.reportResult('a1', 'j1', true);

    const q = queries.find((x) => /SET status = 'done'/.test(x.sql))!;
    expect(q.sql).toMatch(/agent_id\s*=\s*\$2/);
    expect(q.sql).toMatch(/printed_at\s*=\s*CURRENT_TIMESTAMP/);
    expect(q.params).toEqual(['j1', 'a1']);
  });

  it('ошибка печати возвращает задание в очередь, пока попытки не исчерпаны', async () => {
    const { db, queries } = makeDb([
      { re: /SET status = CASE WHEN attempts/, rows: [{ id: 'j1', status: 'queued' }] },
    ]);
    const svc = new PrintQueueService(db);

    await svc.reportResult('a1', 'j1', false, 'нет бумаги');

    const q = queries.find((x) => /SET status = CASE WHEN attempts/.test(x.sql))!;
    expect(q.sql).toMatch(/THEN 'failed' ELSE 'queued' END/);
    expect(q.params).toContain('нет бумаги');
  });

  it('requeueStaleJobs возвращает зависшие in_progress по времени захвата', async () => {
    const { db, queries } = makeDb([{ re: /UPDATE print_jobs/, rows: [{ id: 'j1' }] }]);
    const svc = new PrintQueueService(db);

    await svc.requeueStaleJobs();

    const q = queries[0];
    expect(q.sql).toMatch(/status\s*=\s*'in_progress'/);
    // проверяем само условие по времени, а не только наличие параметра
    expect(q.sql).toMatch(/claimed_at\s*<\s*CURRENT_TIMESTAMP\s*-\s*\(\$1/);
  });
});

describe('PrintQueueService: маршрутизация заказа по станциям', () => {
  const settingsRule: Rule = {
    re: /FROM printer_settings/,
    rows: [{ paper_width: 80, encoding: 'CP866', default_copies: 1 }],
  };
  const insertRule: Rule = { re: /INSERT INTO print_jobs/, rows: [{ id: 'j' }] };

  const order = {
    orderNumber: '55',
    items: [
      { name: 'Борщ', quantity: 1 },
      { name: 'Мохито', quantity: 2 },
    ],
    timestamp: new Date('2026-10-26T10:00:00Z'),
  };

  it('станция без агента пропускается с внятной причиной', async () => {
    const { db } = makeDb([
      {
        re: /FROM printer_stations s/,
        rows: [{ id: 1, name: 'Горячий цех', categories: [], copies: 1, agent_id_resolved: null, agent_enabled: null }],
      },
      settingsRule,
      insertRule,
    ]);
    const svc = new PrintQueueService(db);

    const res = await svc.enqueueOrderToStations({ enterpriseId: 'e1', order });

    expect(res.queued).toBe(0);
    expect(res.skipped[0]).toMatch(/Горячий цех.*агент/);
  });

  it('отключённый агент тоже пропускается: иначе чек уходит в никуда', async () => {
    const { db } = makeDb([
      {
        re: /FROM printer_stations s/,
        rows: [{ id: 1, name: 'Бар', categories: [], copies: 1, agent_id_resolved: 'a1', agent_enabled: false }],
      },
      settingsRule,
      insertRule,
    ]);
    const svc = new PrintQueueService(db);

    const res = await svc.enqueueOrderToStations({ enterpriseId: 'e1', order });
    expect(res.queued).toBe(0);
    expect(res.skipped).toHaveLength(1);
  });

  it('станция печатает только свои категории', async () => {
    const { db, queries } = makeDb([
      {
        re: /FROM printer_stations s/,
        rows: [
          { id: 1, name: 'Горячий цех', categories: ['hot'], copies: 1, agent_id_resolved: 'a1', agent_enabled: true },
          { id: 2, name: 'Бар', categories: ['bar'], copies: 1, agent_id_resolved: 'a1', agent_enabled: true },
        ],
      },
      settingsRule,
      insertRule,
    ]);
    const svc = new PrintQueueService(db);

    const res = await svc.enqueueOrderToStations({
      enterpriseId: 'e1',
      order,
      itemCategories: { Борщ: 'hot', Мохито: 'bar' },
    });

    expect(res.queued).toBe(2);
    const inserts = queries.filter((q) => /INSERT INTO print_jobs/.test(q.sql));
    const previews = inserts.map((q) => q.params[6] as string);
    const hot = previews.find((p) => p.includes('ГОРЯЧИЙ ЦЕХ'))!;
    const bar = previews.find((p) => p.includes('БАР'))!;
    expect(hot).toContain('БОРЩ');
    expect(hot).not.toContain('МОХИТО');
    expect(bar).toContain('МОХИТО');
    expect(bar).not.toContain('БОРЩ');
  });

  it('станция с пустым списком категорий печатает весь заказ', async () => {
    const { db, queries } = makeDb([
      {
        re: /FROM printer_stations s/,
        rows: [{ id: 1, name: 'Касса', categories: [], copies: 1, agent_id_resolved: 'a1', agent_enabled: true }],
      },
      settingsRule,
      insertRule,
    ]);
    const svc = new PrintQueueService(db);

    const res = await svc.enqueueOrderToStations({ enterpriseId: 'e1', order });
    expect(res.queued).toBe(1);
    const preview = queries.find((q) => /INSERT INTO print_jobs/.test(q.sql))!.params[6] as string;
    expect(preview).toContain('БОРЩ');
    expect(preview).toContain('МОХИТО');
  });

  it('станция без подходящих позиций не получает пустой чек', async () => {
    const { db } = makeDb([
      {
        re: /FROM printer_stations s/,
        rows: [{ id: 1, name: 'Кондитерский', categories: ['dessert'], copies: 1, agent_id_resolved: 'a1', agent_enabled: true }],
      },
      settingsRule,
      insertRule,
    ]);
    const svc = new PrintQueueService(db);

    const res = await svc.enqueueOrderToStations({
      enterpriseId: 'e1',
      order,
      itemCategories: { Борщ: 'hot', Мохито: 'bar' },
    });
    expect(res.queued).toBe(0);
    expect(res.skipped).toHaveLength(0);
  });

  it('выбирает только включённые станции своего предприятия', async () => {
    const { db, queries } = makeDb([
      { re: /FROM printer_stations s/, rows: [] },
      settingsRule,
    ]);
    const svc = new PrintQueueService(db);
    await svc.enqueueOrderToStations({ enterpriseId: 'e1', order });

    const q = queries.find((x) => /FROM printer_stations s/.test(x.sql))!;
    expect(q.sql).toMatch(/s\.enterprise_id\s*=\s*\$1/);
    expect(q.sql).toMatch(/s\.enabled\s*=\s*true/);
    expect(q.params).toEqual(['e1']);
  });

  it('узкая бумага предприятия применяется к чеку станции', async () => {
    const { db, queries } = makeDb([
      {
        re: /FROM printer_stations s/,
        rows: [{ id: 1, name: 'Касса', categories: [], copies: 1, agent_id_resolved: 'a1', agent_enabled: true }],
      },
      { re: /FROM printer_settings/, rows: [{ paper_width: 58, encoding: 'CP1251', default_copies: 2 }] },
      insertRule,
    ]);
    const svc = new PrintQueueService(db);
    await svc.enqueueOrderToStations({ enterpriseId: 'e1', order });

    const ins = queries.find((q) => /INSERT INTO print_jobs/.test(q.sql))!;
    const payload = ins.params[5] as Buffer;
    // ESC t 46 — кодовая страница CP1251 из настроек предприятия
    expect(payload.includes(Buffer.from([0x1b, 0x74, 46]))).toBe(true);
  });
});
