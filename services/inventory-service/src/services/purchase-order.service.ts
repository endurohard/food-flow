import { Pool } from 'pg';

/**
 * Заказы поставщикам.
 *
 * Заказ: черновик → отправлен → частично получен / получен (или отменён).
 * Товар на склад приходит не заказом, а накладной: «Создать накладную»
 * делает черновик накладной на остаток к получению, его приёмка записывает
 * полученное в заказ (receiveFromInvoice — в транзакции приёмки).
 */

export class PurchaseOrderError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'PurchaseOrderError'; }
}

export interface OrderItemInput { inventoryItemId: string; quantity: number; pricePerUnit?: number | null }

const EDITABLE = ['draft', 'sent'];

export class PurchaseOrderService {
  private pool: Pool;
  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async list(enterpriseId: string, filters: { status?: string; supplierId?: string } = {}): Promise<any[]> {
    const conds = ['po.enterprise_id = $1'];
    const vals: any[] = [enterpriseId];
    if (filters.status) { vals.push(filters.status); conds.push(`po.status = $${vals.length}`); }
    if (filters.supplierId) { vals.push(filters.supplierId); conds.push(`po.supplier_id = $${vals.length}`); }
    const r = await this.pool.query(
      `SELECT po.*, s.name AS supplier_name, w.name AS warehouse_name,
              COALESCE(t.items_count, 0) AS items_count,
              COALESCE(t.total, 0) AS total_amount,
              CASE WHEN COALESCE(t.ordered, 0) > 0 THEN ROUND(t.received / t.ordered * 100) ELSE 0 END AS received_percent
         FROM purchase_orders po
         LEFT JOIN suppliers s ON s.id = po.supplier_id
         LEFT JOIN warehouses w ON w.id = po.warehouse_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS items_count,
                  SUM(i.quantity * COALESCE(i.price_per_unit, 0)) AS total,
                  SUM(i.quantity) AS ordered,
                  SUM(LEAST(i.received_quantity, i.quantity)) AS received
             FROM purchase_order_items i WHERE i.order_id = po.id
         ) t ON true
        WHERE ${conds.join(' AND ')}
        ORDER BY po.created_at DESC
        LIMIT 300`,
      vals
    );
    return r.rows;
  }

  async get(orderId: string, enterpriseId: string): Promise<any | null> {
    const h = await this.pool.query(
      `SELECT po.*, s.name AS supplier_name, s.phone AS supplier_phone, w.name AS warehouse_name
         FROM purchase_orders po
         LEFT JOIN suppliers s ON s.id = po.supplier_id
         LEFT JOIN warehouses w ON w.id = po.warehouse_id
        WHERE po.id = $1 AND po.enterprise_id = $2`,
      [orderId, enterpriseId]
    );
    if (!h.rows[0]) return null;
    const items = await this.pool.query(
      `SELECT i.*, ii.name AS item_name, ii.unit, ii.cost_price AS last_price
         FROM purchase_order_items i
         JOIN inventory_items ii ON ii.id = i.inventory_item_id
        WHERE i.order_id = $1
        ORDER BY ii.name`,
      [orderId]
    );
    const invoices = await this.pool.query(
      `SELECT id, invoice_number, status, total_amount, invoice_date, received_at
         FROM supply_invoices WHERE purchase_order_id = $1 ORDER BY created_at`,
      [orderId]
    );
    return { ...h.rows[0], items: items.rows, invoices: invoices.rows };
  }

  /** Склад, поставщик и товары должны принадлежать предприятию. */
  private async assertOwned(client: any, enterpriseId: string, data: { supplierId?: string | null; warehouseId?: string | null; itemIds?: string[] }) {
    if (data.supplierId) {
      const r = await client.query('SELECT 1 FROM suppliers WHERE id = $1 AND enterprise_id = $2', [data.supplierId, enterpriseId]);
      if (!r.rows.length) throw new PurchaseOrderError('Поставщик не принадлежит предприятию', 403);
    }
    if (data.warehouseId) {
      const r = await client.query('SELECT 1 FROM warehouses WHERE id = $1 AND enterprise_id = $2', [data.warehouseId, enterpriseId]);
      if (!r.rows.length) throw new PurchaseOrderError('Склад не принадлежит предприятию', 403);
    }
    const ids = Array.from(new Set(data.itemIds || []));
    if (ids.length) {
      const r = await client.query('SELECT id FROM inventory_items WHERE id = ANY($1) AND enterprise_id = $2', [ids, enterpriseId]);
      if (r.rows.length !== ids.length) throw new PurchaseOrderError('Товар не найден на складе предприятия', 403);
    }
  }

  async create(enterpriseId: string, userId: string | undefined, data: {
    supplierId?: string | null; warehouseId?: string | null; expectedDate?: string | null; notes?: string | null; items?: OrderItemInput[];
  }): Promise<any> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const items = data.items || [];
      await this.assertOwned(client, enterpriseId, { supplierId: data.supplierId, warehouseId: data.warehouseId, itemIds: items.map((i) => i.inventoryItemId) });
      let warehouseId = data.warehouseId || null;
      if (!warehouseId) {
        const w = await client.query(
          `SELECT id FROM warehouses WHERE enterprise_id = $1 AND COALESCE(is_active, true)
            ORDER BY (warehouse_type = 'main') DESC, created_at ASC LIMIT 1`, [enterpriseId]);
        warehouseId = w.rows[0]?.id || null;
      }
      const num = await client.query('SELECT next_purchase_order_number($1) AS n', [enterpriseId]);
      const po = await client.query(
        `INSERT INTO purchase_orders (enterprise_id, supplier_id, warehouse_id, order_number, expected_date, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [enterpriseId, data.supplierId || null, warehouseId, num.rows[0].n, data.expectedDate || null, data.notes || null, userId || null]
      );
      for (const it of items) await this.upsertItem(client, po.rows[0].id, it);
      await client.query('COMMIT');
      return po.rows[0];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  private async upsertItem(client: any, orderId: string, it: OrderItemInput) {
    if (!(it.quantity > 0)) throw new PurchaseOrderError('Количество должно быть больше нуля');
    await client.query(
      `INSERT INTO purchase_order_items (order_id, inventory_item_id, quantity, price_per_unit)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (order_id, inventory_item_id)
       DO UPDATE SET quantity = EXCLUDED.quantity, price_per_unit = EXCLUDED.price_per_unit`,
      [orderId, it.inventoryItemId, it.quantity, it.pricePerUnit ?? null]
    );
  }

  /** Заказ под блокировкой, своего предприятия. */
  private async lockOrder(client: any, orderId: string, enterpriseId: string) {
    const r = await client.query(
      'SELECT * FROM purchase_orders WHERE id = $1 AND enterprise_id = $2 FOR UPDATE', [orderId, enterpriseId]);
    if (!r.rows[0]) throw new PurchaseOrderError('Заказ не найден', 404);
    return r.rows[0];
  }

  private async tx<T>(fn: (client: any) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async updateHeader(orderId: string, enterpriseId: string, data: {
    supplierId?: string | null; warehouseId?: string | null; expectedDate?: string | null; notes?: string | null;
  }): Promise<any> {
    return this.tx(async (client) => {
      const po = await this.lockOrder(client, orderId, enterpriseId);
      if (!EDITABLE.includes(po.status)) throw new PurchaseOrderError('Заказ уже в работе — изменить нельзя');
      await this.assertOwned(client, enterpriseId, { supplierId: data.supplierId, warehouseId: data.warehouseId });
      const map: Record<string, string> = { supplierId: 'supplier_id', warehouseId: 'warehouse_id', expectedDate: 'expected_date', notes: 'notes' };
      const sets: string[] = []; const vals: any[] = [];
      for (const [k, col] of Object.entries(map)) {
        const v = (data as any)[k];
        if (v !== undefined) { vals.push(v === '' ? null : v); sets.push(`${col} = $${vals.length}`); }
      }
      if (!sets.length) return po;
      vals.push(orderId);
      const r = await client.query(`UPDATE purchase_orders SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length} RETURNING *`, vals);
      return r.rows[0];
    });
  }

  async setItem(orderId: string, enterpriseId: string, it: OrderItemInput): Promise<void> {
    await this.tx(async (client) => {
      const po = await this.lockOrder(client, orderId, enterpriseId);
      if (!EDITABLE.includes(po.status)) throw new PurchaseOrderError('Заказ уже в работе — состав изменить нельзя');
      await this.assertOwned(client, enterpriseId, { itemIds: [it.inventoryItemId] });
      await this.upsertItem(client, orderId, it);
      await client.query('UPDATE purchase_orders SET updated_at = NOW() WHERE id = $1', [orderId]);
    });
  }

  async removeItem(orderId: string, enterpriseId: string, itemRowId: string): Promise<void> {
    await this.tx(async (client) => {
      const po = await this.lockOrder(client, orderId, enterpriseId);
      if (!EDITABLE.includes(po.status)) throw new PurchaseOrderError('Заказ уже в работе — состав изменить нельзя');
      await client.query('DELETE FROM purchase_order_items WHERE id = $1 AND order_id = $2', [itemRowId, orderId]);
    });
  }

  async send(orderId: string, enterpriseId: string): Promise<any> {
    return this.tx(async (client) => {
      const po = await this.lockOrder(client, orderId, enterpriseId);
      if (po.status !== 'draft') throw new PurchaseOrderError('Отправить можно только черновик');
      if (!po.supplier_id) throw new PurchaseOrderError('Выберите поставщика');
      const n = await client.query('SELECT COUNT(*)::int AS n FROM purchase_order_items WHERE order_id = $1', [orderId]);
      if (!n.rows[0].n) throw new PurchaseOrderError('В заказе нет позиций');
      const r = await client.query(`UPDATE purchase_orders SET status = 'sent', sent_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`, [orderId]);
      return r.rows[0];
    });
  }

  async cancel(orderId: string, enterpriseId: string): Promise<any> {
    return this.tx(async (client) => {
      const po = await this.lockOrder(client, orderId, enterpriseId);
      if (po.status === 'received' || po.status === 'cancelled') throw new PurchaseOrderError('Заказ уже закрыт');
      const r = await client.query(`UPDATE purchase_orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1 RETURNING *`, [orderId]);
      return r.rows[0];
    });
  }

  /**
   * Черновик накладной по заказу: позиции — остаток к получению по цене
   * заказа. Уже есть черновик по этому заказу — возвращаем его, второй не
   * создаём (иначе одну поставку легко принять дважды).
   */
  async createInvoice(orderId: string, enterpriseId: string): Promise<{ invoice: any; existing: boolean }> {
    return this.tx(async (client) => {
      const po = await this.lockOrder(client, orderId, enterpriseId);
      if (po.status === 'cancelled' || po.status === 'received') throw new PurchaseOrderError('Заказ закрыт — накладная не нужна');
      if (!po.supplier_id) throw new PurchaseOrderError('Выберите поставщика');
      const draft = await client.query(
        `SELECT * FROM supply_invoices WHERE purchase_order_id = $1 AND status <> 'received' ORDER BY created_at DESC LIMIT 1`, [orderId]);
      if (draft.rows[0]) return { invoice: draft.rows[0], existing: true };

      const rest = await client.query(
        `SELECT i.inventory_item_id, ii.name, ii.unit, i.quantity - i.received_quantity AS qty,
                COALESCE(i.price_per_unit, ii.cost_price) AS price
           FROM purchase_order_items i JOIN inventory_items ii ON ii.id = i.inventory_item_id
          WHERE i.order_id = $1 AND i.quantity > i.received_quantity
          ORDER BY ii.name`, [orderId]);
      if (!rest.rows.length) throw new PurchaseOrderError('По заказу всё уже получено');

      const num = await client.query('SELECT next_invoice_number($1) AS n', [enterpriseId]);
      const inv = await client.query(
        `INSERT INTO supply_invoices (enterprise_id, warehouse_id, supplier_id, invoice_number, invoice_date, status,
            purchase_order_id, notes, total_amount)
         VALUES ($1, $2, $3, $4, CURRENT_DATE, 'draft', $5, $6, 0) RETURNING *`,
        [enterpriseId, po.warehouse_id, po.supplier_id, num.rows[0].n, orderId, 'По заказу ' + po.order_number]
      );
      for (const r of rest.rows) {
        const qty = Number(r.qty);
        const price = r.price === null ? null : Number(r.price);
        await client.query(
          `INSERT INTO supply_invoice_items (invoice_id, inventory_item_id, name, quantity, unit, price_per_unit, total_price)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [inv.rows[0].id, r.inventory_item_id, r.name, qty, r.unit, price, price === null ? null : Math.round(qty * price * 100) / 100]
        );
      }
      const tot = await client.query(
        `UPDATE supply_invoices SET total_amount = (SELECT COALESCE(SUM(total_price), 0) FROM supply_invoice_items WHERE invoice_id = $1)
          WHERE id = $1 RETURNING *`, [inv.rows[0].id]);
      return { invoice: tot.rows[0], existing: false };
    });
  }

  /**
   * Что заказать: позиции ниже минимума, сгруппированные по последнему
   * поставщику (из партий, принятых по накладным). Количество — до двух
   * минимумов, как в «Нужно заказать».
   */
  async suggestions(enterpriseId: string): Promise<any[]> {
    const r = await this.pool.query(
      `SELECT i.id, i.name, i.unit, i.cost_price, i.min_stock, COALESCE(st.qty, 0) AS stock,
              (SELECT b.supplier_id FROM inventory_batches b
                WHERE b.inventory_item_id = i.id AND b.supplier_id IS NOT NULL
                ORDER BY b.received_at DESC LIMIT 1) AS last_supplier_id
         FROM inventory_items i
         LEFT JOIN (SELECT inventory_item_id, SUM(quantity) AS qty FROM inventory_stock GROUP BY 1) st ON st.inventory_item_id = i.id
        WHERE i.enterprise_id = $1 AND COALESCE(i.min_stock, 0) > 0 AND COALESCE(st.qty, 0) <= i.min_stock
          AND NOT EXISTS (
            SELECT 1 FROM purchase_order_items oi JOIN purchase_orders o ON o.id = oi.order_id
             WHERE oi.inventory_item_id = i.id AND o.enterprise_id = $1 AND o.status IN ('draft', 'sent', 'partially_received')
               AND oi.quantity > oi.received_quantity)
        ORDER BY i.name`,
      [enterpriseId]
    );
    return r.rows.map((x: any) => ({
      inventoryItemId: x.id, name: x.name, unit: x.unit,
      stock: Number(x.stock), minStock: Number(x.min_stock),
      quantity: Math.round(Math.max(Number(x.min_stock) * 2 - Number(x.stock), Number(x.min_stock)) * 1000) / 1000,
      pricePerUnit: x.cost_price === null ? null : Number(x.cost_price),
      supplierId: x.last_supplier_id
    }));
  }

  async close(): Promise<void> { await this.pool.end(); }
}

/**
 * Приёмка накладной по заказу: полученное записывается в заказ, статус
 * пересчитывается. Вызывается из confirmInvoice в ЕЁ транзакции.
 */
export async function receiveFromInvoice(client: any, invoiceId: string, orderId: string): Promise<void> {
  await client.query(
    `UPDATE purchase_order_items poi
        SET received_quantity = poi.received_quantity + x.q
       FROM (SELECT inventory_item_id, SUM(quantity) AS q FROM supply_invoice_items
              WHERE invoice_id = $1 AND inventory_item_id IS NOT NULL GROUP BY inventory_item_id) x
      WHERE poi.order_id = $2 AND poi.inventory_item_id = x.inventory_item_id`,
    [invoiceId, orderId]
  );
  await client.query(
    `UPDATE purchase_orders po
        SET status = CASE WHEN NOT EXISTS (SELECT 1 FROM purchase_order_items i WHERE i.order_id = po.id AND i.received_quantity < i.quantity)
                          THEN 'received' ELSE 'partially_received' END,
            updated_at = NOW()
      WHERE po.id = $1 AND po.status <> 'cancelled'`,
    [orderId]
  );
}
