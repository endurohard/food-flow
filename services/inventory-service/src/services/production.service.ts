import pkg from 'pg';
const { Pool } = pkg;
import { InventoryService } from './inventory.service';

/**
 * Производство по техкартам: списание ингредиентов со склада по FIFO
 * с фактической себестоимостью партий и оприходование готовой продукции
 * (или полуфабриката) с производственной себестоимостью.
 */
export class ProductionService {
  private pool: InstanceType<typeof Pool>;
  private inventory: InventoryService;

  constructor(connectionString: string, inventory: InventoryService) {
    this.pool = new Pool({ connectionString });
    this.inventory = inventory;
  }

  async produce(data: {
    techCardId: string;
    warehouseId: string;
    quantity: number;          // произведено единиц выходной позиции
    producedBy?: string;
    enterpriseId?: string;
    notes?: string;
  }): Promise<any> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      if (data.enterpriseId) {
        const wh = await client.query(
          'SELECT id FROM warehouses WHERE id = $1 AND enterprise_id = $2',
          [data.warehouseId, data.enterpriseId]
        );
        if (wh.rowCount === 0) throw new Error('Warehouse not found or does not belong to this enterprise');
      }

      const tcResult = await client.query(
        `SELECT tc.*, oi.name AS output_name, oi.unit AS output_unit
         FROM tech_cards tc
         LEFT JOIN inventory_items oi ON tc.output_item_id = oi.id
         WHERE tc.id = $1 AND tc.is_active = true`,
        [data.techCardId]
      );
      const techCard = tcResult.rows[0];
      if (!techCard) throw new Error('Tech card not found or inactive');
      if (!techCard.output_item_id) throw new Error('Tech card has no output item (not a production tech card)');
      if (data.enterpriseId && techCard.enterprise_id && techCard.enterprise_id !== data.enterpriseId) {
        throw new Error('Tech card does not belong to this enterprise');
      }

      const outputQty = parseFloat(techCard.output_quantity) || 1;
      const cycles = data.quantity / outputQty;

      const ingResult = await client.query(
        `SELECT tci.*, ii.name AS item_name, ii.cost_price AS item_cost_price
         FROM tech_card_ingredients tci
         INNER JOIN inventory_items ii ON tci.inventory_item_id = ii.id
         WHERE tci.tech_card_id = $1`,
        [data.techCardId]
      );
      if (ingResult.rows.length === 0) throw new Error('Tech card has no ingredients');

      // Создаём запись выпуска заранее, чтобы ссылаться на неё из движений
      const runResult = await client.query(
        `INSERT INTO production_runs (enterprise_id, tech_card_id, output_item_id, warehouse_id,
           quantity, produced_by, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [data.enterpriseId || null, data.techCardId, techCard.output_item_id,
         data.warehouseId, data.quantity, data.producedBy || null, data.notes || null]
      );
      const run = runResult.rows[0];

      let totalCost = 0;
      const consumed: any[] = [];

      for (const ing of ingResult.rows) {
        const wasteFactor = 1 + (parseFloat(ing.waste_percent) || 0) / 100;
        const needQty = parseFloat(ing.quantity) * cycles * wasteFactor;
        if (needQty <= 0) continue;

        // FIFO-списание партий — даёт фактическую стоимость списанного
        const fifo = await this.inventory.deductFIFO(data.warehouseId, ing.inventory_item_id, needQty, client);
        let ingCost = 0;
        for (const b of fifo.batches) {
          const unitCost = b.costPrice !== null && b.costPrice !== undefined
            ? parseFloat(b.costPrice)
            : (parseFloat(ing.item_cost_price) || 0);
          ingCost += b.deducted * unitCost;
        }

        // Атомарное списание остатка (не даёт уйти в минус)
        const deduct = await client.query(
          `UPDATE inventory_stock
           SET quantity = quantity - $1, updated_at = NOW()
           WHERE warehouse_id = $2 AND inventory_item_id = $3 AND quantity >= $1
           RETURNING quantity`,
          [needQty, data.warehouseId, ing.inventory_item_id]
        );
        if (deduct.rowCount === 0) {
          throw new Error(`Insufficient stock for "${ing.item_name}" (need ${needQty.toFixed(3)})`);
        }

        await client.query(
          `INSERT INTO stock_movements (enterprise_id, warehouse_id, inventory_item_id, movement_type,
             quantity, cost_price, reference_type, reference_id, performed_by, notes)
           VALUES ($1, $2, $3, 'write_off', $4, $5, 'production', $6, $7, $8)`,
          [data.enterpriseId || null, data.warehouseId, ing.inventory_item_id,
           needQty, needQty > 0 ? ingCost / needQty : null, run.id,
           data.producedBy || null, `Производство: ${techCard.output_name || ''}`]
        );

        await client.query(
          `INSERT INTO production_run_ingredients (production_run_id, inventory_item_id, quantity, cost)
           VALUES ($1, $2, $3, $4)`,
          [run.id, ing.inventory_item_id, needQty, ingCost]
        );

        totalCost += ingCost;
        consumed.push({ inventoryItemId: ing.inventory_item_id, name: ing.item_name, quantity: needQty, cost: ingCost });
      }

      const unitCost = data.quantity > 0 ? totalCost / data.quantity : 0;

      // Оприходование готовой продукции
      await client.query(
        `INSERT INTO inventory_stock (warehouse_id, inventory_item_id, quantity)
         VALUES ($1, $2, $3)
         ON CONFLICT (warehouse_id, inventory_item_id)
         DO UPDATE SET quantity = inventory_stock.quantity + $3, updated_at = NOW()`,
        [data.warehouseId, techCard.output_item_id, data.quantity]
      );
      await client.query(
        `INSERT INTO stock_movements (enterprise_id, warehouse_id, inventory_item_id, movement_type,
           quantity, cost_price, reference_type, reference_id, performed_by, notes)
         VALUES ($1, $2, $3, 'receipt', $4, $5, 'production', $6, $7, $8)`,
        [data.enterpriseId || null, data.warehouseId, techCard.output_item_id,
         data.quantity, unitCost, run.id, data.producedBy || null,
         `Выпуск по техкарте`]
      );
      await client.query(
        `INSERT INTO inventory_batches (inventory_item_id, warehouse_id, enterprise_id, batch_number, quantity, cost_price)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [techCard.output_item_id, data.warehouseId, data.enterpriseId || null,
         `PR-${run.id.slice(0, 8)}`, data.quantity, unitCost]
      );
      await client.query(
        `UPDATE inventory_items SET cost_price = $1, is_produced = true, updated_at = NOW() WHERE id = $2`,
        [unitCost, techCard.output_item_id]
      );

      const updated = await client.query(
        `UPDATE production_runs SET total_cost = $1, unit_cost = $2 WHERE id = $3 RETURNING *`,
        [totalCost, unitCost, run.id]
      );

      await client.query('COMMIT');
      return { ...updated.rows[0], output_name: techCard.output_name, ingredients: consumed };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async cancel(runId: string, performedBy?: string, enterpriseId?: string): Promise<any> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const conds = ['id = $1', `status = 'completed'`];
      const vals: any[] = [runId];
      if (enterpriseId) { conds.push('enterprise_id = $2'); vals.push(enterpriseId); }
      const runResult = await client.query(
        `SELECT * FROM production_runs WHERE ${conds.join(' AND ')} FOR UPDATE`, vals
      );
      const run = runResult.rows[0];
      if (!run) throw new Error('Production run not found or already cancelled');

      const qty = parseFloat(run.quantity);

      // Списываем произведённую продукцию обратно (упадёт, если её уже израсходовали)
      await this.inventory.deductFIFO(run.warehouse_id, run.output_item_id, qty, client);
      const deduct = await client.query(
        `UPDATE inventory_stock SET quantity = quantity - $1, updated_at = NOW()
         WHERE warehouse_id = $2 AND inventory_item_id = $3 AND quantity >= $1 RETURNING quantity`,
        [qty, run.warehouse_id, run.output_item_id]
      );
      if (deduct.rowCount === 0) throw new Error('Produced output already consumed — cannot cancel');
      await client.query(
        `INSERT INTO stock_movements (enterprise_id, warehouse_id, inventory_item_id, movement_type,
           quantity, reference_type, reference_id, performed_by, notes)
         VALUES ($1, $2, $3, 'write_off', $4, 'production_cancel', $5, $6, 'Отмена производства')`,
        [run.enterprise_id, run.warehouse_id, run.output_item_id, qty, run.id, performedBy || null]
      );

      // Возвращаем ингредиенты на склад по зафиксированной стоимости
      const ings = await client.query(
        'SELECT * FROM production_run_ingredients WHERE production_run_id = $1', [runId]
      );
      for (const ing of ings.rows) {
        const ingQty = parseFloat(ing.quantity);
        const unitCost = ingQty > 0 ? (parseFloat(ing.cost) || 0) / ingQty : 0;
        await client.query(
          `INSERT INTO inventory_stock (warehouse_id, inventory_item_id, quantity)
           VALUES ($1, $2, $3)
           ON CONFLICT (warehouse_id, inventory_item_id)
           DO UPDATE SET quantity = inventory_stock.quantity + $3, updated_at = NOW()`,
          [run.warehouse_id, ing.inventory_item_id, ingQty]
        );
        await client.query(
          `INSERT INTO inventory_batches (inventory_item_id, warehouse_id, enterprise_id, batch_number, quantity, cost_price)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [ing.inventory_item_id, run.warehouse_id, run.enterprise_id,
           `PRC-${run.id.slice(0, 8)}`, ingQty, unitCost]
        );
        await client.query(
          `INSERT INTO stock_movements (enterprise_id, warehouse_id, inventory_item_id, movement_type,
             quantity, cost_price, reference_type, reference_id, performed_by, notes)
           VALUES ($1, $2, $3, 'receipt', $4, $5, 'production_cancel', $6, $7, 'Возврат ингредиентов при отмене производства')`,
          [run.enterprise_id, run.warehouse_id, ing.inventory_item_id, ingQty, unitCost, run.id, performedBy || null]
        );
      }

      const updated = await client.query(
        `UPDATE production_runs SET status = 'cancelled' WHERE id = $1 RETURNING *`, [runId]
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

  async list(filters: {
    enterpriseId?: string;
    warehouseId?: string;
    outputItemId?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): Promise<any[]> {
    const conditions: string[] = [];
    const values: any[] = [];
    let p = 1;
    if (filters.enterpriseId) { conditions.push(`pr.enterprise_id = $${p++}`); values.push(filters.enterpriseId); }
    if (filters.warehouseId) { conditions.push(`pr.warehouse_id = $${p++}`); values.push(filters.warehouseId); }
    if (filters.outputItemId) { conditions.push(`pr.output_item_id = $${p++}`); values.push(filters.outputItemId); }
    if (filters.from) { conditions.push(`pr.produced_at >= $${p++}`); values.push(filters.from); }
    if (filters.to) { conditions.push(`pr.produced_at <= $${p++}`); values.push(filters.to); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    values.push(filters.limit || 100, filters.offset || 0);

    const result = await this.pool.query(
      `SELECT pr.*, oi.name AS output_name, oi.unit AS output_unit,
              w.name AS warehouse_name, u.first_name, u.last_name,
              COALESCE(
                json_agg(
                  json_build_object(
                    'inventoryItemId', pri.inventory_item_id,
                    'itemName', ii.name,
                    'quantity', pri.quantity,
                    'cost', pri.cost
                  )
                ) FILTER (WHERE pri.id IS NOT NULL), '[]'
              ) AS ingredients
       FROM production_runs pr
       INNER JOIN inventory_items oi ON pr.output_item_id = oi.id
       INNER JOIN warehouses w ON pr.warehouse_id = w.id
       LEFT JOIN users u ON pr.produced_by = u.id
       LEFT JOIN production_run_ingredients pri ON pri.production_run_id = pr.id
       LEFT JOIN inventory_items ii ON pri.inventory_item_id = ii.id
       ${where}
       GROUP BY pr.id, oi.name, oi.unit, w.name, u.first_name, u.last_name
       ORDER BY pr.produced_at DESC
       LIMIT $${p++} OFFSET $${p}`,
      values
    );
    return result.rows;
  }

  /** Маржинальность позиций: себестоимость vs оптовая vs розничная цена */
  async getMarginReport(enterpriseId?: string): Promise<any[]> {
    const conds = ['i.is_active = true', '(i.wholesale_price IS NOT NULL OR i.retail_price IS NOT NULL OR i.is_produced = true)'];
    const vals: any[] = [];
    if (enterpriseId) { conds.push('i.enterprise_id = $1'); vals.push(enterpriseId); }
    const result = await this.pool.query(
      `SELECT i.id, i.name, i.unit, i.is_produced, i.cost_price,
              i.wholesale_price, i.retail_price,
              (SELECT COALESCE(SUM(b.quantity * b.cost_price) / NULLIF(SUM(b.quantity), 0), i.cost_price)
               FROM inventory_batches b
               WHERE b.inventory_item_id = i.id AND b.is_depleted = false) AS avg_batch_cost,
              COALESCE((SELECT SUM(s.quantity) FROM inventory_stock s WHERE s.inventory_item_id = i.id), 0) AS total_stock
       FROM inventory_items i
       WHERE ${conds.join(' AND ')}
       ORDER BY i.name`,
      vals
    );
    return result.rows.map((r: any) => {
      const cost = parseFloat(r.avg_batch_cost ?? r.cost_price) || 0;
      const wholesale = r.wholesale_price !== null ? parseFloat(r.wholesale_price) : null;
      const retail = r.retail_price !== null ? parseFloat(r.retail_price) : null;
      return {
        ...r,
        effective_cost: cost,
        wholesale_margin_percent: wholesale && wholesale > 0 ? Math.round((wholesale - cost) / wholesale * 10000) / 100 : null,
        retail_margin_percent: retail && retail > 0 ? Math.round((retail - cost) / retail * 10000) / 100 : null
      };
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default ProductionService;
