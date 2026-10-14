import { RabbitMQPublisher } from '../rabbitmq.service';

jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.mock('../../config', () => ({
  config: { rabbitmq: { url: 'amqp://test' } }
}));

import amqp from 'amqplib';
jest.mock('amqplib');

/** Канал и соединение с поддержкой обработчиков close/error. */
function makeChannel(publishImpl?: () => void) {
  const handlers: Record<string, Function[]> = {};
  return {
    handlers,
    assertExchange: jest.fn(async () => ({})),
    publish: jest.fn(publishImpl || (() => true)),
    close: jest.fn(async () => {}),
    on: jest.fn((ev: string, cb: Function) => {
      (handlers[ev] ||= []).push(cb);
    }),
    emit(ev: string, ...args: any[]) {
      (handlers[ev] || []).forEach(h => h(...args));
    }
  };
}

function makeConnection(channel: any) {
  const handlers: Record<string, Function[]> = {};
  return {
    handlers,
    createChannel: jest.fn(async () => channel),
    close: jest.fn(async () => {}),
    on: jest.fn((ev: string, cb: Function) => {
      (handlers[ev] ||= []).push(cb);
    }),
    emit(ev: string, ...args: any[]) {
      (handlers[ev] || []).forEach(h => h(...args));
    }
  };
}

describe('RabbitMQPublisher — публикация', () => {
  it('публикует событие в указанный exchange', async () => {
    const ch = makeChannel();
    (amqp.connect as jest.Mock).mockResolvedValue(makeConnection(ch));
    const p = new RabbitMQPublisher();
    await p.connect();

    const ok = await p.publishOrderEvent('order.confirmed', { orderNumber: 'A-1' }, 'custom');

    expect(ok).toBe(true);
    expect(ch.publish).toHaveBeenCalledWith(
      'custom',
      'order.confirmed',
      expect.any(Buffer),
      expect.objectContaining({ persistent: true })
    );
  });

  it('сообщения помечаются persistent: иначе рестарт брокера их теряет', async () => {
    const ch = makeChannel();
    (amqp.connect as jest.Mock).mockResolvedValue(makeConnection(ch));
    const p = new RabbitMQPublisher();
    await p.connect();

    await p.publishOrderEvent('order.confirmed', {});

    expect(ch.publish.mock.calls[0][3].persistent).toBe(true);
  });

  it('недоступный брокер при старте не роняет сервис', async () => {
    (amqp.connect as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));
    const p = new RabbitMQPublisher();

    await expect(p.connect()).resolves.toBeUndefined();
    expect(await p.publishOrderEvent('order.confirmed', {})).toBe(false);
  });
});

describe('RabbitMQPublisher — переподключение', () => {
  it('после обрыва соединения следующая публикация подключается заново', async () => {
    // Регрессия: раньше connect() вызывался один раз при старте,
    // и после рестарта брокера события не уходили никогда.
    const ch1 = makeChannel();
    const conn1 = makeConnection(ch1);
    const ch2 = makeChannel();
    const conn2 = makeConnection(ch2);

    (amqp.connect as jest.Mock)
      .mockResolvedValueOnce(conn1)
      .mockResolvedValueOnce(conn2);

    const p = new RabbitMQPublisher();
    await p.connect();
    expect(await p.publishOrderEvent('order.confirmed', {})).toBe(true);

    // Брокер упал
    conn1.emit('close');

    // Публикация обязана сама поднять соединение
    const ok = await p.publishOrderEvent('order.confirmed', {});

    expect(ok).toBe(true);
    expect(amqp.connect).toHaveBeenCalledTimes(2);
    expect(ch2.publish).toHaveBeenCalled();
  });

  it('ошибка publish сбрасывает канал, следующая попытка переподключается', async () => {
    const chBad = makeChannel(() => { throw new Error('Channel closed'); });
    const chGood = makeChannel();
    (amqp.connect as jest.Mock)
      .mockResolvedValueOnce(makeConnection(chBad))
      .mockResolvedValueOnce(makeConnection(chGood));

    const p = new RabbitMQPublisher();
    await p.connect();

    expect(await p.publishOrderEvent('order.confirmed', {})).toBe(false);
    expect(await p.publishOrderEvent('order.confirmed', {})).toBe(true);
    expect(chGood.publish).toHaveBeenCalled();
  });

  it('пока брокер мёртв, публикация возвращает false и событие остаётся в outbox', async () => {
    const ch = makeChannel();
    const conn = makeConnection(ch);
    (amqp.connect as jest.Mock)
      .mockResolvedValueOnce(conn)
      .mockRejectedValue(new Error('ECONNREFUSED'));

    const p = new RabbitMQPublisher();
    await p.connect();
    conn.emit('close');

    expect(await p.publishOrderEvent('order.confirmed', {})).toBe(false);
  });

  it('параллельные публикации не создают несколько соединений', async () => {
    const ch = makeChannel();
    (amqp.connect as jest.Mock).mockImplementation(
      () => new Promise(r => setTimeout(() => r(makeConnection(ch)), 10))
    );
    const p = new RabbitMQPublisher();

    await Promise.all([
      p.publishOrderEvent('order.confirmed', {}),
      p.publishOrderEvent('order.completed', {}),
      p.publishOrderEvent('order.delivered', {})
    ]);

    expect(amqp.connect).toHaveBeenCalledTimes(1);
  });
});
