import crypto from 'crypto';
import pkg from 'pg';
import { DiscountService, LoyaltyDiscount, tierDiscountPercent } from './discount.service';
import { OutboxService } from './outbox.service';

const { Pool } = pkg;

export type PosPaymentMethod = 'cash' | 'card';
export type PosOrderType = 'pickup' | 'dine_in';

export interface PosSaleRequest {
  saleId: string;
  restaurantId: string;
  registerId?: string | null;
  orderType: PosOrderType;
  paymentMethod: PosPaymentMethod;
  /** Отложенный чек, который закрывается этой продажей */
  openCheckId?: string | null;
  /** Профиль лояльности (customer_profiles.id), кому начислить баллы */
  customerProfileId?: string | null;
  /** Стол (restaurant_tables.id): заказ «в зале» на этот стол */
  tableId?: string | null;
  items: Array<{
    menuItemId: string;
    quantity: number;
    specialInstructions?: string;
    modifiers?: Array<{ modifierId: string }>;
  }>;
}

export interface PosSaleResponse {
  orderId: string;
  orderNumber: string;
  paymentId: string;
  cashOperationId?: string | null;
  total: number;
  subtotal?: number;
  discountAmount?: number;
  customerName?: string | null;
  tableNumber?: string | null;
  replayed: boolean;
}

export class PosSaleError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'PosSaleError';
  }
}

/**
 * Создаёт все серверные части POS-продажи одной транзакцией.
 * Идемпотентность обеспечивается PK (enterprise_id, sale_id) в Postgres,
 * поэтому параллельные повторы безопасны даже без Redis.
 */
export class PosSaleService {
  constructor(
    private readonly pool: InstanceType<typeof Pool> | any,
    private readonly outbox: OutboxService | any,
    private readonly afterCommit: (order: any) => Promise<void> = async () => undefined
  ) {}

  private stable(value: any): any {
    if (Array.isArray(value)) return value.map((v) => this.stable(v));
    if (value && typeof value === 'object') {
      return Object.keys(value)
        .sort()
        .reduce((out: Record<string, any>, key) => {
          out[key] = this.stable(value[key]);
          return out;
        }, {});
    }
    return value;
  }

  private requestHash(data: PosSaleRequest): string {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(this.stable(data)))
      .digest('hex');
  }

  private orderNumber(): string {
    const now = new Date();
    const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    return `POS-${date}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  }

  private money(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  async create(
    data: PosSaleRequest,
    enterpriseId: string,
    cashierId: string
  ): Promise<PosSaleResponse> {
    const client = await this.pool.connect();
    const hash = this.requestHash(data);
    let committedOrder: any = null;
    let response: PosSaleResponse | null = null;

    try {
      await client.query('BEGIN');

      const claim = await client.query(
        `INSERT INTO pos_sales
           (enterprise_id, sale_id, request_hash, restaurant_id, register_id,
            cashier_id, order_type, payment_method)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (enterprise_id, sale_id) DO NOTHING
         RETURNING sale_id`,
        [
          enterpriseId,
          data.saleId,
          hash,
          data.restaurantId,
          data.registerId || null,
          cashierId,
          data.orderType,
          data.paymentMethod,
        ]
      );

      if (!claim.rowCount) {
        const existing = await client.query(
          `SELECT request_hash, status, response_data
             FROM pos_sales
            WHERE enterprise_id = $1 AND sale_id = $2
            FOR UPDATE`,
          [enterpriseId, data.saleId]
        );
        const row = existing.rows[0];
        if (!row) throw new PosSaleError('Продажа с таким идентификатором не найдена', 409);
        if (row.request_hash !== hash) {
          throw new PosSaleError('saleId уже использован для другой продажи', 409);
        }
        if (row.status !== 'completed' || !row.response_data) {
          throw new PosSaleError('Продажа ещё обрабатывается — повторите запрос', 409);
        }
        response = { ...row.response_data, replayed: true } as PosSaleResponse;
        await client.query('COMMIT');
        return response;
      }

      const restaurantResult = await client.query(
        `SELECT id, name
           FROM restaurants
          WHERE id = $1 AND enterprise_id = $2 AND is_active = true`,
        [data.restaurantId, enterpriseId]
      );
      if (!restaurantResult.rows[0]) {
        throw new PosSaleError('Ресторан не найден в текущем предприятии', 403);
      }

      // Отложенный чек закрывается в этой же транзакции: упадёт продажа —
      // чек останется открытым; два планшета не оплатят его дважды
      if (data.openCheckId) {
        const check = await client.query(
          `UPDATE pos_open_checks
              SET status = 'paid', sale_id = $1, closed_at = NOW(), updated_by = $2, updated_at = NOW()
            WHERE id = $3 AND enterprise_id = $4 AND restaurant_id = $5 AND status = 'open'
            RETURNING id`,
          [data.saleId, cashierId, data.openCheckId, enterpriseId, data.restaurantId]
        );
        if (!check.rows[0]) {
          throw new PosSaleError('Чек уже оплачен, удалён или относится к другой точке', 409);
        }
      }

      // Клиент чека: профиль обязан принадлежать этому же предприятию, иначе
      // кассир мог бы начислить баллы клиенту чужой организации по его id.
      // В orders.customer_id кладём users.id — по нему crm-service находит
      // профиль и начисляет баллы за закрытый заказ.
      let customerUserId: string | null = null;
      let customerName: string | null = null;
      let loyalty: LoyaltyDiscount | null = null;
      if (data.customerProfileId) {
        const cust = await client.query(
          `SELECT cp.user_id, concat_ws(' ', u.first_name, u.last_name) AS name, cp.loyalty_tier,
                  (SELECT lp.tier_discounts FROM loyalty_programs lp
                    WHERE lp.enterprise_id = cp.enterprise_id AND lp.is_active = true
                    ORDER BY (lp.program_type = 'points') DESC, lp.created_at ASC LIMIT 1) AS tier_discounts
             FROM customer_profiles cp
             JOIN users u ON u.id = cp.user_id
            WHERE cp.id = $1 AND cp.enterprise_id = $2`,
          [data.customerProfileId, enterpriseId]
        );
        if (!cust.rows[0]) {
          throw new PosSaleError('Клиент не найден в этом предприятии — выберите его заново', 400);
        }
        customerUserId = cust.rows[0].user_id;
        customerName = cust.rows[0].name || null;
        // Скидка по уровню карты — из программы организации (миграция 065)
        const tier = (cust.rows[0].loyalty_tier || 'bronze').toLowerCase();
        const percent = tierDiscountPercent(cust.rows[0].tier_discounts, tier);
        loyalty = percent > 0 ? { tier, percent } : null;
      }

      // Стол обязан быть активным столом этой же точки и предприятия: иначе
      // чек «повис» бы на столе чужой точки или удалённом столе
      let tableNumber: string | null = null;
      if (data.tableId) {
        const tbl = await client.query(
          `SELECT table_number
             FROM restaurant_tables
            WHERE id = $1 AND restaurant_id = $2 AND enterprise_id = $3 AND is_active = true`,
          [data.tableId, data.restaurantId, enterpriseId]
        );
        if (!tbl.rows[0]) {
          throw new PosSaleError('Стол не найден в этой точке — выберите его заново', 400);
        }
        tableNumber = tbl.rows[0].table_number;
      }
      // Чек на стол — всегда «в зале», даже если касса прислала другой тип
      const orderType = data.tableId ? 'dine_in' : data.orderType;

      const itemIds = [...new Set(data.items.map((item) => item.menuItemId))];
      const menuResult = await client.query(
        `SELECT mi.id, mi.name, mi.price, mi.category_id, mi.no_discount
           FROM menu_items mi
          WHERE mi.id = ANY($1::uuid[])
            AND mi.restaurant_id = $2
            AND mi.enterprise_id = $3
            AND mi.is_available = true
            AND (mi.stopped_at IS NULL OR (mi.stop_until IS NOT NULL AND mi.stop_until < NOW()))`,
        [itemIds, data.restaurantId, enterpriseId]
      );
      const menu = new Map<string, any>(menuResult.rows.map((row: any) => [row.id, row]));
      if (menu.size !== itemIds.length) {
        throw new PosSaleError(
          'Одна или несколько позиций недоступны, находятся в стоп-листе или принадлежат другой точке',
          400
        );
      }

      const requestedModifiers = data.items.flatMap((item) =>
        (item.modifiers || []).map((mod) => ({
          itemId: item.menuItemId,
          modifierId: mod.modifierId,
        }))
      );
      const modifierIds = [...new Set(requestedModifiers.map((mod) => mod.modifierId))];
      const modifiers = new Map<string, any>();
      if (modifierIds.length) {
        const modifierResult = await client.query(
          `SELECT mm.id, mm.menu_item_id, mm.name, mm.price_adjustment, mm.variety_item_id
             FROM menu_item_modifiers mm
            WHERE mm.id = ANY($1::uuid[])
              AND mm.enterprise_id = $2
              AND mm.is_available = true`,
          [modifierIds, enterpriseId]
        );
        modifierResult.rows.forEach((row: any) => modifiers.set(row.id, row));
        const invalid = requestedModifiers.some((mod) => {
          const row = modifiers.get(mod.modifierId);
          return !row || row.menu_item_id !== mod.itemId;
        });
        if (invalid) {
          throw new PosSaleError('Модификатор недоступен или не принадлежит выбранному блюду', 400);
        }
        // Один сорт на ингредиент в строке чека
        for (const item of data.items) {
          const v = (item.modifiers || []).map((m) => modifiers.get(m.modifierId)?.variety_item_id).filter(Boolean);
          if (new Set(v).size !== v.length) throw new PosSaleError('Выберите один сорт', 400);
        }
      }

      if (data.paymentMethod === 'cash') {
        if (!data.registerId)
          throw new PosSaleError('Для наличной оплаты требуется открытая касса', 409);
        const registerResult = await client.query(
          `SELECT id
             FROM cash_registers
            WHERE id = $1 AND restaurant_id = $2 AND enterprise_id = $3 AND status = 'open'
            FOR UPDATE`,
          [data.registerId, data.restaurantId, enterpriseId]
        );
        if (!registerResult.rows[0]) {
          throw new PosSaleError('Кассовая смена закрыта или относится к другой точке', 409);
        }
      }

      let subtotal = 0;
      const orderItems = data.items.map((item) => {
        const menuItem = menu.get(item.menuItemId)!;
        const selected = (item.modifiers || []).map((mod) => modifiers.get(mod.modifierId));
        const modifierTotal = selected.reduce((sum, mod) => sum + Number(mod.price_adjustment), 0);
        const unitPrice = this.money(Number(menuItem.price) + modifierTotal);
        const lineTotal = this.money(unitPrice * item.quantity);
        subtotal = this.money(subtotal + lineTotal);
        return { source: item, menuItem, selected, unitPrice, lineTotal };
      });

      const discounts = await DiscountService.calculateDiscountsInTx(
        client,
        data.restaurantId,
        subtotal,
        orderItems.map((item) => ({
          menuItemId: item.source.menuItemId,
          categoryId: item.menuItem.category_id || undefined,
          subtotal: item.lineTotal,
          noDiscount: !!item.menuItem.no_discount,
        })),
        enterpriseId,
        loyalty
      );
      const total = this.money(Math.max(0, subtotal - discounts.totalDiscount));
      if (total <= 0) throw new PosSaleError('Итог продажи должен быть больше нуля', 400);

      const number = this.orderNumber();
      const orderResult = await client.query(
        `INSERT INTO orders
           (order_number, restaurant_id, status, subtotal, delivery_fee, tax, total,
            payment_status, payment_method, order_type, waiter_id, enterprise_id,
            discount_amount, applied_discounts, customer_id, table_id, confirmed_at, closed_at)
         VALUES ($1, $2, 'completed', $3, 0, 0, $4,
                 'completed', $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
         RETURNING *`,
        [
          number,
          data.restaurantId,
          subtotal,
          total,
          data.paymentMethod,
          orderType,
          cashierId,
          enterpriseId,
          discounts.totalDiscount,
          JSON.stringify(discounts.appliedDiscounts),
          customerUserId,
          data.tableId || null,
        ]
      );
      const order = orderResult.rows[0];
      committedOrder = order;

      for (const item of orderItems) {
        const itemResult = await client.query(
          `INSERT INTO order_items
             (order_id, menu_item_id, quantity, unit_price, subtotal, special_instructions)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [
            order.id,
            item.source.menuItemId,
            item.source.quantity,
            item.unitPrice,
            item.lineTotal,
            item.source.specialInstructions || null,
          ]
        );
        for (const mod of item.selected) {
          await client.query(
            `INSERT INTO order_item_modifiers
               (order_item_id, modifier_id, name, price_adjustment)
             VALUES ($1, $2, $3, $4)`,
            [itemResult.rows[0].id, mod.id, mod.name, Number(mod.price_adjustment)]
          );
        }
      }

      const paymentResult = await client.query(
        `INSERT INTO payments
           (order_id, enterprise_id, amount, payment_method, payment_gateway, status, metadata)
         VALUES ($1, $2, $3, $4, $5, 'completed', $6)
         RETURNING id`,
        [
          order.id,
          enterpriseId,
          total,
          data.paymentMethod,
          data.paymentMethod === 'cash' ? 'cash' : 'terminal',
          JSON.stringify({ source: 'pos', saleId: data.saleId }),
        ]
      );
      const paymentId = paymentResult.rows[0].id;

      let cashOperationId: string | null = null;
      if (data.paymentMethod === 'cash') {
        const cashResult = await client.query(
          `INSERT INTO cash_operations
             (register_id, enterprise_id, operation_type, amount, payment_method,
              order_id, performed_by, description)
           VALUES ($1, $2, 'sale', $3, 'cash', $4, $5, $6)
           RETURNING id`,
          [data.registerId, enterpriseId, total, order.id, cashierId, `POS-продажа ${number}`]
        );
        cashOperationId = cashResult.rows[0].id;
        await client.query(
          `UPDATE cash_registers SET current_balance = current_balance + $1 WHERE id = $2`,
          [total, data.registerId]
        );
      }

      const stored = {
        orderId: order.id,
        orderNumber: order.order_number,
        paymentId,
        cashOperationId,
        subtotal,
        discountAmount: discounts.totalDiscount,
        total,
        customerName,
        tableNumber,
      };
      response = { ...stored, replayed: false };

      await this.outbox.enqueue(client, {
        routingKey: 'order.completed',
        payload: {
          id: order.id,
          orderNumber: order.order_number,
          restaurantId: data.restaurantId,
          enterpriseId,
          status: 'completed',
          total,
          timestamp: new Date().toISOString(),
        },
        aggregateType: 'order',
        aggregateId: order.id,
        enterpriseId,
      });

      await client.query(
        `UPDATE pos_sales
            SET status = 'completed', order_id = $3, payment_id = $4,
                cash_operation_id = $5, total = $6, response_data = $7,
                completed_at = NOW()
          WHERE enterprise_id = $1 AND sale_id = $2`,
        [
          enterpriseId,
          data.saleId,
          order.id,
          paymentId,
          cashOperationId,
          total,
          JSON.stringify(stored),
        ]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    if (!response) throw new PosSaleError('Продажа не была завершена', 500);
    this.outbox.drainOnce().catch(() => undefined);
    if (committedOrder) await this.afterCommit(committedOrder);
    return response;
  }
}
