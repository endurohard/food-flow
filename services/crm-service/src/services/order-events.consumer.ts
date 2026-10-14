import amqp from 'amqplib';
import { logger } from '../utils/logger';
import { config } from '../config';
import { CRMService } from './crm.service';

/**
 * Подписчик на события заказов: начисление баллов лояльности.
 *
 * Связь, которой раньше не было: баллы начислялись только если кто-то
 * вручную вызывал POST /api/crm/points/earn. При продаже через кассу или
 * приложение клиент не получал ничего.
 *
 * Слушает order.completed и order.delivered — начисляем за фактически
 * закрытый заказ, а не за созданный (иначе отменённый заказ дал бы баллы).
 *
 * Идемпотентность: outbox даёт at-least-once. Защита — уникальный индекс
 * uq_loyalty_earn_per_order (миграция 031) плюс проверка перед начислением.
 */
export class OrderEventsConsumer {
  private connection: any = null;
  private channel: any = null;

  private readonly EXCHANGE = 'orders_exchange';
  private readonly QUEUE = 'crm_loyalty_queue';
  private readonly ROUTING_KEYS = ['order.completed', 'order.delivered'];

  constructor(
    private pool: any,
    private crmService: CRMService
  ) {}


  async connect(): Promise<void> {
    this.connection = await amqp.connect(config.rabbitmq.url);
    this.channel = await this.connection.createChannel();

    await this.channel.assertExchange(this.EXCHANGE, 'topic', { durable: true });
    await this.channel.assertQueue(this.QUEUE, { durable: true });
    for (const key of this.ROUTING_KEYS) {
      await this.channel.bindQueue(this.QUEUE, this.EXCHANGE, key);
    }
    await this.channel.prefetch(1);


    logger.info('CRM consumer: подключён к RabbitMQ');
  }


  async consume(): Promise<void> {
    if (!this.channel) throw new Error('RabbitMQ channel not initialized');

    await this.channel.consume(
      this.QUEUE,
      async (msg: any) => {
        if (!msg) return;
        try {
          const order = JSON.parse(msg.content.toString());
          await this.handleOrderClosed(order);
          this.channel.ack(msg);
        } catch (error) {
          const requeue = (error as any)?.retryable === true;
          logger.error(
            `CRM consumer: ошибка обработки события (requeue=${requeue}): ${(error as Error).message}`
          );
          this.channel.nack(msg, false, requeue);
        }
      },
      { noAck: false }
    );

    logger.info(`CRM consumer: слушает ${this.ROUTING_KEYS.join(', ')}`);
  }

  private async handleOrderClosed(order: any): Promise<void> {
    if (!config.autoEarnPoints) return;
    if (!order?.id) {
      logger.warn('CRM consumer: событие без id заказа, пропускаю');
      return;
    }

    // Событие смены статуса не содержит сумму и клиента — читаем из БД.
    const orderRow = await this.pool.query(
      `SELECT id, customer_id, total, enterprise_id FROM orders WHERE id = $1`,
      [order.id]
    );
    if (orderRow.rowCount === 0) {
      const retryable: any = new Error(`Заказ ${order.id} не найден, повтор`);
      retryable.retryable = true;
      throw retryable;
    }
    const row = orderRow.rows[0];

    // Гостевой заказ без клиента — начислять некому, это не ошибка
    if (!row.customer_id) return;

    const amount = parseFloat(row.total);
    if (!amount || amount <= 0) return;

    // Профиль лояльности есть не у каждого пользователя
    const profile = await this.pool.query(
      `SELECT id FROM customer_profiles
       WHERE user_id = $1 AND ($2::uuid IS NULL OR enterprise_id = $2)
       LIMIT 1`,
      [row.customer_id, row.enterprise_id || null]
    );
    if (profile.rowCount === 0) {
      logger.info(`CRM consumer: у пользователя ${row.customer_id} нет профиля лояльности`);
      return;
    }
    const profileId = profile.rows[0].id;

    // Защита от повторного начисления (повторная доставка события)
    const already = await this.pool.query(
      `SELECT 1 FROM loyalty_transactions
       WHERE order_id = $1 AND customer_profile_id = $2 AND transaction_type = 'earn'
       LIMIT 1`,
      [order.id, profileId]
    );
    if (already.rowCount > 0) {
      logger.info(`CRM consumer: баллы за заказ ${order.orderNumber || order.id} уже начислены`);
      return;
    }

    try {
      await this.crmService.earnPoints(
        profileId,
        order.id,
        amount,
        row.enterprise_id || undefined
      );
      logger.info(
        `CRM consumer: начислены баллы за заказ ${order.orderNumber || order.id} на сумму ${amount}`
      );
    } catch (error: any) {
      // Гонка двух реплик: вторая упёрлась в уникальный индекс — баллы уже есть
      if (error?.code === '23505') {
        logger.info(`CRM consumer: баллы за заказ ${order.id} начислены параллельно`);
        return;
      }
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.channel?.close();
      await this.connection?.close();
      logger.info('CRM consumer: отключён');
    } catch (error) {
      logger.error(`CRM consumer: ошибка отключения: ${(error as Error).message}`);
    }
  }
}

export default OrderEventsConsumer;
