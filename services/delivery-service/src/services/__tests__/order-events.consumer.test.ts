import { OrderEventsConsumer } from '../order-events.consumer';

jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.mock('../../config', () => ({
  config: { rabbitmq: { url: 'amqp://test' }, database: { url: 'postgresql://test' } }
}));

function makePool(existing = false) {
  return {
    query: jest.fn(async () => (existing
      ? { rows: [{ id: 'd-1' }], rowCount: 1 }
      : { rows: [], rowCount: 0 }))
  };
}

function makeDeliveryService() {
  return { createFromOrder: jest.fn(async () => ({ id: 'd-new' })) } as any;
}

function handle(consumer: any, event: any) {
  return consumer.handleOrderConfirmed(event);
}

const deliveryOrder = { id: 'o-1', orderType: 'delivery', enterpriseId: 'e-1' };

describe('Delivery consumer — создание доставки', () => {
  it('создаёт доставку для заказа на доставку', async () => {
    const svc = makeDeliveryService();
    const c = new OrderEventsConsumer(makePool(), svc);

    await handle(c, deliveryOrder);

    expect(svc.createFromOrder).toHaveBeenCalledWith('o-1', 'e-1');
  });

  it('заказ без указания типа обрабатывается (тип мог не попасть в событие)', async () => {
    const svc = makeDeliveryService();
    const c = new OrderEventsConsumer(makePool(), svc);

    await handle(c, { id: 'o-1' });

    expect(svc.createFromOrder).toHaveBeenCalled();
  });
});

describe('Delivery consumer — что доставкой не является', () => {
  it('самовывоз не создаёт доставку', async () => {
    const svc = makeDeliveryService();
    const c = new OrderEventsConsumer(makePool(), svc);

    await handle(c, { id: 'o-1', orderType: 'pickup' });

    expect(svc.createFromOrder).not.toHaveBeenCalled();
  });

  it('заказ в зале не создаёт доставку', async () => {
    const svc = makeDeliveryService();
    const c = new OrderEventsConsumer(makePool(), svc);

    await handle(c, { id: 'o-1', orderType: 'dine_in' });

    expect(svc.createFromOrder).not.toHaveBeenCalled();
  });

  it('событие без id игнорируется', async () => {
    const svc = makeDeliveryService();
    const pool = makePool();
    const c = new OrderEventsConsumer(pool, svc);

    await handle(c, {});

    expect(pool.query).not.toHaveBeenCalled();
    expect(svc.createFromOrder).not.toHaveBeenCalled();
  });
});

describe('Delivery consumer — идемпотентность', () => {
  it('повторное событие не создаёт вторую доставку', async () => {
    const svc = makeDeliveryService();
    const c = new OrderEventsConsumer(makePool(true), svc);

    await handle(c, deliveryOrder);

    expect(svc.createFromOrder).not.toHaveBeenCalled();
  });

  it('гонка двух реплик: уникальный индекс не считается ошибкой', async () => {
    const svc = {
      createFromOrder: jest.fn(async () => {
        const e: any = new Error('duplicate key value');
        e.code = '23505';
        throw e;
      })
    } as any;
    const c = new OrderEventsConsumer(makePool(), svc);

    await expect(handle(c, deliveryOrder)).resolves.toBeUndefined();
  });
});

describe('Delivery consumer — повтор и ошибки', () => {
  it('отсутствующий заказ помечается retryable', async () => {
    const svc = {
      createFromOrder: jest.fn(async () => { throw new Error('Order not found'); })
    } as any;
    const c = new OrderEventsConsumer(makePool(), svc);

    await expect(handle(c, deliveryOrder)).rejects.toMatchObject({ retryable: true });
  });

  it('прочие ошибки пробрасываются без пометки retryable', async () => {
    // Такое сообщение уйдёт в nack без requeue, чтобы не крутиться вечно
    const svc = {
      createFromOrder: jest.fn(async () => { throw new Error('адрес не распознан'); })
    } as any;
    const c = new OrderEventsConsumer(makePool(), svc);

    await expect(handle(c, deliveryOrder)).rejects.toThrow(/адрес не распознан/);
    await expect(handle(c, deliveryOrder)).rejects.not.toMatchObject({ retryable: true });
  });
});
