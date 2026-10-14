import pkg from 'pg';
const { Pool } = pkg;
import crypto from 'crypto';
import { RabbitMQPublisher } from './rabbitmq.service';
import { OutboxService } from './outbox.service';
import { DiscountService } from './discount.service';
import { config } from '../config';
import { logger } from '../utils/logger';

export const VALID_ORDER_STATUSES = [
  'pending',
  'confirmed',
  'preparing',
  'ready',
  'out_for_delivery',
  'delivered',
  'completed',
  'cancelled'
] as const;
export type OrderStatus = typeof VALID_ORDER_STATUSES[number];

export interface CreateOrderInput {
  restaurantId: string;
  customerId?: string;
  enterpriseId?: string;
  deliveryAddressId?: string;
  orderType?: string;
  tableId?: string;
  waiterId?: string;
  guestsCount?: number;
  items: Array<{
    menuItemId: string;
    quantity: number;
    specialInstructions?: string;
    modifiers?: Array<{ modifierId: string; name: string; priceAdjustment: number }>;
  }>;
  specialInstructions?: string;
  paymentMethod?: string;
}

export class OrderService {
  private pool: InstanceType<typeof Pool>;
  private rabbitmq: RabbitMQPublisher;
  /** Transactional outbox: событие пишется в транзакции заказа. */
  public readonly outbox: OutboxService;

  constructor(connectionString: string, rabbitmq: RabbitMQPublisher) {
    this.pool = new Pool({ connectionString });
    this.rabbitmq = rabbitmq;
    this.outbox = new OutboxService(this.pool, rabbitmq);
  }

  private generateOrderNumber(): string {
    const date = new Date();
    const dateStr = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
    const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `ORD-${dateStr}-${rand}`;
  }

  async create(data: CreateOrderInput): Promise<any> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Fetch menu items to get prices
      const itemIds = data.items.map(i => i.menuItemId);
      const menuResult = await client.query(
        `SELECT id, name, price, restaurant_id, category_id FROM menu_items WHERE id = ANY($1)`,
        [itemIds]
      );

      const menuMap = new Map(menuResult.rows.map(r => [r.id, r]));

      // Calculate totals
      let subtotal = 0;
      const orderItems: any[] = [];

      for (const item of data.items) {
        const menuItem = menuMap.get(item.menuItemId);
        if (!menuItem) {
          throw new OrderError(`Menu item ${item.menuItemId} not found`, 400);
        }

        const unitPrice = parseFloat(menuItem.price);
        let modifierTotal = 0;
        if (item.modifiers) {
          modifierTotal = item.modifiers.reduce((sum, m) => sum + m.priceAdjustment, 0);
        }
        const itemSubtotal = (unitPrice + modifierTotal) * item.quantity;
        subtotal += itemSubtotal;

        orderItems.push({
          menuItemId: item.menuItemId,
          categoryId: menuItem.category_id || undefined,
          name: menuItem.name,
          quantity: item.quantity,
          unitPrice: unitPrice + modifierTotal,
          subtotal: itemSubtotal,
          specialInstructions: item.specialInstructions,
          modifiers: item.modifiers
        });
      }

      // Get restaurant info for delivery fee
      const restResult = await client.query(
        `SELECT r.name, r.delivery_fee, r.phone,
                ra.street_address, ra.city
         FROM restaurants r
         LEFT JOIN restaurant_addresses ra ON ra.restaurant_id = r.id
         WHERE r.id = $1`,
        [data.restaurantId]
      );
      const restaurant = restResult.rows[0];
      if (!restaurant) {
        throw new OrderError('Restaurant not found', 404);
      }

      const deliveryFee = data.orderType === 'delivery' ? parseFloat(restaurant.delivery_fee || '0') : 0;
      const tax = 0; // Configurable per enterprise

      // Calculate applicable discounts within the transaction
      const discountResult = await DiscountService.calculateDiscountsInTx(
        client,
        data.restaurantId,
        subtotal,
        orderItems.map(i => ({ menuItemId: i.menuItemId, categoryId: i.categoryId, subtotal: i.subtotal })),
        data.enterpriseId
      );
      const discountAmount = discountResult.totalDiscount;
      const appliedDiscounts = discountResult.appliedDiscounts;

      const total = subtotal + deliveryFee + tax - discountAmount;

      const orderNumber = this.generateOrderNumber();

      // Insert order
      const orderResult = await client.query(
        `INSERT INTO orders (
          order_number, customer_id, restaurant_id, delivery_address_id,
          status, subtotal, delivery_fee, tax, total, payment_method,
          special_instructions, order_type, table_id, waiter_id, guests_count,
          enterprise_id, discount_amount, applied_discounts
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        RETURNING *`,
        [
          orderNumber,
          data.customerId || null,
          data.restaurantId,
          data.deliveryAddressId || null,
          'pending',
          subtotal,
          deliveryFee,
          tax,
          total,
          data.paymentMethod || 'cash',
          data.specialInstructions || null,
          data.orderType || 'delivery',
          data.tableId || null,
          data.waiterId || null,
          data.guestsCount || 1,
          data.enterpriseId || null,
          discountAmount,
          JSON.stringify(appliedDiscounts)
        ]
      );

      const order = orderResult.rows[0];

      // Insert order items
      for (const item of orderItems) {
        const itemResult = await client.query(
          `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price, subtotal, special_instructions)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [order.id, item.menuItemId, item.quantity, item.unitPrice, item.subtotal, item.specialInstructions || null]
        );

        // Insert order item modifiers
        if (item.modifiers && item.modifiers.length > 0) {
          for (const mod of item.modifiers) {
            await client.query(
              `INSERT INTO order_item_modifiers (order_item_id, modifier_id, name, price_adjustment)
               VALUES ($1, $2, $3, $4)`,
              [itemResult.rows[0].id, mod.modifierId, mod.name, mod.priceAdjustment]
            );
          }
        }
      }

      // Update table status if dine-in
      if (data.tableId) {
        await client.query(
          `UPDATE restaurant_tables SET status = 'occupied', current_order_id = $1 WHERE id = $2`,
          [order.id, data.tableId]
        );
      }

      // Get customer info for RabbitMQ message.
      // Читаем ТЕМ ЖЕ client: запись в outbox должна попасть в транзакцию
      // вместе с заказом, поэтому COMMIT ниже, а не здесь.
      let customer = { name: 'Guest', phone: '' };
      if (data.customerId) {
        const custResult = await client.query(
          `SELECT first_name, last_name, phone FROM users WHERE id = $1`,
          [data.customerId]
        );
        if (custResult.rows[0]) {
          customer = {
            name: `${custResult.rows[0].first_name} ${custResult.rows[0].last_name}`,
            phone: custResult.rows[0].phone || ''
          };
        }
      }

      // Publish to RabbitMQ (matches kitchen-service contract)
      // enterpriseId included so consumers can filter by tenant (H3 fix).
      const rabbitmqMessage = {
        id: order.id,
        orderNumber: order.order_number,
        restaurantId: data.restaurantId,
        enterpriseId: data.enterpriseId || null,
        restaurant: {
          name: restaurant.name,
          address: restaurant.street_address ? `${restaurant.street_address}, ${restaurant.city}` : 'N/A',
          phone: restaurant.phone || 'N/A'
        },
        customer,
        items: orderItems.map(i => ({
          name: i.name,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          specialInstructions: i.specialInstructions
        })),
        subtotal,
        deliveryFee,
        tax,
        discountAmount,
        appliedDiscounts,
        total,
        orderType: data.orderType || 'delivery',
        deliveryAddress: data.deliveryAddressId,
        specialInstructions: data.specialInstructions,
        status: 'pending',
        timestamp: new Date().toISOString(),
        estimatedTime: 30
      };

      // Событие пишется в outbox В ТОЙ ЖЕ транзакции, что и заказ:
      // либо есть и заказ, и событие, либо нет ни того, ни другого.
      // Воркер (outbox.service) досылает его в RabbitMQ — падение брокера
      // больше не теряет заказ для кухни, склада и CRM.
      await this.outbox.enqueue(client, {
        routingKey: 'order.confirmed',
        payload: rabbitmqMessage,
        aggregateType: 'order',
        aggregateId: order.id,
        enterpriseId: data.enterpriseId || null
      });

      await client.query('COMMIT');

      // Пробуем отправить сразу, чтобы не ждать интервал воркера.
      // Ошибка не страшна: событие уже в outbox и будет досланo.
      this.outbox.drainOnce().catch(() => {});

      logger.info(`Order ${orderNumber} created, total: ${total}`);

      return { ...order, items: orderItems };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async list(filters: {
    enterpriseId?: string;
    restaurantId?: string;
    customerId?: string;
    status?: string;
    orderType?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ orders: any[]; total: number }> {
    const conditions: string[] = [];
    const values: any[] = [];
    let p = 1;

    // Tenant isolation: always apply if caller provided enterpriseId
    if (filters.enterpriseId) {
      conditions.push(`o.enterprise_id = $${p++}`);
      values.push(filters.enterpriseId);
    }
    if (filters.restaurantId) {
      conditions.push(`o.restaurant_id = $${p++}`);
      values.push(filters.restaurantId);
    }
    if (filters.customerId) {
      conditions.push(`o.customer_id = $${p++}`);
      values.push(filters.customerId);
    }
    if (filters.status) {
      conditions.push(`o.status = $${p++}`);
      values.push(filters.status);
    }
    if (filters.orderType) {
      conditions.push(`o.order_type = $${p++}`);
      values.push(filters.orderType);
    }
    if (filters.dateFrom) {
      conditions.push(`o.created_at >= $${p++}`);
      values.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      conditions.push(`o.created_at <= $${p++}`);
      values.push(filters.dateTo);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;

    const countResult = await this.pool.query(
      `SELECT COUNT(*) FROM orders o ${where}`,
      values
    );

    values.push(limit, offset);
    const result = await this.pool.query(
      `SELECT o.*, u.first_name, u.last_name, u.phone as customer_phone,
              r.name as restaurant_name
       FROM orders o
       LEFT JOIN users u ON o.customer_id = u.id
       LEFT JOIN restaurants r ON o.restaurant_id = r.id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT $${p++} OFFSET $${p}`,
      values
    );

    return {
      orders: result.rows,
      total: parseInt(countResult.rows[0].count)
    };
  }

  async getById(orderId: string, enterpriseId?: string): Promise<any> {
    const conds = ['o.id = $1'];
    const vals: any[] = [orderId];
    if (enterpriseId) {
      conds.push(`o.enterprise_id = $2`);
      vals.push(enterpriseId);
    }
    const orderResult = await this.pool.query(
      `SELECT o.*, u.first_name, u.last_name, u.phone as customer_phone,
              r.name as restaurant_name
       FROM orders o
       LEFT JOIN users u ON o.customer_id = u.id
       LEFT JOIN restaurants r ON o.restaurant_id = r.id
       WHERE ${conds.join(' AND ')}`,
      vals
    );

    if (orderResult.rows.length === 0) return null;

    const order = orderResult.rows[0];

    // Get order items
    const itemsResult = await this.pool.query(
      `SELECT oi.*, mi.name as item_name, mi.image_url
       FROM order_items oi
       LEFT JOIN menu_items mi ON oi.menu_item_id = mi.id
       WHERE oi.order_id = $1`,
      [orderId]
    );

    order.items = itemsResult.rows;
    return order;
  }

  async updateStatus(orderId: string, status: string, enterpriseId?: string): Promise<any> {
    if (!(VALID_ORDER_STATUSES as readonly string[]).includes(status)) {
      throw new OrderError(
        `Invalid status "${status}". Allowed: ${VALID_ORDER_STATUSES.join(', ')}`,
        400
      );
    }

    // Доп. поля задаются через NOW() прямо в SQL, поэтому значений не требуют
    const extraFields: string[] = [];

    if (status === 'confirmed') {
      extraFields.push('confirmed_at = NOW()');
    } else if (status === 'delivered' || status === 'completed') {
      extraFields.push('delivered_at = NOW()');
      extraFields.push('closed_at = NOW()');
    }

    const setClause = [`status = $1`, ...extraFields].join(', ');
    const whereConds = ['id = $2'];
    const vals: any[] = [status, orderId];
    if (enterpriseId) {
      whereConds.push(`enterprise_id = $3`);
      vals.push(enterpriseId);
    }

    const client = await this.pool.connect();
    let order: any;
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `UPDATE orders SET ${setClause} WHERE ${whereConds.join(' AND ')} RETURNING *`,
        vals
      );

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      order = result.rows[0];

      // Free table if completed/cancelled
      if ((status === 'completed' || status === 'cancelled') && order.table_id) {
        await client.query(
          `UPDATE restaurant_tables SET status = 'free', current_order_id = NULL WHERE id = $1`,
          [order.table_id]
        );
      }

      // Событие в outbox — в той же транзакции, что и смена статуса.
      // Раньше публикация шла после коммита в try/catch: при недоступном
      // брокере статус менялся, а подписчики об этом не узнавали никогда.
      await this.outbox.enqueue(client, {
        routingKey: `order.${status}`,
        payload: {
          id: order.id,
          orderNumber: order.order_number,
          restaurantId: order.restaurant_id,
          enterpriseId: order.enterprise_id || null,
          status,
          timestamp: new Date().toISOString()
        },
        aggregateType: 'order',
        aggregateId: order.id,
        enterpriseId: order.enterprise_id || null
      });

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    // Автосписание ингредиентов по техкартам при закрытии заказа.
    // Делается ПОСЛЕ коммита: нехватка остатка не должна отменять оплаченный
    // заказ. Ошибка логируется — склад правится вручную в админке.
    if (status === 'completed' || status === 'delivered') {
      await this.deductStockForOrder(order);
    }

    // Пробуем разослать сразу; при неудаче событие останется в outbox.
    this.outbox.drainOnce().catch(() => {});

    return order;
  }

  /**
   * Просит inventory-service списать ингредиенты по техкартам заказа.
   * Идемпотентно на стороне inventory-service (проверка по reference_id),
   * поэтому повторный переход статуса не списывает дважды.
   */
  private async deductStockForOrder(order: any): Promise<void> {
    if (!config.autoDeductStock) return;
    if (!config.internalToken) {
      logger.warn('AUTO_DEDUCT_STOCK включён, но INTERNAL_TOKEN не задан — списание пропущено');
      return;
    }

    try {
      // Основной склад заведения: списываем с него
      const warehouse = await this.pool.query(
        `SELECT id FROM warehouses
         WHERE restaurant_id = $1 AND is_active = true
         ORDER BY (warehouse_type = 'main') DESC, created_at ASC
         LIMIT 1`,
        [order.restaurant_id]
      );
      const warehouseId = warehouse.rows[0]?.id;
      if (!warehouseId) {
        logger.info(`Order ${order.order_number}: у заведения нет склада, списание пропущено`);
        return;
      }

      const response = await fetch(`${config.inventoryServiceUrl}/api/inventory/deduct-by-order`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': config.internalToken
        },
        body: JSON.stringify({
          orderId: order.id,
          warehouseId,
          enterpriseId: order.enterprise_id || undefined
        })
      });

      if (!response.ok) {
        const text = await response.text();
        logger.error(
          `Order ${order.order_number}: списание по техкартам не удалось ` +
          `(${response.status}): ${text}`
        );
        return;
      }
      const result: any = await response.json();
      logger.info(
        `Order ${order.order_number}: списано позиций ${result.deducted?.length ?? 0}` +
        (result.skipped?.length ? `, пропущено: ${result.skipped.join('; ')}` : '')
      );
    } catch (err) {
      logger.error(
        `Order ${order.order_number}: ошибка вызова списания по техкартам: ${(err as Error).message}`
      );
    }
  }

  async splitOrder(orderId: string, itemGroups: Array<{ itemIds: string[] }>, enterpriseId?: string): Promise<any[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Read parent WITHIN the transaction with row lock to prevent
      // concurrent updates between read and child order inserts (H5 fix).
      // Tenant isolation: scope parent by enterprise_id when provided.
      const parentConds = ['o.id = $1'];
      const parentVals: any[] = [orderId];
      if (enterpriseId) {
        parentConds.push('o.enterprise_id = $2');
        parentVals.push(enterpriseId);
      }
      const parentResult = await client.query(
        `SELECT o.* FROM orders o WHERE ${parentConds.join(' AND ')} FOR UPDATE`,
        parentVals
      );
      if (parentResult.rows.length === 0) {
        throw new OrderError('Order not found', 404);
      }
      const parent = parentResult.rows[0];

      const itemsResult = await client.query(
        `SELECT oi.* FROM order_items oi WHERE oi.order_id = $1`,
        [orderId]
      );
      parent.items = itemsResult.rows;

      // Mark parent as split
      await client.query(
        'UPDATE orders SET is_split = true WHERE id = $1',
        [orderId]
      );

      const childOrders: any[] = [];

      for (const group of itemGroups) {
        // Get items for this split
        const items = parent.items.filter((i: any) => group.itemIds.includes(i.id));
        if (items.length === 0) continue;

        const subtotal = items.reduce((sum: number, i: any) => sum + parseFloat(i.subtotal), 0);
        const total = subtotal; // Simplified: no extra fees on splits

        const childResult = await client.query(
          `INSERT INTO orders (
            order_number, customer_id, restaurant_id, delivery_address_id,
            status, subtotal, delivery_fee, tax, total, payment_method,
            order_type, table_id, parent_order_id, enterprise_id
          ) VALUES ($1, $2, $3, $4, $5, $6, 0, 0, $7, $8, $9, $10, $11, $12)
          RETURNING *`,
          [
            this.generateOrderNumber(),
            parent.customer_id,
            parent.restaurant_id,
            parent.delivery_address_id,
            parent.status,
            subtotal,
            total,
            parent.payment_method,
            parent.order_type,
            parent.table_id,
            orderId,
            parent.enterprise_id
          ]
        );

        const child = childResult.rows[0];

        // Copy items to child order
        for (const item of items) {
          await client.query(
            `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price, subtotal, special_instructions)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [child.id, item.menu_item_id, item.quantity, item.unit_price, item.subtotal, item.special_instructions]
          );
        }

        childOrders.push(child);
      }

      await client.query('COMMIT');
      return childOrders;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class OrderError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'OrderError';
  }
}

export default OrderService;
