import { OrderEventsConsumer } from '../order-events.consumer';

jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.mock('../../config', () => ({
  config: { rabbitmq: { url: 'amqp://test' }, autoEarnPoints: true }
}));

/** Пул с управляемыми ответами на три запроса consumer'а. */
function makePool(opts: {
  order?: any;
  profile?: any;
  alreadyEarned?: boolean;
}) {
  const queries: string[] = [];
  return {
    queries,
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
      if (/FROM orders WHERE id/.test(sql)) {
        return opts.order
          ? { rows: [opts.order], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (/FROM customer_profiles/.test(sql)) {
        return opts.profile
          ? { rows: [opts.profile], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (/FROM loyalty_transactions/.test(sql)) {
        return opts.alreadyEarned
          ? { rows: [{ '?column?': 1 }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    })
  };
}

const paidOrder = {
  id: 'o-1',
  customer_id: 'u-1',
  total: '1000.00',
  enterprise_id: 'e-1'
};
const profile = { id: 'p-1' };

function makeCrm() {
  return { earnPoints: jest.fn(async () => ({ points: 100 })) } as any;
}

/** Вызов приватного обработчика — публичный путь идёт через RabbitMQ. */
function handle(consumer: any, event: any) {
  return consumer.handleOrderClosed(event);
}

describe('CRM consumer — начисление баллов', () => {
  it('начисляет баллы за закрытый заказ', async () => {
    const pool = makePool({ order: paidOrder, profile });
    const crm = makeCrm();
    const c = new OrderEventsConsumer(pool, crm);

    await handle(c, { id: 'o-1' });

    expect(crm.earnPoints).toHaveBeenCalledWith('p-1', 'o-1', 1000, 'e-1');
  });

  it('сумма берётся из БД, а не из события: событие можно подделать', async () => {
    const pool = makePool({ order: paidOrder, profile });
    const crm = makeCrm();
    const c = new OrderEventsConsumer(pool, crm);

    // В событии сумма завышена в 100 раз
    await handle(c, { id: 'o-1', total: 100000 });

    expect(crm.earnPoints).toHaveBeenCalledWith('p-1', 'o-1', 1000, 'e-1');
  });
});

describe('CRM consumer — идемпотентность', () => {
  it('повторное событие не начисляет баллы второй раз', async () => {
    // Outbox гарантирует at-least-once: дубль события штатная ситуация
    const pool = makePool({ order: paidOrder, profile, alreadyEarned: true });
    const crm = makeCrm();
    const c = new OrderEventsConsumer(pool, crm);

    await handle(c, { id: 'o-1' });

    expect(crm.earnPoints).not.toHaveBeenCalled();
  });

  it('гонка двух реплик: нарушение уникальности не считается ошибкой', async () => {
    const pool = makePool({ order: paidOrder, profile });
    const crm = {
      earnPoints: jest.fn(async () => {
        const e: any = new Error('duplicate key');
        e.code = '23505';
        throw e;
      })
    } as any;
    const c = new OrderEventsConsumer(pool, crm);

    // Если бы ошибка пролетела наружу, сообщение ушло бы в nack и крутилось
    await expect(handle(c, { id: 'o-1' })).resolves.toBeUndefined();
  });

  it('прочие ошибки БД не глотаются', async () => {
    const pool = makePool({ order: paidOrder, profile });
    const crm = {
      earnPoints: jest.fn(async () => { throw new Error('диск переполнен'); })
    } as any;
    const c = new OrderEventsConsumer(pool, crm);

    await expect(handle(c, { id: 'o-1' })).rejects.toThrow(/диск переполнен/);
  });
});

describe('CRM consumer — когда начислять нечего', () => {
  it('гостевой заказ без клиента пропускается', async () => {
    const pool = makePool({ order: { ...paidOrder, customer_id: null }, profile });
    const crm = makeCrm();
    const c = new OrderEventsConsumer(pool, crm);

    await handle(c, { id: 'o-1' });

    expect(crm.earnPoints).not.toHaveBeenCalled();
  });

  it('нулевая сумма не даёт баллов', async () => {
    const pool = makePool({ order: { ...paidOrder, total: '0.00' }, profile });
    const crm = makeCrm();
    const c = new OrderEventsConsumer(pool, crm);

    await handle(c, { id: 'o-1' });

    expect(crm.earnPoints).not.toHaveBeenCalled();
  });

  it('клиент без профиля лояльности пропускается без ошибки', async () => {
    const pool = makePool({ order: paidOrder, profile: null });
    const crm = makeCrm();
    const c = new OrderEventsConsumer(pool, crm);

    await expect(handle(c, { id: 'o-1' })).resolves.toBeUndefined();
    expect(crm.earnPoints).not.toHaveBeenCalled();
  });

  it('событие без id заказа игнорируется', async () => {
    const pool = makePool({});
    const crm = makeCrm();
    const c = new OrderEventsConsumer(pool, crm);

    await handle(c, {});

    expect(pool.query).not.toHaveBeenCalled();
    expect(crm.earnPoints).not.toHaveBeenCalled();
  });
});

describe('CRM consumer — повтор обработки', () => {
  it('отсутствующий заказ помечается retryable: реплика могла отстать', async () => {
    // Иначе баллы потерялись бы навсегда из-за задержки репликации
    const pool = makePool({ order: null });
    const c = new OrderEventsConsumer(pool, makeCrm());

    await expect(handle(c, { id: 'o-404' })).rejects.toMatchObject({
      retryable: true
    });
  });
});
