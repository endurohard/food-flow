import amqp from 'amqplib';
import { logger } from '../utils/logger';
import { config } from '../config';
import { DeliveryService } from './delivery.service';

/**
 * Подписчик на события заказов.
 *
 * Связь, которой раньше не было: заказ с типом delivery создавался, но
 * доставку приходилось заводить руками через API. Теперь она создаётся
 * автоматически по событию order.confirmed из outbox order-service.
 *
 * Идемпотентность: outbox даёт at-least-once, поэтому одно событие может
 * прийти дважды. Защита — уникальный индекс uq_deliveries_order (миграция
 * 031) плюс проверка существования перед вставкой.
 */
export class OrderEventsConsumer {
  private connection: any = null;
  private channel: any = null;

  private readonly EXCHANGE = 'orders_exchange';
  private readonly QUEUE = 'delivery_orders_queue';
  /** Доставку создаём на подтверждённый заказ. */
  private readonly ROUTING_KEY = 'order.confirmed';

  constructor(
    private pool: any,
    private deliveryService: DeliveryService
  ) {}

  /** Остановлен ли подписчик штатно: тогда не переподключаемся. */
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  async connect(): Promise<void> {
    this.connection = await amqp.connect(config.rabbitmq.url);
    this.channel = await this.connection.createChannel();

    await this.channel.assertExchange(this.EXCHANGE, 'topic', { durable: true });
    await this.channel.assertQueue(this.QUEUE, { durable: true });
    await this.channel.bindQueue(this.QUEUE, this.EXCHANGE, this.ROUTING_KEY);

    // Не набираем в память больше одного сообщения: создание доставки
    // ходит в БД, параллелить тут нечего.
    await this.channel.prefetch(1);

    // Без переподключения сервис глохнет после любого рестарта брокера:
    // соединение закрыто, consume больше никогда не вызывается.
    this.connection.on('close', () => {
      if (this.stopped) return;
      logger.warn('Delivery consumer: соединение закрыто, переподключаюсь');
      this.channel = null;
      this.connection = null;
      this.scheduleReconnect();
    });
    this.connection.on('error', (err: Error) => {
      logger.warn(`Delivery consumer: ошибка соединения: ${err.message}`);
    });

    logger.info('Delivery consumer: подключён к RabbitMQ');
  }

  /** Повторная попытка через 5 секунд, пока брокер не поднимется. */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        await this.consume();
        logger.info('Delivery consumer: подписка восстановлена');
      } catch (err) {
        logger.warn(`Delivery consumer: переподключение не удалось: ${(err as Error).message}`);
        this.scheduleReconnect();
      }
    }, 5000);
    this.reconnectTimer.unref?.();
  }

  async consume(): Promise<void> {
    if (!this.channel) throw new Error('RabbitMQ channel not initialized');

    await this.channel.consume(
      this.QUEUE,
      async (msg: any) => {
        if (!msg) return;
        try {
          const order = JSON.parse(msg.content.toString());
          await this.handleOrderConfirmed(order);
          this.channel.ack(msg);
        } catch (error) {
          // requeue=false: сообщение, которое не удалось разобрать, будет
          // крутиться вечно и забьёт очередь. Логируем и отбрасываем.
          const requeue = (error as any)?.retryable === true;
          logger.error(
            `Delivery consumer: ошибка обработки события (requeue=${requeue}): ${(error as Error).message}`
          );
          this.channel.nack(msg, false, requeue);
        }
      },
      { noAck: false }
    );

    logger.info('Delivery consumer: слушает order.confirmed');
  }

  private async handleOrderConfirmed(order: any): Promise<void> {
    if (!order?.id) {
      logger.warn('Delivery consumer: событие без id заказа, пропускаю');
      return;
    }

    // Доставка нужна только заказам на доставку
    if (order.orderType && order.orderType !== 'delivery') {
      return;
    }

    // Быстрая проверка — не создавали ли уже (повторная доставка события)
    const existing = await this.pool.query(
      `SELECT id FROM deliveries WHERE order_id = $1`,
      [order.id]
    );
    if (existing.rowCount > 0) {
      logger.info(`Delivery consumer: доставка для заказа ${order.orderNumber || order.id} уже есть`);
      return;
    }

    try {
      const delivery = await this.deliveryService.createFromOrder(
        order.id,
        order.enterpriseId || undefined
      );
      logger.info(
        `Delivery consumer: создана доставка ${delivery?.id} для заказа ${order.orderNumber || order.id}`
      );
    } catch (error: any) {
      // Гонка двух реплик: обе прошли проверку выше, вторая упёрлась
      // в уникальный индекс. Это не ошибка — доставка уже создана.
      if (error?.code === '23505') {
        logger.info(`Delivery consumer: доставка для заказа ${order.id} создана параллельно`);
        return;
      }
      // Заказ ещё не виден этой реплике БД — есть смысл повторить
      if (String(error?.message).includes('Order not found')) {
        const retryable: any = new Error(`Заказ ${order.id} не найден, повтор`);
        retryable.retryable = true;
        throw retryable;
      }
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      await this.channel?.close();
      await this.connection?.close();
      logger.info('Delivery consumer: отключён');
    } catch (error) {
      logger.error(`Delivery consumer: ошибка отключения: ${(error as Error).message}`);
    }
  }
}

export default OrderEventsConsumer;
