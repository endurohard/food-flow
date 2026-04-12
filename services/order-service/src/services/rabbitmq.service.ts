import amqp from 'amqplib';
import { logger } from '../utils/logger';
import { config } from '../config';

export class RabbitMQPublisher {
  private connection: any = null;
  private channel: any = null;
  private readonly EXCHANGE = 'orders_exchange';

  async connect(): Promise<void> {
    try {
      this.connection = await amqp.connect(config.rabbitmq.url);
      this.channel = await this.connection.createChannel();

      await this.channel.assertExchange(this.EXCHANGE, 'topic', {
        durable: true,
      });

      logger.info('RabbitMQ publisher connected');
    } catch (error) {
      logger.warn('Failed to connect RabbitMQ publisher, orders will not be forwarded to kitchen');
    }
  }

  async publishOrderEvent(routingKey: string, orderData: any): Promise<boolean> {
    if (!this.channel) {
      logger.warn('RabbitMQ not connected, skipping event publish');
      return false;
    }

    try {
      const message = Buffer.from(JSON.stringify(orderData));
      this.channel.publish(this.EXCHANGE, routingKey, message, {
        persistent: true,
        contentType: 'application/json'
      });

      logger.info(`Published ${routingKey} for order ${orderData.orderNumber}`);
      return true;
    } catch (error) {
      logger.error(`Failed to publish ${routingKey}:`, error);
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
