import amqp, { Channel, Connection } from 'amqplib';
import { logger } from '../utils/logger';
import { config } from '../config';
import { PrinterService, OrderPrintData } from './printer.service';
import { KitchenDisplayService, KitchenOrder } from './kitchen-display.service';

export class RabbitMQService {
  private connection: Connection | null = null;
  private channel: Channel | null = null;
  private printerService: PrinterService;
  private kitchenDisplayService: KitchenDisplayService;

  private readonly EXCHANGE = 'orders_exchange';
  private readonly KITCHEN_QUEUE = 'kitchen_orders_queue';
  private readonly ROUTING_KEY = 'order.confirmed';

  constructor(
    printerService: PrinterService,
    kitchenDisplayService: KitchenDisplayService
  ) {
    this.printerService = printerService;
    this.kitchenDisplayService = kitchenDisplayService;
  }

  async connect(): Promise<void> {
    try {
      this.connection = await amqp.connect(config.rabbitmq.url);
      this.channel = await this.connection.createChannel();

      // Declare exchange
      await this.channel.assertExchange(this.EXCHANGE, 'topic', {
        durable: true,
      });

      // Declare queue
      await this.channel.assertQueue(this.KITCHEN_QUEUE, {
        durable: true,
      });

      // Bind queue to exchange
      await this.channel.bindQueue(
        this.KITCHEN_QUEUE,
        this.EXCHANGE,
        this.ROUTING_KEY
      );

      logger.info('Connected to RabbitMQ successfully');
    } catch (error) {
      logger.error('Failed to connect to RabbitMQ:', error);
      throw error;
    }
  }

  async consumeOrders(): Promise<void> {
    if (!this.channel) {
      throw new Error('RabbitMQ channel not initialized');
    }

    try {
      await this.channel.consume(
        this.KITCHEN_QUEUE,
        async (msg) => {
          if (msg) {
            try {
              const orderData = JSON.parse(msg.content.toString());
              logger.info(`Received order: ${orderData.orderNumber}`);

              // Process the order
              await this.processOrder(orderData);

              // Acknowledge the message
              this.channel!.ack(msg);
            } catch (error) {
              logger.error('Failed to process order message:', error);
              // Reject and requeue the message
              this.channel!.nack(msg, false, true);
            }
          }
        },
        { noAck: false }
      );

      logger.info('Started consuming kitchen orders');
    } catch (error) {
      logger.error('Failed to consume orders:', error);
      throw error;
    }
  }

  private async processOrder(orderData: any): Promise<void> {
    try {
      // Transform order data for printer
      const printData: OrderPrintData = {
        orderNumber: orderData.orderNumber,
        restaurant: {
          name: orderData.restaurant.name,
          address: orderData.restaurant.address || 'N/A',
          phone: orderData.restaurant.phone || 'N/A',
        },
        customer: {
          name: orderData.customer.name,
          phone: orderData.customer.phone,
        },
        items: orderData.items.map((item: any) => ({
          name: item.name,
          quantity: item.quantity,
          price: item.unitPrice,
          specialInstructions: item.specialInstructions,
        })),
        subtotal: orderData.subtotal,
        deliveryFee: orderData.deliveryFee || 0,
        tax: orderData.tax || 0,
        total: orderData.total,
        orderType: orderData.orderType || 'delivery',
        deliveryAddress: orderData.deliveryAddress,
        specialInstructions: orderData.specialInstructions,
        timestamp: new Date(orderData.timestamp || Date.now()),
      };

      // Print kitchen order if auto-print is enabled
      if (config.printer.autoPrint) {
        const printed = await this.printerService.printKitchenOrder(printData);
        if (printed) {
          logger.info(`Kitchen order ${orderData.orderNumber} printed`);
        }
      }

      // Transform for kitchen display
      const kitchenOrder: KitchenOrder = {
        id: orderData.id,
        orderNumber: orderData.orderNumber,
        restaurantId: orderData.restaurantId,
        status: orderData.status,
        items: orderData.items.map((item: any) => ({
          name: item.name,
          quantity: item.quantity,
          specialInstructions: item.specialInstructions,
        })),
        orderType: orderData.orderType || 'delivery',
        customerName: orderData.customer.name,
        specialInstructions: orderData.specialInstructions,
        createdAt: new Date(orderData.timestamp || Date.now()),
        estimatedTime: orderData.estimatedTime,
      };

      // Broadcast to kitchen displays
      await this.kitchenDisplayService.broadcastNewOrder(kitchenOrder);

      logger.info(`Order ${orderData.orderNumber} processed successfully`);
    } catch (error) {
      logger.error('Error processing order:', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.channel?.close();
      await this.connection?.close();
      logger.info('Disconnected from RabbitMQ');
    } catch (error) {
      logger.error('Error disconnecting from RabbitMQ:', error);
    }
  }
}
