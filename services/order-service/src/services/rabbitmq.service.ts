import amqp from 'amqplib';
import { logger } from '../utils/logger';
import { config } from '../config';

/**
 * Публикатор событий заказов.
 *
 * Важное свойство: умеет переподключаться. Раньше connect() вызывался
 * однажды при старте, и после падения брокера канал оставался закрытым
 * навсегда — outbox копил попытки до status='failed', а события не
 * доходили до подписчиков даже после возвращения брокера.
 */
export class RabbitMQPublisher {
  private connection: any = null;
  private channel: any = null;
  private readonly EXCHANGE = 'orders_exchange';

  /** Идёт ли попытка подключения: защита от параллельных connect(). */
  private connecting: Promise<void> | null = null;

  async connect(): Promise<void> {
    // Параллельные вызовы ждут одну и ту же попытку
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      try {
        this.connection = await amqp.connect(config.rabbitmq.url);
        this.channel = await this.connection.createChannel();

        await this.channel.assertExchange(this.EXCHANGE, 'topic', {
          durable: true,
        });

        // Сбрасываем ссылки при обрыве, чтобы следующая публикация
        // подняла соединение заново, а не писала в мёртвый канал.
        this.connection.on('close', () => {
          logger.warn('RabbitMQ publisher: соединение закрыто, переподключусь при следующей публикации');
          this.connection = null;
          this.channel = null;
        });
        this.connection.on('error', (err: Error) => {
          logger.warn(`RabbitMQ publisher: ошибка соединения: ${err.message}`);
        });
        this.channel.on('close', () => {
          this.channel = null;
        });
        this.channel.on('error', (err: Error) => {
          logger.warn(`RabbitMQ publisher: ошибка канала: ${err.message}`);
        });

        logger.info('RabbitMQ publisher connected');
      } catch (error) {
        this.connection = null;
        this.channel = null;
        logger.warn(
          `Failed to connect RabbitMQ publisher: ${(error as Error).message}`
        );
      } finally {
        this.connecting = null;
      }
    })();

    return this.connecting;
  }

  async publishOrderEvent(routingKey: string, orderData: any, exchange?: string): Promise<boolean> {
    // Канал мёртв или ещё не поднят — пробуем подключиться здесь же.
    // Воркер outbox вызывает публикацию по таймеру, так что это и есть
    // естественная точка восстановления связи.
    if (!this.channel) {
      await this.connect();
    }
    if (!this.channel) {
      logger.warn('RabbitMQ not connected, skipping event publish');
      return false;
    }

    try {
      const message = Buffer.from(JSON.stringify(orderData));
      this.channel.publish(exchange || this.EXCHANGE, routingKey, message, {
        persistent: true,
        contentType: 'application/json'
      });

      logger.info(`Published ${routingKey} for order ${orderData.orderNumber}`);
      return true;
    } catch (error) {
      // Канал мог закрыться между проверкой и публикацией: сбрасываем,
      // чтобы следующая попытка начала с переподключения.
      this.channel = null;
      logger.error(`Failed to publish ${routingKey}: ${(error as Error).message}`);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.channel?.close();
      await this.connection?.close();
      logger.info('RabbitMQ publisher disconnected');
    } catch (error) {
      logger.error('Error disconnecting RabbitMQ:', error);
    }
  }
}

export default RabbitMQPublisher;
