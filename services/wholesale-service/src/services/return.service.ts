import pkg from 'pg';
const { Pool } = pkg;

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Возвраты по оптовым отгрузкам. По каждой позиции решение:
 * restock — вернуть на склад (приход по себестоимости отгрузки),
 * write_off — списать (порча, на склад не возвращается).
 * Подтверждённый возврат создаёт кредит-ноту и гасит долг контрагента.
 */
export class WholesaleReturnService {
  private pool: InstanceType<typeof Pool>;

  constructor(pool: InstanceType<typeof Pool>) {
    this.pool = pool;
  }

  async list(filters: {
    enterpriseId?: string; orderId?: string; counterpartyId?: string; status?: string;
    from?: string; to?: string; limit?: number; offset?: number;
  }): Promise<any[]> {
    const conditions: string[] = [];
    const values: any[] = [];
    let p = 1;
    if (filters.enterpriseId) { conditions.push(`r.enterprise_id = $${p++}`); values.push(filters.enterpriseId); }
    if (filters.orderId) { conditions.push(`r.order_id = $${p++}`); values.push(filters.orderId); }
    if (filters.counterpartyId) { conditions.push(`r.counterparty_id = $${p++}`); values.push(filters.counterpartyId); }
    if (filters.status) { conditions.push(`r.status = $${p++}`); values.push(filters.status); }
    if (filters.from) { conditions.push(`r.created_at >= $${p++}`); values.push(filters.from); }
    if (filters.to) { conditions.push(`r.created_at <= $${p++}`); values.push(filters.to); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    values.push(filters.limit || 100, filters.offset || 0);

    const result = await this.pool.query(
      `SELECT r.*, c.name AS counterparty_name, o.invoice_number,
              u.first_name AS processed_by_first_name, u.last_name AS processed_by_last_name
       FROM wholesale_returns r
       INNER JOIN counterparties c ON r.counterparty_id = c.id
       INNER JOIN wholesale_orders o ON r.order_id = o.id
       LEFT JOIN users u ON r.processed_by = u.id
       ${where}
       ORDER BY r.created_at DESC
       LIMIT $${p++} OFFSET $${p}`,
      values
    );
    return result.rows;
  }

  async getById(id: string, enterpriseId?: string): Promise<any | null> {
    const conds = ['r.id = $1'];
    const vals: any[] = [id];
    if (enterpriseId) { conds.push('r.enterprise_id = $2'); vals.push(enterpriseId); }
    const result = await this.pool.query(
      `SELECT r.*, c.name AS counterparty_name, o.invoice_number
       FROM wholesale_returns r
       INNER JOIN counterparties c ON r.counterparty_id = c.id
       INNER JOIN wholesale_orders o ON r.order_id = o.id
       WHERE ${conds.join(' AND ')}`,
      vals
    );
    const ret = result.rows[0];
    if (!ret) return null;
    const items = await this.pool.query(
      `SELECT ri.*, ii.unit AS item_unit, ii.name AS item_name
       FROM wholesale_return_items ri
       INNER JOIN inventory_items ii ON ri.inventory_item_id = ii.id
       WHERE ri.return_id = $1`,
      [id]
    );
    return { ...ret, items: items.rows };
  }

  async create(orderId: string, data: {
    reason?: string;
    items: Array<{ orderItemId: string; quantity: number; disposition: string; reason?: string }>;
  }, userId?: string, enterpriseId?: string): Promise<any> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const conds = ['id = $1'];
      const vals: any[] = [orderId];
      if (enterpriseId) { conds.push('enterprise_id = $2'); vals.push(enterpriseId); }
      const orderResult = await client.query(`SELECT * FROM wholesale_orders WHERE ${conds.join(' AND ')} FOR UPDATE`, vals);
      const order = orderResult.rows[0];
      if (!order) throw new Error('Order not found');
      if (!['shipped', 'delivered', 'closed'].includes(order.status)) {
        throw new Error(`Returns are only possible for shipped orders (current status: ${order.status})`);
      }

      const retResult = await client.query(
        `INSERT INTO wholesale_returns (enterprise_id, order_id, counterparty_id, reason, processed_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [order.enterprise_id, orderId, order.counterparty_id, data.reason || null, userId || null]
      );
      const ret = retResult.rows[0];

      let total = 0;
      for (const item of data.items) {
        const oiResult = await client.query(
          'SELECT * FROM wholesale_order_items WHERE id = $1 AND order_id = $2 FOR UPDATE',
          [item.orderItemId, orderId]
        );
        const orderItem = oiResult.rows[0];
        if (!orderItem) throw new Error(`Order item ${item.orderItemId} not found in this order`);

        const shipped = parseFloat(orderItem.shipped_quantity ?? orderItem.quantity);
        const alreadyReturned = parseFloat(orderItem.returned_quantity) || 0;
        if (item.quantity > shipped - alreadyReturned + 0.0005) {
          throw new Error(
            `Cannot return ${item.quantity} of "${orderItem.name}": отгружено ${shipped}, уже возвращено ${alreadyReturned}`
          );
        }

        const price = parseFloat(orderItem.price);
        total += price * item.quantity;

        await client.query(
          `INSERT INTO wholesale_return_items (return_id, order_item_id, inventory_item_id, quantity, price, disposition, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [ret.id, item.orderItemId, orderItem.inventory_item_id, item.quantity, price,
           item.disposition, item.reason || null]
        );
      }

      total = Math.round(total * 100) / 100;
      const updated = await client.query(
        'UPDATE wholesale_returns SET total_amount = $1 WHERE id = $2 RETURNING *', [total, ret.id]
      );

      await client.query('COMMIT');
      return this.getById(updated.rows[0].id, enterpriseId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Подтверждение возврата: движение товара (restock — на склад по
   * себестоимости отгрузки; write_off — только фиксация порчи),
   * кредит-нота и погашение долга контрагента.
   */
  async confirm(id: string, userId?: string, enterpriseId?: string): Promise<any> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const conds = ['id = $1', `status = 'draft'`];
      const vals: any[] = [id];
      if (enterpriseId) { conds.push('enterprise_id = $2'); vals.push(enterpriseId); }
      const retResult = await client.query(`SELECT * FROM wholesale_returns WHERE ${conds.join(' AND ')} FOR UPDATE`, vals);
      const ret = retResult.rows[0];
      if (!ret) throw new Error('Return not found or not in draft status');

      const orderResult = await client.query('SELECT * FROM wholesale_orders WHERE id = $1 FOR UPDATE', [ret.order_id]);
      const order = orderResult.rows[0];

      const items = await client.query(
        `SELECT ri.*, oi.cost_price AS shipped_cost_price, oi.name AS item_name
         FROM wholesale_return_items ri
         INNER JOIN wholesale_order_items oi ON ri.order_item_id = oi.id
         WHERE ri.return_id = $1`,
        [id]
      );

      for (const item of items.rows) {
        const qty = parseFloat(item.quantity);

        // Контроль лимита возврата на момент подтверждения
        const upd = await client.query(
          `UPDATE wholesale_order_items
           SET returned_quantity = returned_quantity + $1
           WHERE id = $2 AND returned_quantity + $1 <= COALESCE(shipped_quantity, quantity) + 0.0005
           RETURNING *`,
          [qty, item.order_item_id]
        );
        if (upd.rowCount === 0) throw new Error(`Return quantity exceeds shipped quantity for "${item.item_name}"`);

        if (item.disposition === 'restock') {
          const costPrice = parseFloat(item.shipped_cost_price) || 0;
          await client.query(
            `INSERT INTO inventory_stock (warehouse_id, inventory_item_id, quantity)
             VALUES ($1, $2, $3)
             ON CONFLICT (warehouse_id, inventory_item_id)
             DO UPDATE SET quantity = inventory_stock.quantity + $3, updated_at = NOW()`,
            [order.warehouse_id, item.inventory_item_id, qty]
          );
          await client.query(
            `INSERT INTO inventory_batches (inventory_item_id, warehouse_id, enterprise_id, batch_number, quantity, cost_price)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [item.inventory_item_id, order.warehouse_id, ret.enterprise_id, `RET-${ret.id.slice(0, 8)}`, qty, costPrice]
          );
          await client.query(
            `INSERT INTO stock_movements (enterprise_id, warehouse_id, inventory_item_id, movement_type,
               quantity, cost_price, reference_type, reference_id, performed_by, notes)
             VALUES ($1, $2, $3, 'return', $4, $5, 'wholesale_return', $6, $7, $8)`,
            [ret.enterprise_id, order.warehouse_id, item.inventory_item_id, qty, costPrice, ret.id,
             userId || null, `Возврат по ${order.invoice_number || order.id}`]
          );
        }
        // write_off: товар не возвращается на склад — потеря фиксируется
        // строкой wholesale_return_items (disposition = write_off)
      }

      // Кредит-нота гасит долг контрагента
      const total = parseFloat(ret.total_amount) || 0;
      if (total > 0) {
        await client.query(
          `INSERT INTO counterparty_payments (enterprise_id, counterparty_id, order_id, payment_type, amount, method, received_by, notes)
           VALUES ($1, $2, $3, 'credit_note', $4, 'offset', $5, $6)`,
          [ret.enterprise_id, ret.counterparty_id, ret.order_id, total, userId || null,
           `Кредит-нота по возврату ${ret.return_number || ''}`]
        );
        await client.query(
          'UPDATE counterparties SET balance = balance - $1, updated_at = NOW() WHERE id = $2',
          [total, ret.counterparty_id]
        );
      }

      const returnNumber = ret.return_number || await this.nextDocNumber(client, ret.enterprise_id, 'return', 'ВЗ');
      const updated = await client.query(
        `UPDATE wholesale_returns SET status = 'confirmed', return_number = $1, confirmed_at = NOW() WHERE id = $2 RETURNING *`,
        [returnNumber, id]
      );

      await client.query('COMMIT');
      return this.getById(updated.rows[0].id, enterpriseId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async nextDocNumber(client: any, enterpriseId: string | null, docType: string, prefix: string): Promise<string> {
    const r = await client.query(
      `INSERT INTO wholesale_doc_counters (enterprise_id, doc_type, doc_date, counter)
       VALUES ($1, $2, CURRENT_DATE, 1)
       ON CONFLICT (enterprise_id, doc_type, doc_date)
       DO UPDATE SET counter = wholesale_doc_counters.counter + 1
       RETURNING counter, to_char(doc_date, 'YYYYMMDD') AS d`,
      [enterpriseId || ZERO_UUID, docType]
    );
    const { counter, d } = r.rows[0];
    return `${prefix}-${d}-${String(counter).padStart(3, '0')}`;
  }

  async cancel(id: string, enterpriseId?: string): Promise<any> {
    const conds = ['id = $1', `status = 'draft'`];
    const vals: any[] = [id];
    if (enterpriseId) { conds.push('enterprise_id = $2'); vals.push(enterpriseId); }
    const r = await this.pool.query(
      `UPDATE wholesale_returns SET status = 'cancelled' WHERE ${conds.join(' AND ')} RETURNING *`, vals
    );
    if (!r.rows[0]) throw new Error('Return not found or not in draft status');
    return r.rows[0];
  }

  /** Отчёт по возвратам и списаниям за период */
  async getReturnsReport(filters: { enterpriseId?: string; from?: string; to?: string }): Promise<any> {
    const conditions: string[] = [`r.status = 'confirmed'`];
    const values: any[] = [];
    let p = 1;
    if (filters.enterpriseId) { conditions.push(`r.enterprise_id = $${p++}`); values.push(filters.enterpriseId); }
    if (filters.from) { conditions.push(`r.confirmed_at >= $${p++}`); values.push(filters.from); }
    if (filters.to) { conditions.push(`r.confirmed_at <= $${p++}`); values.push(filters.to); }
    const where = 'WHERE ' + conditions.join(' AND ');

    const summary = await this.pool.query(
      `SELECT COUNT(DISTINCT r.id) AS returns_count,
              COALESCE(SUM(ri.quantity * ri.price), 0) AS total_amount,
              COALESCE(SUM(ri.quantity * ri.price) FILTER (WHERE ri.disposition = 'write_off'), 0) AS written_off_amount,
              COALESCE(SUM(ri.quantity * ri.price) FILTER (WHERE ri.disposition = 'restock'), 0) AS restocked_amount
       FROM wholesale_returns r
       INNER JOIN wholesale_return_items ri ON ri.return_id = r.id
       ${where}`,
      values
    );
    const byItem = await this.pool.query(
      `SELECT ii.name, ri.disposition,
              SUM(ri.quantity) AS quantity, SUM(ri.quantity * ri.price) AS amount
       FROM wholesale_returns r
       INNER JOIN wholesale_return_items ri ON ri.return_id = r.id
       INNER JOIN inventory_items ii ON ri.inventory_item_id = ii.id
       ${where}
       GROUP BY ii.name, ri.disposition
       ORDER BY amount DESC`,
      values
    );
    const byCounterparty = await this.pool.query(
      `SELECT c.name, COUNT(DISTINCT r.id) AS returns_count, SUM(ri.quantity * ri.price) AS amount
       FROM wholesale_returns r
       INNER JOIN wholesale_return_items ri ON ri.return_id = r.id
       INNER JOIN counterparties c ON r.counterparty_id = c.id
       ${where}
       GROUP BY c.name
       ORDER BY amount DESC`,
      values
    );
    return { summary: summary.rows[0], byItem: byItem.rows, byCounterparty: byCounterparty.rows };
  }
}

export default WholesaleReturnService;
