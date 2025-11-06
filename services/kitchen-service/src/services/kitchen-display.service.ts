import { Server, Socket } from 'socket.io';
import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { config } from '../config';

export interface KitchenOrder {
  id: string;
  orderNumber: string;
  restaurantId: string;
  status: string;
  items: Array<{
    name: string;
    quantity: number;
    specialInstructions?: string;
  }>;
  orderType: string;
  customerName: string;
  specialInstructions?: string;
  createdAt: Date;
  estimatedTime?: number;
}

export class KitchenDisplayService {
  private io: Server;
  private db: Pool;

  constructor(io: Server) {
    this.io = io;
    this.db = new Pool({ connectionString: config.database.url });
  }

  /**
   * Send active orders to a newly connected kitchen display
   */
  async sendActiveOrders(restaurantId: string, socket: Socket): Promise<void> {
    try {
      const result = await this.db.query(
        `SELECT
          o.id,
          o.order_number as "orderNumber",
          o.restaurant_id as "restaurantId",
          o.status,
          o.created_at as "createdAt",
          o.special_instructions as "specialInstructions",
          o.estimated_delivery_time as "estimatedTime",
          u.first_name || ' ' || u.last_name as "customerName",
          CASE
            WHEN o.delivery_address_id IS NOT NULL THEN 'delivery'
            ELSE 'pickup'
          END as "orderType",
          json_agg(
            json_build_object(
              'name', mi.name,
              'quantity', oi.quantity,
              'specialInstructions', oi.special_instructions
            )
          ) as items
        FROM orders o
        JOIN users u ON o.customer_id = u.id
        JOIN order_items oi ON o.id = oi.order_id
        JOIN menu_items mi ON oi.menu_item_id = mi.id
        WHERE o.restaurant_id = $1
          AND o.status IN ('confirmed', 'preparing', 'ready')
        GROUP BY o.id, o.order_number, o.restaurant_id, o.status,
                 o.created_at, o.special_instructions, o.estimated_delivery_time,
                 u.first_name, u.last_name, o.delivery_address_id
        ORDER BY o.created_at ASC`,
        [restaurantId]
      );

      socket.emit('activeOrders', result.rows);
      logger.info(`Sent ${result.rows.length} active orders to display`);
    } catch (error) {
      logger.error('Failed to fetch active orders:', error);
      throw error;
    }
  }

  /**
   * Broadcast new order to all kitchen displays of a restaurant
   */
  async broadcastNewOrder(order: KitchenOrder): Promise<void> {
    try {
      this.io
        .to(`restaurant:${order.restaurantId}`)
        .emit('newOrder', order);

      logger.info(`Broadcasted new order ${order.orderNumber} to kitchen displays`);
    } catch (error) {
      logger.error('Failed to broadcast new order:', error);
    }
  }

  /**
   * Broadcast order status update
   */
  async broadcastOrderUpdate(
    restaurantId: string,
    orderId: string,
    status: string
  ): Promise<void> {
    try {
      this.io
        .to(`restaurant:${restaurantId}`)
        .emit('orderUpdated', { orderId, status, timestamp: new Date() });

      logger.info(`Broadcasted order ${orderId} status update: ${status}`);
    } catch (error) {
      logger.error('Failed to broadcast order update:', error);
    }
  }

  /**
   * Update order status from kitchen display
   */
  async updateOrderStatus(orderId: string, status: string): Promise<void> {
    try {
      const result = await this.db.query(
        `UPDATE orders
         SET status = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING restaurant_id as "restaurantId", order_number as "orderNumber"`,
        [status, orderId]
      );

      if (result.rows.length > 0) {
        const { restaurantId, orderNumber } = result.rows[0];

        // Broadcast update to all displays
        await this.broadcastOrderUpdate(restaurantId, orderId, status);

        logger.info(`Order ${orderNumber} status updated to ${status}`);

        // If order is ready, notify delivery service via event
        if (status === 'ready') {
          // TODO: Publish event to RabbitMQ for delivery assignment
        }
      }
    } catch (error) {
      logger.error('Failed to update order status:', error);
      throw error;
    }
  }

  /**
   * Get order statistics for a restaurant
   */
  async getOrderStats(restaurantId: string): Promise<{
    pending: number;
    preparing: number;
    ready: number;
    averageTime: number;
  }> {
    try {
      const result = await this.db.query(
        `SELECT
          COUNT(CASE WHEN status = 'confirmed' THEN 1 END) as pending,
          COUNT(CASE WHEN status = 'preparing' THEN 1 END) as preparing,
          COUNT(CASE WHEN status = 'ready' THEN 1 END) as ready,
          COALESCE(AVG(EXTRACT(EPOCH FROM (updated_at - created_at))), 0) as "averageTime"
        FROM orders
        WHERE restaurant_id = $1
          AND status IN ('confirmed', 'preparing', 'ready')
          AND created_at > NOW() - INTERVAL '1 day'`,
        [restaurantId]
      );

      return {
        pending: parseInt(result.rows[0].pending),
        preparing: parseInt(result.rows[0].preparing),
        ready: parseInt(result.rows[0].ready),
        averageTime: parseFloat(result.rows[0].averageTime) / 60, // Convert to minutes
      };
    } catch (error) {
      logger.error('Failed to get order stats:', error);
      throw error;
    }
  }

  /**
   * Mark order as complete (picked up or delivered)
   */
  async completeOrder(orderId: string): Promise<void> {
    try {
      const result = await this.db.query(
        `UPDATE orders
         SET status = 'picked_up', updated_at = NOW()
         WHERE id = $1
         RETURNING restaurant_id as "restaurantId"`,
        [orderId]
      );

      if (result.rows.length > 0) {
        const { restaurantId } = result.rows[0];
        await this.broadcastOrderUpdate(restaurantId, orderId, 'picked_up');
      }
    } catch (error) {
      logger.error('Failed to complete order:', error);
      throw error;
    }
  }

  /**
   * Get overdue orders (orders taking too long)
   */
  async getOverdueOrders(restaurantId: string): Promise<KitchenOrder[]> {
    try {
      const result = await this.db.query(
        `SELECT
          o.id,
          o.order_number as "orderNumber",
          o.status,
          o.created_at as "createdAt",
          EXTRACT(EPOCH FROM (NOW() - o.created_at)) / 60 as "minutesElapsed"
        FROM orders o
        WHERE o.restaurant_id = $1
          AND o.status IN ('confirmed', 'preparing')
          AND o.created_at < NOW() - INTERVAL '30 minutes'
        ORDER BY o.created_at ASC`,
        [restaurantId]
      );

      return result.rows;
    } catch (error) {
      logger.error('Failed to get overdue orders:', error);
      throw error;
    }
  }
}
