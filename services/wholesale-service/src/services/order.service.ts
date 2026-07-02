import pkg from 'pg';
const { Pool } = pkg;

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Оптовые заказы: жизненный цикл draft → confirmed → assembled → shipped →
 * delivered → closed. Отгрузка списывает готовую продукцию со склада по FIFO
 * и фиксирует фактическую себестоимость; долг контрагента растёт при отгрузке
 * и гасится оплатами.
 */
export class WholesaleOrderService {
  private pool: InstanceType<typeof Pool>;

  constructor(pool: InstanceType<typeof Pool>) {
    this.pool = pool;
  }

  // ── Чтение ────────────────────────────────────────────────────────────────

  async list(filters: {
    enterpriseId?: string; counterpartyId?: string; status?: string;
    driverId?: string; managerId?: string; from?: string; to?: string;
    limit?: number; offset?: number;
  }): Promise<any[]> {
    const conditions: string[] = [];
    const values: any[] = [];
    let p = 1;
    if (filters.enterpriseId) { conditions.push(`o.enterprise_id = $${p++}`); values.push(filters.enterpriseId); }
    if (filters.counterpartyId) { conditions.push(`o.counterparty_id = $${p++}`); values.push(filters.counterpartyId); }
    if (filters.status) { conditions.push(`o.status = $${p++}`); values.push(filters.status); }
    if (filters.driverId) { conditions.push(`o.driver_id = $${p++}`); values.push(filters.driverId); }
    if (filters.managerId) { conditions.push(`o.manager_id = $${p++}`); values.push(filters.managerId); }
    if (filters.from) { conditions.push(`o.created_at >= $${p++}`); values.push(filters.from); }
    if (filters.to) { conditions.push(`o.created_at <= $${p++}`); values.push(filters.to); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    values.push(filters.limit || 100, filters.offset || 0);

    const result = await this.pool.query(
      `SELECT o.*, c.name AS counterparty_name, c.phone AS counterparty_phone,
              w.name AS warehouse_name,
              m.first_name AS manager_first_name, m.last_name AS manager_last_name,
              d.first_name AS driver_first_name, d.last_name AS driver_last_name
       FROM wholesale_orders o
       INNER JOIN counterparties c ON o.counterparty_id = c.id
       LEFT JOIN warehouses w ON o.warehouse_id = w.id
       LEFT JOIN users m ON o.manager_id = m.id
       LEFT JOIN users d ON o.driver_id = d.id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT $${p++} OFFSET $${p}`,
      values
    );
    return result.rows;
  }

  async getById(id: string, enterpriseId?: string): Promise<any | null> {
    const conds = ['o.id = $1'];
    const vals: any[] = [id];
    if (enterpriseId) { conds.push('o.enterprise_id = $2'); vals.push(enterpriseId); }
    const result = await this.pool.query(
      `SELECT o.*, c.name AS counterparty_name, c.phone AS counterparty_phone,
              c.whatsapp_phone AS counterparty_whatsapp, c.legal_name AS counterparty_legal_name,
              c.tax_id AS counterparty_tax_id, c.delivery_address AS counterparty_delivery_address,
              w.name AS warehouse_name,
              m.first_name AS manager_first_name, m.last_name AS manager_last_name,
              d.first_name AS driver_first_name, d.last_name AS driver_last_name
       FROM wholesale_orders o
       INNER JOIN counterparties c ON o.counterparty_id = c.id
       LEFT JOIN warehouses w ON o.warehouse_id = w.id
       LEFT JOIN users m ON o.manager_id = m.id
       LEFT JOIN users d ON o.driver_id = d.id
       WHERE ${conds.join(' AND ')}`,
      vals
    );
    const order = result.rows[0];
    if (!order) return null;
    const items = await this.pool.query(
      `SELECT oi.*, ii.unit AS item_unit, ii.sku
       FROM wholesale_order_items oi
       INNER JOIN inventory_items ii ON oi.inventory_item_id = ii.id
       WHERE oi.order_id = $1
       ORDER BY oi.name`,
      [id]
    );
    const payments = await this.pool.query(
      `SELECT p.*, u.first_name AS received_by_first_name, u.last_name AS received_by_last_name
       FROM counterparty_payments p
       LEFT JOIN users u ON p.received_by = u.id
       WHERE p.order_id = $1 ORDER BY p.created_at`,
      [id]
    );
    return { ...order, items: items.rows, payments: payments.rows };
  }

  // ── Создание и редактирование ────────────────────────────────────────────

  async create(data: any, userId?: string, enterpriseId?: string): Promise<any> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const cpConds = ['id = $1', 'is_active = true'];
      const cpVals: any[] = [data.counterpartyId];
      if (enterpriseId) { cpConds.push('enterprise_id = $2'); cpVals.push(enterpriseId); }
      const cpResult = await client.query(`SELECT * FROM counterparties WHERE ${cpConds.join(' AND ')}`, cpVals);
      const counterparty = cpResult.rows[0];
      if (!counterparty) throw new Error('Counterparty not found');

      const orderResult = await client.query(
        `INSERT INTO wholesale_orders (enterprise_id, counterparty_id, warehouse_id, manager_id,
           delivery_date, delivery_address, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [enterpriseId || null, data.counterpartyId, data.warehouseId || null,
         data.managerId || userId || null, data.deliveryDate || null,
         data.deliveryAddress || counterparty.delivery_address || null, data.notes || null]
      );
      const order = orderResult.rows[0];

      const total = await this.insertItems(client, order.id, data.items, counterparty.price_type);
      const updated = await client.query(
        'UPDATE wholesale_orders SET total_amount = $1 WHERE id = $2 RETURNING *', [total, order.id]
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

  private async insertItems(client: any, orderId: string, items: any[], priceType: string): Promise<number> {
    let total = 0;
    for (const item of items) {
      const itemResult = await client.query(
        'SELECT * FROM inventory_items WHERE id = $1 AND is_active = true', [item.inventoryItemId]
      );
      const invItem = itemResult.rows[0];
      if (!invItem) throw new Error(`Inventory item ${item.inventoryItemId} not found`);

      let price = item.price;
      if (price === undefined || price === null) {
        price = priceType === 'retail'
          ? (invItem.retail_price ?? invItem.wholesale_price)
          : (invItem.wholesale_price ?? invItem.retail_price);
        if (price === null || price === undefined) {
          throw new Error(`No price set for "${invItem.name}" — задайте оптовую/розничную цену или укажите цену вручную`);
        }
        price = parseFloat(price);
      }
      const lineTotal = Math.round(price * item.quantity * 100) / 100;
      total += lineTotal;

      await client.query(
        `INSERT INTO wholesale_order_items (order_id, inventory_item_id, name, quantity, unit, price, total)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [orderId, item.inventoryItemId, invItem.name, item.quantity, invItem.unit, price, lineTotal]
      );
    }
    return Math.round(total * 100) / 100;
  }

  async update(id: string, data: any, enterpriseId?: string): Promise<any | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const order = await this.lockOrder(client, id, enterpriseId);
      if (!order) { await client.query('ROLLBACK'); return null; }
      if (order.status !== 'draft') throw new Error(`Order can only be edited in draft status (current: ${order.status})`);

      const map: Record<string, string> = {
        warehouseId: 'warehouse_id', deliveryDate: 'delivery_date',
        deliveryAddress: 'delivery_address', notes: 'notes', managerId: 'manager_id'
      };
      const fields: string[] = [];
      const values: any[] = [];
      let p = 1;
      for (const [k, col] of Object.entries(map)) {
        if (data[k] !== undefined) { fields.push(`${col} = $${p++}`); values.push(data[k]); }
      }
      if (fields.length) {
        values.push(id);
        await client.query(
          `UPDATE wholesale_orders SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${p}`, values
        );
      }

      if (data.items) {
        await client.query('DELETE FROM wholesale_order_items WHERE order_id = $1', [id]);
        const cp = await client.query('SELECT price_type FROM counterparties WHERE id = $1', [order.counterparty_id]);
        const total = await this.insertItems(client, id, data.items, cp.rows[0]?.price_type || 'wholesale');
        await client.query('UPDATE wholesale_orders SET total_amount = $1, updated_at = NOW() WHERE id = $2', [total, id]);
      }

      await client.query('COMMIT');
      return this.getById(id, enterpriseId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // ── Статусы ──────────────────────────────────────────────────────────────

  private async lockOrder(client: any, id: string, enterpriseId?: string): Promise<any | null> {
    const conds = ['id = $1'];
    const vals: any[] = [id];
    if (enterpriseId) { conds.push('enterprise_id = $2'); vals.push(enterpriseId); }
    const r = await client.query(`SELECT * FROM wholesale_orders WHERE ${conds.join(' AND ')} FOR UPDATE`, vals);
    return r.rows[0] || null;
  }

  private async nextDocNumber(client: any, enterpriseId: string | undefined, docType: string, prefix: string): Promise<string> {
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

  async confirm(id: string, enterpriseId?: string): Promise<any> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const order = await this.lockOrder(client, id, enterpriseId);
      if (!order) throw new Error('Order not found');
      if (order.status !== 'draft') throw new Error(`Cannot confirm order in status ${order.status}`);

      const items = await client.query('SELECT COUNT(*) AS n FROM wholesale_order_items WHERE order_id = $1', [id]);
      if (parseInt(items.rows[0].n, 10) === 0) throw new Error('Cannot confirm order without items');

      // Контроль кредитного лимита для отсрочки платежа
      const cp = await client.query('SELECT * FROM counterparties WHERE id = $1 FOR UPDATE', [order.counterparty_id]);
      const counterparty = cp.rows[0];
      if (counterparty.payment_terms === 'deferred') {
        const creditLimit = parseFloat(counterparty.credit_limit) || 0;
        const balance = parseFloat(counterparty.balance) || 0;
        const orderTotal = parseFloat(order.total_amount) || 0;
        if (creditLimit > 0 && balance + orderTotal > creditLimit) {
          throw new Error(
            `Credit limit exceeded: долг ${balance.toFixed(2)} + заказ ${orderTotal.toFixed(2)} > лимит ${creditLimit.toFixed(2)}`
          );
        }
      }

      const invoiceNumber = order.invoice_number || await this.nextDocNumber(client, enterpriseId, 'invoice', 'НК');
      const updated = await client.query(
        `UPDATE wholesale_orders SET status = 'confirmed', invoice_number = $1, confirmed_at = NOW(), updated_at = NOW()
         WHERE id = $2 RETURNING *`,
        [invoiceNumber, id]
      );
      await client.query('COMMIT');
      return updated.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async assemble(id: string, enterpriseId?: string): Promise<any> {
    return this.simpleTransition(id, ['confirmed'], 'assembled', enterpriseId);
  }

  private async simpleTransition(id: string, fromStatuses: string[], toStatus: string, enterpriseId?: string, extraSet = ''): Promise<any> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const order = await this.lockOrder(client, id, enterpriseId);
      if (!order) throw new Error('Order not found');
      if (!fromStatuses.includes(order.status)) {
        throw new Error(`Cannot move order from ${order.status} to ${toStatus}`);
      }
      const updated = await client.query(
        `UPDATE wholesale_orders SET status = $1${extraSet}, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [toStatus, id]
      );
      await client.query('COMMIT');
      return updated.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Отгрузка: FIFO-списание каждой позиции со склада, фиксация фактической
   * себестоимости, назначение водителя, долг контрагента += сумма накладной.
   */
  async ship(id: string, data: { driverId?: string }, userId?: string, enterpriseId?: string): Promise<any> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const order = await this.lockOrder(client, id, enterpriseId);
      if (!order) throw new Error('Order not found');
      if (!['confirmed', 'assembled'].includes(order.status)) {
        throw new Error(`Cannot ship order in status ${order.status}`);
      }
      if (!order.warehouse_id) throw new Error('Order has no warehouse assigned');

      const items = await client.query('SELECT * FROM wholesale_order_items WHERE order_id = $1', [id]);
      let totalCost = 0;

      for (const item of items.rows) {
        const qty = parseFloat(item.quantity);

        // FIFO-партии под блокировкой — фактическая себестоимость отгрузки
        const batchResult = await client.query(
          `SELECT * FROM inventory_batches
           WHERE warehouse_id = $1 AND inventory_item_id = $2 AND is_depleted = false
           ORDER BY received_at ASC FOR UPDATE`,
          [order.warehouse_id, item.inventory_item_id]
        );
        let remaining = qty;
        let itemCost = 0;
        for (const batch of batchResult.rows) {
          if (remaining <= 0) break;
          const available = parseFloat(batch.quantity);
          const toDeduct = Math.min(available, remaining);
          if (toDeduct >= available) {
            await client.query('UPDATE inventory_batches SET quantity = 0, is_depleted = true WHERE id = $1', [batch.id]);
          } else {
            await client.query('UPDATE inventory_batches SET quantity = quantity - $1 WHERE id = $2', [toDeduct, batch.id]);
          }
          itemCost += toDeduct * (parseFloat(batch.cost_price) || 0);
          remaining -= toDeduct;
        }
        if (remaining > 0) {
          throw new Error(`Insufficient stock for "${item.name}": requested ${qty}, available ${qty - remaining}`);
        }

        const deduct = await client.query(
          `UPDATE inventory_stock SET quantity = quantity - $1, updated_at = NOW()
           WHERE warehouse_id = $2 AND inventory_item_id = $3 AND quantity >= $1 RETURNING quantity`,
          [qty, order.warehouse_id, item.inventory_item_id]
        );
        if (deduct.rowCount === 0) throw new Error(`Insufficient stock for "${item.name}" (need ${qty})`);

        const unitCost = qty > 0 ? itemCost / qty : 0;
        await client.query(
          `INSERT INTO stock_movements (enterprise_id, warehouse_id, inventory_item_id, movement_type,
             quantity, cost_price, reference_type, reference_id, performed_by, notes)
           VALUES ($1, $2, $3, 'sale', $4, $5, 'wholesale_order', $6, $7, $8)`,
          [order.enterprise_id, order.warehouse_id, item.inventory_item_id, qty, unitCost, id,
           userId || null, `Отгрузка ${order.invoice_number || ''}`]
        );
        await client.query(
          'UPDATE wholesale_order_items SET cost_price = $1, shipped_quantity = $2 WHERE id = $3',
          [unitCost, qty, item.id]
        );
        totalCost += itemCost;
      }

      // Долг контрагента растёт на сумму отгрузки
      await client.query(
        'UPDATE counterparties SET balance = balance + $1, updated_at = NOW() WHERE id = $2',
        [order.total_amount, order.counterparty_id]
      );

      const updated = await client.query(
        `UPDATE wholesale_orders
         SET status = 'shipped', total_cost = $1, driver_id = COALESCE($2, driver_id), shipped_at = NOW(), updated_at = NOW()
         WHERE id = $3 RETURNING *`,
        [Math.round(totalCost * 100) / 100, data.driverId || null, id]
      );
      await client.query('COMMIT');
      return updated.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async deliver(id: string, enterpriseId?: string): Promise<any> {
    return this.simpleTransition(id, ['shipped'], 'delivered', enterpriseId, ', delivered_at = NOW()');
  }

  async closeOrder(id: string, enterpriseId?: string): Promise<any> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const order = await this.lockOrder(client, id, enterpriseId);
      if (!order) throw new Error('Order not found');
      if (order.status !== 'delivered') throw new Error(`Cannot close order in status ${order.status}`);
      if (order.payment_status !== 'paid') {
        const cp = await client.query('SELECT payment_terms FROM counterparties WHERE id = $1', [order.counterparty_id]);
        if (cp.rows[0]?.payment_terms !== 'deferred') {
          throw new Error('Order is not fully paid — закрыть можно только оплаченный заказ (кроме контрагентов с отсрочкой)');
        }
      }
      const updated = await client.query(
        `UPDATE wholesale_orders SET status = 'closed', updated_at = NOW() WHERE id = $1 RETURNING *`, [id]
      );
      await client.query('COMMIT');
      return updated.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async cancel(id: string, enterpriseId?: string): Promise<any> {
    return this.simpleTransition(id, ['draft', 'confirmed', 'assembled'], 'cancelled', enterpriseId);
  }

  // ── Оплаты ───────────────────────────────────────────────────────────────

  /**
   * Оплата по заказу: запись в counterparty_payments, погашение долга
   * контрагента, пересчёт статуса оплаты заказа.
   */
  async pay(id: string, data: { amount: number; method: string; registerId?: string; notes?: string },
            userId?: string, enterpriseId?: string): Promise<any> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const order = await this.lockOrder(client, id, enterpriseId);
      if (!order) throw new Error('Order not found');
      if (!['confirmed', 'assembled', 'shipped', 'delivered', 'closed'].includes(order.status)) {
        throw new Error(`Cannot register payment for order in status ${order.status}`);
      }

      const payment = await client.query(
        `INSERT INTO counterparty_payments (enterprise_id, counterparty_id, order_id, payment_type,
           amount, method, register_id, received_by, notes)
         VALUES ($1, $2, $3, 'payment', $4, $5, $6, $7, $8) RETURNING *`,
        [order.enterprise_id, order.counterparty_id, id, data.amount, data.method,
         data.registerId || null, userId || null, data.notes || null]
      );

      const newPaid = (parseFloat(order.paid_amount) || 0) + data.amount;
      const total = parseFloat(order.total_amount) || 0;
      const paymentStatus = newPaid >= total - 0.005 ? 'paid' : (newPaid > 0 ? 'partial' : 'unpaid');
      const updated = await client.query(
        `UPDATE wholesale_orders SET paid_amount = $1, payment_status = $2, updated_at = NOW()
         WHERE id = $3 RETURNING *`,
        [newPaid, paymentStatus, id]
      );

      // Оплата гасит долг контрагента
      await client.query(
        'UPDATE counterparties SET balance = balance - $1, updated_at = NOW() WHERE id = $2',
        [data.amount, order.counterparty_id]
      );

      await client.query('COMMIT');
      return { order: updated.rows[0], payment: payment.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export default WholesaleOrderService;
