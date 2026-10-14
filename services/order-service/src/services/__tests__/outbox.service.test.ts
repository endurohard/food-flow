import { OutboxService } from '../outbox.service';

jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

/**
 * Поддельный pg-клиент: записывает все SQL-запросы, чтобы тест мог
 * проверить не «вернулось ли что-то», а что именно ушло в БД.
 */
function makeClient(selectRows: any[] = []) {
  const queries: { sql: string; params: any[] }[] = [];
  return {
    queries,
    released: 0,
    query: jest.fn(async function (this: any, sql: string, params: any[] = []) {
      queries.push({ sql, params });
      if (/SELECT id, exchange, routing_key/.test(sql)) {
        return { rows: selectRows, rowCount: selectRows.length };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn()
  };
}

function makePool(client: any) {
  return { connect: jest.fn(async () => client) };
}

/** Брокер, который либо принимает, либо отказывает. */
function makeBroker(ok: boolean) {
  return { publishOrderEvent: jest.fn(async () => ok) } as any;
}

describe('OutboxService.enqueue', () => {
  it('пишет событие тем же client, что и бизнес-данные', async () => {
    // Смысл outbox: если enqueue возьмёт own connection из пула,
    // событие окажется вне транзакции заказа и гарантия исчезнет.
    const client = makeClient();
    const outbox = new OutboxService(makePool(client), makeBroker(true));

    await outbox.enqueue(client, {
      routingKey: 'order.confirmed',
      payload: { id: 'order-1' }
    });

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.queries[0].sql).toMatch(/INSERT INTO event_outbox/);
  });

  it('по умолчанию публикует в orders_exchange', async () => {
    const client = makeClient();
    const outbox = new OutboxService(makePool(client), makeBroker(true));

    await outbox.enqueue(client, { routingKey: 'order.confirmed', payload: {} });

    expect(client.queries[0].params[1]).toBe('orders_exchange');
  });

  it('payload сериализуется в JSON без потери полей', async () => {
    const client = makeClient();
    const outbox = new OutboxService(makePool(client), makeBroker(true));
    const payload = { id: 'o-1', total: 1234.56, items: [{ qty: 2 }] };

    await outbox.enqueue(client, { routingKey: 'order.confirmed', payload });

    expect(JSON.parse(client.queries[0].params[3])).toEqual(payload);
  });

  it('пустой enterpriseId пишется как NULL, а не как пустая строка', async () => {
    // enterprise_id — внешний ключ; пустая строка уронила бы вставку
    const client = makeClient();
    const outbox = new OutboxService(makePool(client), makeBroker(true));

    await outbox.enqueue(client, {
      routingKey: 'order.confirmed',
      payload: {},
      enterpriseId: ''
    });

    expect(client.queries[0].params[0]).toBeNull();
  });
});

describe('OutboxService.drainOnce — успешная отправка', () => {
  it('помечает событие sent и считает его отправленным', async () => {
    const client = makeClient([
      { id: 'e-1', exchange: 'orders_exchange', routing_key: 'order.confirmed', payload: {}, attempts: 0 }
    ]);
    const broker = makeBroker(true);
    const outbox = new OutboxService(makePool(client), broker);

    const res = await outbox.drainOnce();

    expect(res).toEqual({ sent: 1, failed: 0 });
    const upd = client.queries.find(q => /SET status = 'sent'/.test(q.sql));
    expect(upd).toBeDefined();
  });

  it('транзакция закрывается COMMIT, соединение возвращается в пул', async () => {
    const client = makeClient([
      { id: 'e-1', exchange: 'x', routing_key: 'order.confirmed', payload: {}, attempts: 0 }
    ]);
    const outbox = new OutboxService(makePool(client), makeBroker(true));

    await outbox.drainOnce();

    const sqls = client.queries.map(q => q.sql);
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('берёт строки через FOR UPDATE SKIP LOCKED', async () => {
    // Без SKIP LOCKED две реплики сервиса отправят одно событие дважды
    const client = makeClient([]);
    const outbox = new OutboxService(makePool(client), makeBroker(true));

    await outbox.drainOnce();

    const sel = client.queries.find(q => /SELECT id, exchange/.test(q.sql));
    expect(sel!.sql).toMatch(/FOR UPDATE SKIP LOCKED/);
  });

  it('не забирает события, время которых ещё не пришло', async () => {
    const client = makeClient([]);
    const outbox = new OutboxService(makePool(client), makeBroker(true));

    await outbox.drainOnce();

    const sel = client.queries.find(q => /SELECT id, exchange/.test(q.sql));
    expect(sel!.sql).toMatch(/next_attempt_at <= NOW\(\)/);
    expect(sel!.sql).toMatch(/status = 'pending'/);
  });

  it('отправляет в порядке создания: заказ не должен обогнать сам себя', async () => {
    const client = makeClient([]);
    const outbox = new OutboxService(makePool(client), makeBroker(true));

    await outbox.drainOnce();

    const sel = client.queries.find(q => /SELECT id, exchange/.test(q.sql));
    expect(sel!.sql).toMatch(/ORDER BY created_at ASC/);
  });

  it('публикует в тот exchange, что записан в событии', async () => {
    const client = makeClient([
      { id: 'e-1', exchange: 'custom_exchange', routing_key: 'order.paid', payload: { a: 1 }, attempts: 0 }
    ]);
    const broker = makeBroker(true);
    const outbox = new OutboxService(makePool(client), broker);

    await outbox.drainOnce();

    expect(broker.publishOrderEvent).toHaveBeenCalledWith('order.paid', { a: 1 }, 'custom_exchange');
  });
});

describe('OutboxService.drainOnce — отказ брокера', () => {
  it('событие остаётся pending и будет отправлено позже', async () => {
    // Ключевое свойство: отказ брокера не теряет событие
    const client = makeClient([
      { id: 'e-1', exchange: 'x', routing_key: 'order.confirmed', payload: {}, attempts: 0 }
    ]);
    const outbox = new OutboxService(makePool(client), makeBroker(false));

    const res = await outbox.drainOnce();

    expect(res).toEqual({ sent: 0, failed: 1 });
    const upd = client.queries.find(q => /SET status = \$2/.test(q.sql))!;
    expect(upd.params[1]).toBe('pending');
    expect(upd.params[2]).toBe(1);
  });

  it('задержка растёт экспоненциально: 2^attempts секунд', async () => {
    const cases = [
      { attempts: 0, expected: '2' },
      { attempts: 2, expected: '8' },
      { attempts: 5, expected: '64' }
    ];

    for (const c of cases) {
      const client = makeClient([
        { id: 'e-1', exchange: 'x', routing_key: 'order.confirmed', payload: {}, attempts: c.attempts }
      ]);
      const outbox = new OutboxService(makePool(client), makeBroker(false));

      await outbox.drainOnce();

      const upd = client.queries.find(q => /SET status = \$2/.test(q.sql))!;
      expect(upd.params[4]).toBe(c.expected);
    }
  });

  it('задержка не превышает часа даже при большом числе попыток', async () => {
    // Без ограничения 2^20 секунд = 12 дней, событие не ушло бы никогда.
    // attempts=19 → 2^20 = 1048576 с, то есть лимит обязан сработать.
    const client = makeClient([
      { id: 'e-1', exchange: 'x', routing_key: 'order.confirmed', payload: {}, attempts: 19 }
    ]);
    const outbox = new OutboxService(makePool(client), makeBroker(false));

    await outbox.drainOnce();

    const upd = client.queries.find(q => /SET status = \$2/.test(q.sql))!;
    expect(Number(upd.params[4])).toBe(3600);
  });

  it('после 10 попыток событие помечается failed и больше не берётся', async () => {
    const client = makeClient([
      { id: 'e-1', exchange: 'x', routing_key: 'order.confirmed', payload: {}, attempts: 9 }
    ]);
    const outbox = new OutboxService(makePool(client), makeBroker(false));

    await outbox.drainOnce();

    const upd = client.queries.find(q => /SET status = \$2/.test(q.sql))!;
    expect(upd.params[1]).toBe('failed');
    expect(upd.params[2]).toBe(10);
  });

  it('на девятой попытке событие ещё pending — лимит не сработал раньше срока', async () => {
    const client = makeClient([
      { id: 'e-1', exchange: 'x', routing_key: 'order.confirmed', payload: {}, attempts: 8 }
    ]);
    const outbox = new OutboxService(makePool(client), makeBroker(false));

    await outbox.drainOnce();

    const upd = client.queries.find(q => /SET status = \$2/.test(q.sql))!;
    expect(upd.params[1]).toBe('pending');
  });

  it('причина отказа сохраняется для разбора', async () => {
    const client = makeClient([
      { id: 'e-1', exchange: 'x', routing_key: 'order.confirmed', payload: {}, attempts: 0 }
    ]);
    const outbox = new OutboxService(makePool(client), makeBroker(false));

    await outbox.drainOnce();

    const upd = client.queries.find(q => /SET status = \$2/.test(q.sql))!;
    expect(typeof upd.params[3]).toBe('string');
    expect(upd.params[3].length).toBeGreaterThan(0);
  });
});

describe('OutboxService.drainOnce — устойчивость', () => {
  it('падение БД не роняет воркер: ошибка проглатывается, ROLLBACK сделан', async () => {
    const client = makeClient([]);
    client.query = jest.fn(async (sql: string) => {
      if (/SELECT id, exchange/.test(sql)) throw new Error('БД недоступна');
      return { rows: [], rowCount: 0 };
    }) as any;
    const outbox = new OutboxService(makePool(client), makeBroker(true));

    // Воркер крутится по таймеру: исключение наружу убило бы процесс
    await expect(outbox.drainOnce()).resolves.toEqual({ sent: 0, failed: 0 });
    expect(client.release).toHaveBeenCalled();
  });

  it('повторный вход не выполняется параллельно сам с собой', async () => {
    // Медленный проход + частый таймер иначе дали бы наложение проходов
    let releaseSelect!: () => void;
    let notifyReached!: () => void;
    const gate = new Promise<void>(r => { releaseSelect = r; });
    const selectReached = new Promise<void>(r => { notifyReached = r; });

    const client = makeClient([]);
    client.query = jest.fn(async (sql: string, params: any[] = []) => {
      client.queries.push({ sql, params });
      if (/SELECT id, exchange/.test(sql)) {
        notifyReached();   // проход дошёл до выборки
        await gate;        // и держится здесь
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }) as any;

    const outbox = new OutboxService(makePool(client), makeBroker(true));

    const first = outbox.drainOnce();
    await selectReached;                 // первый проход гарантированно внутри

    const second = await outbox.drainOnce();
    expect(second).toEqual({ sent: 0, failed: 0 });
    // Второй вход не начал свою транзакцию
    expect(client.queries.filter((q: any) => q.sql === 'BEGIN').length).toBe(1);

    releaseSelect();
    await first;
  });

  it('смешанная партия: часть отправлена, часть отложена', async () => {
    const client = makeClient([
      { id: 'ok-1', exchange: 'x', routing_key: 'order.confirmed', payload: {}, attempts: 0 },
      { id: 'ok-2', exchange: 'x', routing_key: 'order.confirmed', payload: {}, attempts: 0 }
    ]);
    let call = 0;
    const broker = { publishOrderEvent: jest.fn(async () => ++call === 1) } as any;
    const outbox = new OutboxService(makePool(client), broker);

    const res = await outbox.drainOnce();

    expect(res).toEqual({ sent: 1, failed: 1 });
  });

  it('пустая очередь не трогает БД лишними UPDATE', async () => {
    const client = makeClient([]);
    const outbox = new OutboxService(makePool(client), makeBroker(true));

    const res = await outbox.drainOnce();

    expect(res).toEqual({ sent: 0, failed: 0 });
    expect(client.queries.some(q => /UPDATE event_outbox/.test(q.sql))).toBe(false);
  });
});

describe('OutboxService.start/stop', () => {
  afterEach(() => jest.useRealTimers());

  it('воркер периодически опустошает очередь', async () => {
    jest.useFakeTimers();
    const client = makeClient([]);
    const outbox = new OutboxService(makePool(client), makeBroker(true));
    const spy = jest.spyOn(outbox, 'drainOnce');

    outbox.start(1000);
    jest.advanceTimersByTime(3000);

    expect(spy).toHaveBeenCalledTimes(3);
    outbox.stop();
  });

  it('повторный start не создаёт второй таймер', async () => {
    jest.useFakeTimers();
    const client = makeClient([]);
    const outbox = new OutboxService(makePool(client), makeBroker(true));
    const spy = jest.spyOn(outbox, 'drainOnce');

    outbox.start(1000);
    outbox.start(1000);
    jest.advanceTimersByTime(1000);

    expect(spy).toHaveBeenCalledTimes(1);
    outbox.stop();
  });

  it('после stop воркер не работает', async () => {
    jest.useFakeTimers();
    const client = makeClient([]);
    const outbox = new OutboxService(makePool(client), makeBroker(true));
    const spy = jest.spyOn(outbox, 'drainOnce');

    outbox.start(1000);
    outbox.stop();
    jest.advanceTimersByTime(5000);

    expect(spy).not.toHaveBeenCalled();
  });
});
