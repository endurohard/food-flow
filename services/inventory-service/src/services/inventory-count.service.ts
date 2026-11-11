import { Pool } from 'pg';

/**
 * Инвентаризация — пересчёт склада.
 *
 * Черновик: строки на все товары предприятия (или одной категории), факт
 * вводится в несколько заходов. Проведение — одна транзакция: расхождение
 * считается от остатка НА МОМЕНТ ПРОВЕДЕНИЯ (строка остатка под
 * блокировкой), так что продажи во время пересчёта не дают ложной
 * недостачи; излишек — корректировкой «плюс», недостача — «минус» (снимает
 * партии по FIFO). Каждое движение ссылается на документ.
 */

export class InventoryCountError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'InventoryCountError'; }
}

interface MovementWriter {
  addStockMovement(data: any, client?: any): Promise<any>;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Себестоимость единицы на складе: по партиям, без них — последняя цена. */
const UNIT_COST_SQL = `
  SELECT COALESCE(
    (SELECT SUM(b.quantity * b.cost_price) / NULLIF(SUM(b.quantity), 0) FROM inventory_batches b
      WHERE b.inventory_item_id = $1 AND b.warehouse_id = $2 AND b.is_depleted = false
        AND b.quantity > 0 AND b.cost_price IS NOT NULL),
    (SELECT cost_price FROM inventory_items WHERE id = $1), 0) AS cost`;

export class InventoryCountService {
  private pool: Pool;
  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
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

  private async lockDraft(client: any, countId: string, enterpriseId: string) {
    const r = await client.query(
      'SELECT * FROM inventory_counts WHERE id = $1 AND enterprise_id = $2 FOR UPDATE', [countId, enterpriseId]);
    const c = r.rows[0];
    if (!c) throw new InventoryCountError('Инвентаризация не найдена', 404);
    if (c.status !== 'draft') throw new InventoryCountError(c.status === 'posted' ? 'Инвентаризация уже проведена' : 'Инвентаризация отменена', 409);
    return c;
  }

  async list(enterpriseId: string, filters: { warehouseId?: string } = {}): Promise<any[]> {
    const vals: any[] = [enterpriseId];
    let where = 'c.enterprise_id = $1';
    if (filters.warehouseId) { vals.push(filters.warehouseId); where += ` AND c.warehouse_id = $${vals.length}`; }
    const r = await this.pool.query(
      `SELECT c.*, w.name AS warehouse_name, u.first_name, u.last_name,
              (SELECT COUNT(*)::int FROM inventory_count_items i WHERE i.count_id = c.id) AS items_total,
              (SELECT COUNT(*)::int FROM inventory_count_items i WHERE i.count_id = c.id AND i.counted_qty IS NOT NULL) AS items_counted
         FROM inventory_counts c
         LEFT JOIN warehouses w ON w.id = c.warehouse_id
         LEFT JOIN users u ON u.id = c.created_by
        WHERE ${where}
        ORDER BY c.created_at DESC
        LIMIT 200`,
      vals
    );
    return r.rows;
  }

  /** Документ со строками; у черновика — текущий остаток и цена для сверки на лету. */
  async get(countId: string, enterpriseId: string): Promise<any | null> {
    const h = await this.pool.query(
      `SELECT c.*, w.name AS warehouse_name FROM inventory_counts c
         LEFT JOIN warehouses w ON w.id = c.warehouse_id
        WHERE c.id = $1 AND c.enterprise_id = $2`,
      [countId, enterpriseId]
    );
    const head = h.rows[0];
    if (!head) return null;
    const items = await this.pool.query(
      `SELECT ci.*, ii.name, ii.unit, ii.category,
              COALESCE(st.quantity, 0) AS current_qty,
              COALESCE(bc.avg_cost, ii.cost_price, 0) AS current_cost
         FROM inventory_count_items ci
         JOIN inventory_items ii ON ii.id = ci.inventory_item_id
         LEFT JOIN inventory_stock st ON st.inventory_item_id = ci.inventory_item_id AND st.warehouse_id = $2
         LEFT JOIN LATERAL (
           SELECT SUM(b.quantity * b.cost_price) / NULLIF(SUM(b.quantity), 0) AS avg_cost
             FROM inventory_batches b
            WHERE b.inventory_item_id = ci.inventory_item_id AND b.warehouse_id = $2
              AND b.is_depleted = false AND b.quantity > 0 AND b.cost_price IS NOT NULL) bc ON true
        WHERE ci.count_id = $1
        ORDER BY COALESCE(ii.category, ''), ii.name`,
      [countId, head.warehouse_id]
    );
    return { ...head, items: items.rows };
  }

  async create(enterpriseId: string, userId: string | undefined, data: { warehouseId: string; category?: string | null; notes?: string | null }): Promise<any> {
    return this.tx(async (client) => {
      const wh = await client.query('SELECT 1 FROM warehouses WHERE id = $1 AND enterprise_id = $2', [data.warehouseId, enterpriseId]);
      if (!wh.rows[0]) throw new InventoryCountError('Склад не найден', 404);
      const num = await client.query('SELECT next_inventory_count_number($1) AS n', [enterpriseId]);
      const ins = await client.query(
        `INSERT INTO inventory_counts (enterprise_id, warehouse_id, count_number, category, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [enterpriseId, data.warehouseId, num.rows[0].n, data.category || null, data.notes || null, userId || null]
      );
      const count = ins.rows[0];
      const rows = await client.query(
        `INSERT INTO inventory_count_items (count_id, inventory_item_id)
         SELECT $1, id FROM inventory_items
          WHERE enterprise_id = $2 AND deleted_at IS NULL AND ($3::text IS NULL OR category = $3::text)`,
        [count.id, enterpriseId, data.category || null]
      );
      if (!rows.rowCount) throw new InventoryCountError(data.category ? 'В этой категории нет товаров' : 'На складе нет товаров для пересчёта');
      return count;
    });
  }

  /** Факт по строкам: null — «не посчитано». Товар, заведённый после начала, добавляется. */
  async saveCounts(countId: string, enterpriseId: string, items: { inventoryItemId: string; countedQty: number | null }[]): Promise<number> {
    if (!items.length) return 0;
    return this.tx(async (client) => {
      await this.lockDraft(client, countId, enterpriseId);
      const ids = [...new Set(items.map((i) => i.inventoryItemId))];
      const own = await client.query('SELECT id FROM inventory_items WHERE id = ANY($1) AND enterprise_id = $2', [ids, enterpriseId]);
      if (own.rows.length !== ids.length) throw new InventoryCountError('Товар не найден', 404);
      for (const it of items) {
        const q = it.countedQty === null || it.countedQty === undefined ? null : r3(Number(it.countedQty));
        await client.query(
          `INSERT INTO inventory_count_items (count_id, inventory_item_id, counted_qty, counted_at)
           VALUES ($1, $2, $3, CASE WHEN $3::numeric IS NULL THEN NULL ELSE NOW() END)
           ON CONFLICT (count_id, inventory_item_id)
           DO UPDATE SET counted_qty = EXCLUDED.counted_qty, counted_at = EXCLUDED.counted_at`,
          [countId, it.inventoryItemId, q]
        );
      }
      await client.query('UPDATE inventory_counts SET updated_at = NOW() WHERE id = $1', [countId]);
      return items.length;
    });
  }

  async post(countId: string, enterpriseId: string, userId: string | undefined, writer: MovementWriter,
             opts: { zeroUncounted?: boolean } = {}): Promise<any> {
    return this.tx(async (client) => {
      const c = await this.lockDraft(client, countId, enterpriseId);
      if (opts.zeroUncounted) {
        await client.query(
          'UPDATE inventory_count_items SET counted_qty = 0, counted_at = NOW() WHERE count_id = $1 AND counted_qty IS NULL', [countId]);
      }
      const rows = await client.query(
        `SELECT ci.id, ci.inventory_item_id, ci.counted_qty FROM inventory_count_items ci
          WHERE ci.count_id = $1 AND ci.counted_qty IS NOT NULL ORDER BY ci.inventory_item_id`,
        [countId]
      );
      if (!rows.rows.length) throw new InventoryCountError('Не введено ни одного факта — проводить нечего');

      let shortage = 0, surplus = 0, changed = 0;
      for (const row of rows.rows) {
        // Остаток под блокировкой: продажа в эту секунду подождёт проведения
        const st = await client.query(
          'SELECT quantity FROM inventory_stock WHERE warehouse_id = $1 AND inventory_item_id = $2 FOR UPDATE',
          [c.warehouse_id, row.inventory_item_id]
        );
        const expected = st.rows[0] ? Number(st.rows[0].quantity) : 0;
        const counted = Number(row.counted_qty);
        const diff = r3(counted - expected);
        const uc = await client.query(UNIT_COST_SQL, [row.inventory_item_id, c.warehouse_id]);
        let unitCost = Number(uc.rows[0]?.cost) || 0;

        if (Math.abs(diff) > 1e-9) {
          const mv = await writer.addStockMovement({
            warehouseId: c.warehouse_id,
            inventoryItemId: row.inventory_item_id,
            movementType: diff > 0 ? 'adjustment_plus' : 'adjustment_minus',
            quantity: Math.abs(diff),
            costPrice: diff > 0 ? unitCost : undefined,   // недостача — по FIFO-цене партий
            referenceType: 'inventory_count',
            referenceId: countId,
            performedBy: userId,
            enterpriseId,
            notes: 'Инвентаризация ' + c.count_number
          }, client);
          if (diff < 0 && mv && mv.cost_price !== null && mv.cost_price !== undefined) unitCost = Number(mv.cost_price) || unitCost;
          changed++;
        }
        const value = r2(diff * unitCost);
        if (value < 0) shortage += -value; else surplus += value;
        await client.query(
          `UPDATE inventory_count_items SET expected_qty = $2, diff_qty = $3, unit_cost = $4, diff_value = $5 WHERE id = $1`,
          [row.id, expected, diff, unitCost, value]
        );
      }

      const r = await client.query(
        `UPDATE inventory_counts SET status = 'posted', posted_by = $2, posted_at = NOW(),
                shortage_value = $3, surplus_value = $4, updated_at = NOW()
          WHERE id = $1 RETURNING *`,
        [countId, userId || null, r2(shortage), r2(surplus)]
      );
      return { ...r.rows[0], adjusted: changed, counted: rows.rows.length };
    });
  }

  async cancel(countId: string, enterpriseId: string): Promise<any> {
    return this.tx(async (client) => {
      await this.lockDraft(client, countId, enterpriseId);
      const r = await client.query(
        `UPDATE inventory_counts SET status = 'cancelled', updated_at = NOW() WHERE id = $1 RETURNING *`, [countId]);
      return r.rows[0];
    });
  }

  async close(): Promise<void> { await this.pool.end(); }
}
