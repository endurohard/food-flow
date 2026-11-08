import jwt from 'jsonwebtoken';

/** Пул или клиент: в тестах подставляется мок. */
export interface Db {
  query(sql: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>;
  connect?(): Promise<any>;
}

export class PosRefundError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'PosRefundError';
  }
}

export interface Approval {
  approverId: string;
  enterpriseId: string;
  registerId: string;
  sessionId: string;
  cashierId: string;
  action: 'refund' | 'payment_change';
}

const money = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

/**
 * Чеки кассы: просмотр, возврат и смена способа оплаты.
 * Возврат и смена оплаты проходят только с допуском — подписанным токеном,
 * который user-service выдаёт по PIN владельца/админа на эту смену кассы.
 * Деньги, строки чека и журнал возвратов меняются одной транзакцией;
 * товар возвращается на склад после коммита (inventory-service, идемпотентно).
 */
export class PosRefundService {
  constructor(
    private readonly pool: Db | any,
    private readonly secret: string,
    private readonly afterRefund: (p: { orderId: string; refundId: string; enterpriseId: string; performedBy: string;
      items: Array<{ orderItemId: string; quantity: number }> }) => Promise<void> = async () => undefined
  ) {}

  verifyApproval(token: string, expected: { enterpriseId: string; cashierId: string; sessionId: string; action: string }): Approval {
    let a: any;
    try {
      a = jwt.verify(token, this.secret);
    } catch {
      throw new PosRefundError('Подтверждение администратора истекло — введите PIN ещё раз', 403);
    }
    if (a.typ !== 'pos_approval' || a.enterpriseId !== expected.enterpriseId || a.cashierId !== expected.cashierId
        || a.sessionId !== expected.sessionId || a.action !== expected.action) {
      throw new PosRefundError('Подтверждение выдано на другое действие или другую кассу', 403);
    }
    return a as Approval;
  }

  async list(enterpriseId: string, restaurantId: string, date?: string, search?: string): Promise<any[]> {
    const r = await this.pool.query(
      `SELECT o.id, o.order_number, o.created_at, o.subtotal, o.discount_amount, o.total, o.refunded_amount,
              o.payment_method, o.payment_status, o.status,
              trim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')) AS cashier,
              cr.name AS register_name,
              (SELECT json_agg(json_build_object('id', oi.id, 'name', mi.name, 'quantity', oi.quantity,
                       'refundedQuantity', oi.refunded_quantity, 'unitPrice', oi.unit_price, 'subtotal', oi.subtotal)
                       ORDER BY mi.name)
                 FROM order_items oi JOIN menu_items mi ON mi.id = oi.menu_item_id WHERE oi.order_id = o.id) AS items,
              (SELECT json_agg(json_build_object('kind', pr.kind, 'amount', pr.amount, 'reason', pr.reason,
                       'newPaymentMethod', pr.new_payment_method, 'createdAt', pr.created_at,
                       'approvedBy', trim(coalesce(au.first_name, '') || ' ' || coalesce(au.last_name, '')))
                       ORDER BY pr.created_at)
                 FROM pos_refunds pr LEFT JOIN users au ON au.id = pr.approved_by WHERE pr.order_id = o.id) AS history
         FROM pos_sales ps
         JOIN orders o ON o.id = ps.order_id
         LEFT JOIN users u ON u.id = ps.cashier_id
         LEFT JOIN cash_registers cr ON cr.id = ps.register_id
        WHERE ps.enterprise_id = $1 AND ps.restaurant_id = $2 AND ps.status = 'completed'
          AND (o.created_at AT TIME ZONE 'Europe/Moscow')::date = COALESCE($3::date, (NOW() AT TIME ZONE 'Europe/Moscow')::date)
          AND ($4::text IS NULL OR o.order_number ILIKE '%' || $4 || '%')
        ORDER BY o.created_at DESC
        LIMIT 300`,
      [enterpriseId, restaurantId, date || null, search || null]
    );
    return r.rows;
  }

  private async replay(client: any, enterpriseId: string, refundId: string) {
    const r = await client.query(
      `SELECT order_id, kind, amount, payment_method, new_payment_method FROM pos_refunds WHERE enterprise_id = $1 AND refund_id = $2`,
      [enterpriseId, refundId]
    );
    return r.rows[0] || null;
  }

  private async lockOrder(client: any, enterpriseId: string, orderId: string) {
    const r = await client.query(
      `SELECT o.id, o.order_number, o.restaurant_id, o.subtotal, o.total, o.refunded_amount, o.payment_method, o.status
         FROM orders o
        WHERE o.id = $1 AND o.enterprise_id = $2
          AND EXISTS (SELECT 1 FROM pos_sales ps WHERE ps.order_id = o.id AND ps.enterprise_id = $2)
        FOR UPDATE`,
      [orderId, enterpriseId]
    );
    if (!r.rows[0]) throw new PosRefundError('Чек не найден на кассах вашей организации', 404);
    return r.rows[0];
  }

  /** Открытая касса смены — деньги двигаются только через неё. */
  private async lockRegister(client: any, registerId: string, enterpriseId: string, restaurantId: string) {
    const r = await client.query(
      `SELECT id, current_balance FROM cash_registers
        WHERE id = $1 AND enterprise_id = $2 AND restaurant_id = $3 AND status = 'open' FOR UPDATE`,
      [registerId, enterpriseId, restaurantId]
    );
    if (!r.rows[0]) throw new PosRefundError('Касса закрыта или относится к другой точке — откройте смену', 409);
    return r.rows[0];
  }

  async refund(p: {
    enterpriseId: string; cashierId: string; orderId: string; refundId: string; approval: Approval;
    items: Array<{ orderItemId: string; quantity: number }>; reason?: string;
  }) {
    const client = await this.pool.connect();
    let result: any;
    try {
      await client.query('BEGIN');
      const prev = await this.replay(client, p.enterpriseId, p.refundId);
      if (prev) {
        await client.query('COMMIT');
        return { refundId: p.refundId, amount: Number(prev.amount), paymentMethod: prev.payment_method, replayed: true };
      }
      const order = await this.lockOrder(client, p.enterpriseId, p.orderId);
      if (order.status === 'cancelled') throw new PosRefundError('По этому чеку уже сделан полный возврат', 409);

      const lines = await client.query(
        `SELECT id, quantity, refunded_quantity, subtotal FROM order_items WHERE order_id = $1 FOR UPDATE`,
        [p.orderId]
      );
      const byId = new Map<string, any>(lines.rows.map((l: any) => [l.id, l]));
      const total = Number(order.total);
      const subtotal = Number(order.subtotal) || total;
      const ratio = subtotal > 0 ? total / subtotal : 1;   // скидка чека делится по строкам пропорционально
      let amount = 0;
      for (const it of p.items) {
        const l = byId.get(it.orderItemId);
        if (!l) throw new PosRefundError('Позиция не из этого чека', 400);
        const left = Number(l.quantity) - Number(l.refunded_quantity);
        if (it.quantity > left) throw new PosRefundError(`Вернуть можно не больше ${left} шт. этой позиции`, 409);
        amount += Number(l.subtotal) * it.quantity / Number(l.quantity) * ratio;
      }
      amount = money(amount);
      const willRefundAll = lines.rows.every((l: any) => {
        const req = p.items.find((i) => i.orderItemId === l.id);
        return Number(l.refunded_quantity) + (req ? req.quantity : 0) === Number(l.quantity);
      });
      // Последний возврат забирает остаток до копейки — округления не копятся
      if (willRefundAll) amount = money(total - Number(order.refunded_amount));
      amount = Math.min(amount, money(total - Number(order.refunded_amount)));
      if (amount <= 0) throw new PosRefundError('Сумма возврата равна нулю', 400);

      let cashOperationId: string | null = null;
      if (order.payment_method === 'cash') {
        const reg = await this.lockRegister(client, p.approval.registerId, p.enterpriseId, order.restaurant_id);
        if (Number(reg.current_balance) + 1e-9 < amount) {
          throw new PosRefundError(`В кассе ${Number(reg.current_balance).toFixed(2)} ₽ — недостаточно наличных для возврата ${amount.toFixed(2)} ₽`, 409);
        }
        const co = await client.query(
          `INSERT INTO cash_operations (register_id, enterprise_id, operation_type, amount, payment_method, order_id, performed_by, description)
           VALUES ($1, $2, 'refund', $3, 'cash', $4, $5, $6) RETURNING id`,
          [p.approval.registerId, p.enterpriseId, amount, p.orderId, p.cashierId,
           `Возврат по чеку ${order.order_number}${p.reason ? ': ' + p.reason : ''}`]
        );
        cashOperationId = co.rows[0].id;
        await client.query('UPDATE cash_registers SET current_balance = current_balance - $1 WHERE id = $2', [amount, p.approval.registerId]);
      }

      await client.query(
        `INSERT INTO payments (order_id, enterprise_id, amount, payment_method, payment_gateway, status, metadata)
         VALUES ($1, $2, $3, $4, $5, 'refunded', $6)`,
        [p.orderId, p.enterpriseId, amount, order.payment_method, order.payment_method === 'cash' ? 'cash' : 'terminal',
         JSON.stringify({ source: 'pos_refund', refundId: p.refundId, approvedBy: p.approval.approverId })]
      );
      for (const it of p.items) {
        await client.query('UPDATE order_items SET refunded_quantity = refunded_quantity + $1 WHERE id = $2', [it.quantity, it.orderItemId]);
      }
      await client.query(
        `UPDATE orders SET refunded_amount = refunded_amount + $1,
                payment_status = CASE WHEN $2 THEN 'refunded'::payment_status ELSE payment_status END,
                status = CASE WHEN $2 THEN 'cancelled'::order_status ELSE status END,
                updated_at = NOW()
          WHERE id = $3`,
        [amount, willRefundAll, p.orderId]
      );
      await client.query(
        `INSERT INTO pos_refunds (enterprise_id, refund_id, restaurant_id, register_id, order_id, kind, items, amount,
           payment_method, reason, cashier_id, approved_by, cash_operation_id)
         VALUES ($1, $2, $3, $4, $5, 'refund', $6, $7, $8, $9, $10, $11, $12)`,
        [p.enterpriseId, p.refundId, order.restaurant_id, p.approval.registerId, p.orderId, JSON.stringify(p.items), amount,
         order.payment_method, p.reason || null, p.cashierId, p.approval.approverId, cashOperationId]
      );
      await client.query('COMMIT');
      result = { refundId: p.refundId, amount, paymentMethod: order.payment_method, fullRefund: willRefundAll, replayed: false };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    await this.afterRefund({ orderId: p.orderId, refundId: p.refundId, enterpriseId: p.enterpriseId, performedBy: p.cashierId, items: p.items })
      .catch(() => undefined);
    return result;
  }

  /**
   * Смена способа оплаты (пробили наличными, а платили картой, и наоборот).
   * Наличные в кассе двигаются на всю сумму чека; по чеку с возвратами
   * смена запрещена — сумму уже не восстановить однозначно.
   */
  async changePayment(p: { enterpriseId: string; cashierId: string; orderId: string; refundId: string; approval: Approval;
    paymentMethod: 'cash' | 'card'; reason?: string }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const prev = await this.replay(client, p.enterpriseId, p.refundId);
      if (prev) {
        await client.query('COMMIT');
        return { refundId: p.refundId, amount: Number(prev.amount), paymentMethod: prev.new_payment_method, replayed: true };
      }
      const order = await this.lockOrder(client, p.enterpriseId, p.orderId);
      if (Number(order.refunded_amount) > 0 || order.status === 'cancelled') {
        throw new PosRefundError('По чеку уже был возврат — способ оплаты не меняется', 409);
      }
      if (order.payment_method === p.paymentMethod) throw new PosRefundError('Чек уже оплачен этим способом', 409);
      const total = Number(order.total);
      const reg = await this.lockRegister(client, p.approval.registerId, p.enterpriseId, order.restaurant_id);
      let op: string;
      if (p.paymentMethod === 'card') {
        // Был нал, стала карта: наличные из кассы уходят
        if (Number(reg.current_balance) + 1e-9 < total) {
          throw new PosRefundError(`В кассе ${Number(reg.current_balance).toFixed(2)} ₽ — недостаточно, чтобы убрать ${total.toFixed(2)} ₽ наличных`, 409);
        }
        op = 'cash_out';
        await client.query('UPDATE cash_registers SET current_balance = current_balance - $1 WHERE id = $2', [total, reg.id]);
      } else {
        op = 'sale';
        await client.query('UPDATE cash_registers SET current_balance = current_balance + $1 WHERE id = $2', [total, reg.id]);
      }
      const co = await client.query(
        `INSERT INTO cash_operations (register_id, enterprise_id, operation_type, amount, payment_method, order_id, performed_by, description)
         VALUES ($1, $2, $3, $4, 'cash', $5, $6, $7) RETURNING id`,
        [reg.id, p.enterpriseId, op, total, p.orderId, p.cashierId,
         `Смена оплаты чека ${order.order_number}: ${p.paymentMethod === 'card' ? 'наличные → карта' : 'карта → наличные'}`]
      );
      await client.query(`UPDATE orders SET payment_method = $1, updated_at = NOW() WHERE id = $2`, [p.paymentMethod, p.orderId]);
      await client.query(
        `UPDATE payments SET payment_method = $1, payment_gateway = $2 WHERE order_id = $3 AND status = 'completed'`,
        [p.paymentMethod, p.paymentMethod === 'cash' ? 'cash' : 'terminal', p.orderId]
      );
      await client.query(
        `INSERT INTO pos_refunds (enterprise_id, refund_id, restaurant_id, register_id, order_id, kind, items, amount,
           payment_method, new_payment_method, reason, cashier_id, approved_by, cash_operation_id)
         VALUES ($1, $2, $3, $4, $5, 'payment_change', '[]', $6, $7, $8, $9, $10, $11, $12)`,
        [p.enterpriseId, p.refundId, order.restaurant_id, reg.id, p.orderId, total, order.payment_method, p.paymentMethod,
         p.reason || null, p.cashierId, p.approval.approverId, co.rows[0].id]
      );
      await client.query('COMMIT');
      return { refundId: p.refundId, amount: total, paymentMethod: p.paymentMethod, replayed: false };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
}
