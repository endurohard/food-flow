import pkg from 'pg';
const { Pool } = pkg;

export class InventoryService {
  private pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  // ========== INVENTORY ITEMS ==========

  async listItems(filters: { enterpriseId?: string; category?: string; search?: string; lowStock?: boolean }): Promise<any[]> {
    const conditions: string[] = [];
    const values: any[] = [];
    let p = 1;

    if (filters.enterpriseId) { conditions.push(`i.enterprise_id = $${p++}`); values.push(filters.enterpriseId); }
    if (filters.category) { conditions.push(`i.category = $${p++}`); values.push(filters.category); }
    if (filters.search) { conditions.push(`i.name ILIKE $${p++}`); values.push(`%${filters.search}%`); }

    let query = `SELECT i.*, COALESCE(SUM(s.quantity), 0) as total_stock
       FROM inventory_items i
       LEFT JOIN inventory_stock s ON s.inventory_item_id = i.id
       ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
       GROUP BY i.id
       ${filters.lowStock ? 'HAVING COALESCE(SUM(s.quantity), 0) <= i.min_stock' : ''}
       ORDER BY i.name ASC`;

    const result = await this.pool.query(query, values);
    return result.rows;
  }

  async getItem(id: string, enterpriseId?: string): Promise<any> {
    const whereConds = ['id = $1'];
    const values: any[] = [id];
    if (enterpriseId) {
      whereConds.push(`enterprise_id = $${values.length + 1}`);
      values.push(enterpriseId);
    }
    const result = await this.pool.query(
      `SELECT i.*, COALESCE(SUM(s.quantity), 0) as total_stock
       FROM inventory_items i
       LEFT JOIN inventory_stock s ON s.inventory_item_id = i.id
       WHERE ${whereConds.join(' AND ')}
       GROUP BY i.id`,
      values
    );
    return result.rows[0] || null;
  }

  async createItem(data: any, enterpriseId?: string): Promise<any> {
    const result = await this.pool.query(
      `INSERT INTO inventory_items (enterprise_id, name, sku, category, unit, min_stock, max_stock, cost_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [enterpriseId || null, data.name, data.sku || null, data.category || null,
       data.unit, data.minStock || 0, data.maxStock || null, data.costPrice || 0]
    );
    return result.rows[0];
  }

  async updateItem(itemId: string, data: any, enterpriseId?: string): Promise<any> {
    const fields: string[] = [];
    const values: any[] = [];
    let p = 1;
    const map: Record<string, string> = {
      name: 'name', sku: 'sku', category: 'category', unit: 'unit',
      minStock: 'min_stock', maxStock: 'max_stock', costPrice: 'cost_price', isActive: 'is_active'
    };
    for (const [k, col] of Object.entries(map)) {
      if (data[k] !== undefined) { fields.push(`${col} = $${p++}`); values.push(data[k]); }
    }
    if (!fields.length) return null;
    const whereConds = [`id = $${p++}`];
    values.push(itemId);
    if (enterpriseId) {
      whereConds.push(`enterprise_id = $${p++}`);
      values.push(enterpriseId);
    }
    const result = await this.pool.query(
      `UPDATE inventory_items SET ${fields.join(', ')} WHERE ${whereConds.join(' AND ')} RETURNING *`, values
    );
    return result.rows[0] || null;
  }

  async updatePrices(itemId: string, data: { wholesalePrice?: number | null; retailPrice?: number | null }, enterpriseId?: string): Promise<any> {
    const fields: string[] = [];
    const values: any[] = [];
    let p = 1;
    if (data.wholesalePrice !== undefined) { fields.push(`wholesale_price = $${p++}`); values.push(data.wholesalePrice); }
    if (data.retailPrice !== undefined) { fields.push(`retail_price = $${p++}`); values.push(data.retailPrice); }
    if (!fields.length) return null;
    fields.push('updated_at = NOW()');
    const whereConds = [`id = $${p++}`];
    values.push(itemId);
    if (enterpriseId) {
      whereConds.push(`enterprise_id = $${p++}`);
      values.push(enterpriseId);
    }
    const result = await this.pool.query(
      `UPDATE inventory_items SET ${fields.join(', ')} WHERE ${whereConds.join(' AND ')} RETURNING *`, values
    );
    return result.rows[0] || null;
  }

  async deleteItem(itemId: string, enterpriseId?: string): Promise<boolean> {
    const conds = ['id = $1'];
    const vals: any[] = [itemId];
    if (enterpriseId) {
      conds.push(`enterprise_id = $2`);
      vals.push(enterpriseId);
    }
    const r = await this.pool.query(
      `UPDATE inventory_items SET is_active = false WHERE ${conds.join(' AND ')}`,
      vals
    );
    return (r.rowCount ?? 0) > 0;
  }

  // ========== WAREHOUSES ==========

  async listWarehouses(restaurantId: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT w.*, (SELECT COUNT(*) FROM inventory_stock s WHERE s.warehouse_id = w.id) as items_count
       FROM warehouses w WHERE w.restaurant_id = $1 AND w.is_active = true ORDER BY w.name`,
      [restaurantId]
    );
    return result.rows;
  }

  async createWarehouse(restaurantId: string, data: any, enterpriseId?: string): Promise<any> {
    const result = await this.pool.query(
      `INSERT INTO warehouses (restaurant_id, enterprise_id, name, warehouse_type)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [restaurantId, enterpriseId || null, data.name, data.warehouseType || 'main']
    );
    return result.rows[0];
  }

  async updateWarehouse(warehouseId: string, data: any, enterpriseId?: string): Promise<any> {
    const fields: string[] = [];
    const values: any[] = [];
    let p = 1;
    if (data.name !== undefined) { fields.push(`name = $${p++}`); values.push(data.name); }
    if (data.warehouseType !== undefined) { fields.push(`warehouse_type = $${p++}`); values.push(data.warehouseType); }
    if (data.isActive !== undefined) { fields.push(`is_active = $${p++}`); values.push(data.isActive); }
    if (!fields.length) return null;
    const whereConds = [`id = $${p++}`];
    values.push(warehouseId);
    if (enterpriseId) {
      whereConds.push(`enterprise_id = $${p++}`);
      values.push(enterpriseId);
    }
    const result = await this.pool.query(
      `UPDATE warehouses SET ${fields.join(', ')} WHERE ${whereConds.join(' AND ')} RETURNING *`, values
    );
    return result.rows[0] || null;
  }

  // ========== STOCK ==========

  async getStock(warehouseId: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT s.*, i.name, i.sku, i.category, i.unit, i.min_stock, i.cost_price
       FROM inventory_stock s
       INNER JOIN inventory_items i ON s.inventory_item_id = i.id
       WHERE s.warehouse_id = $1
       ORDER BY i.name`,
      [warehouseId]
    );
    return result.rows;
  }

  async addStockMovement(data: {
    warehouseId: string;
    inventoryItemId: string;
    movementType: string;
    quantity: number;
    costPrice?: number;
    referenceType?: string;
    referenceId?: string;
    performedBy?: string;
    notes?: string;
    enterpriseId?: string;
    batchNumber?: string;
    expiryDate?: string;
    supplierId?: string;
    invoiceId?: string;
  }): Promise<any> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Insert movement
      const movResult = await client.query(
        `INSERT INTO stock_movements (enterprise_id, warehouse_id, inventory_item_id,
          movement_type, quantity, cost_price, reference_type, reference_id, performed_by, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [data.enterpriseId || null, data.warehouseId, data.inventoryItemId,
         data.movementType, data.quantity, data.costPrice || null,
         data.referenceType || null, data.referenceId || null,
         data.performedBy || null, data.notes || null]
      );

      // Update stock level
      const quantityDelta = ['receipt', 'return', 'adjustment_plus'].includes(data.movementType)
        ? Math.abs(data.quantity)
        : -Math.abs(data.quantity);

      await client.query(
        `INSERT INTO inventory_stock (warehouse_id, inventory_item_id, quantity)
         VALUES ($1, $2, $3)
         ON CONFLICT (warehouse_id, inventory_item_id)
         DO UPDATE SET quantity = inventory_stock.quantity + $3, updated_at = NOW()`,
        [data.warehouseId, data.inventoryItemId, quantityDelta]
      );

      // Create batch record for receipts (FIFO tracking)
      if (data.movementType === 'receipt') {
        await client.query(
          `INSERT INTO inventory_batches (inventory_item_id, warehouse_id, enterprise_id, batch_number, quantity, cost_price, expiry_date, supplier_id, invoice_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [data.inventoryItemId, data.warehouseId, data.enterpriseId || null,
           data.batchNumber || null, Math.abs(data.quantity),
           data.costPrice || null, data.expiryDate || null,
           data.supplierId || null, data.invoiceId || null]
        );
      }

      // Update cost price on receipt
      if (data.movementType === 'receipt' && data.costPrice) {
        await client.query(
          'UPDATE inventory_items SET cost_price = $1 WHERE id = $2',
          [data.costPrice, data.inventoryItemId]
        );
      }

      await client.query('COMMIT');
      return movResult.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getMovements(filters: { warehouseId?: string; inventoryItemId?: string; movementType?: string; limit?: number; offset?: number }): Promise<any[]> {
    const conditions: string[] = [];
    const values: any[] = [];
    let p = 1;
    if (filters.warehouseId) { conditions.push(`m.warehouse_id = $${p++}`); values.push(filters.warehouseId); }
    if (filters.inventoryItemId) { conditions.push(`m.inventory_item_id = $${p++}`); values.push(filters.inventoryItemId); }
    if (filters.movementType) { conditions.push(`m.movement_type = $${p++}`); values.push(filters.movementType); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    values.push(filters.limit || 100, filters.offset || 0);

    const result = await this.pool.query(
      `SELECT m.*, i.name as item_name, i.unit, w.name as warehouse_name, u.first_name, u.last_name
       FROM stock_movements m
       INNER JOIN inventory_items i ON m.inventory_item_id = i.id
       INNER JOIN warehouses w ON m.warehouse_id = w.id
       LEFT JOIN users u ON m.performed_by = u.id
       ${where}
       ORDER BY m.created_at DESC
       LIMIT $${p++} OFFSET $${p}`,
      values
    );
    return result.rows;
  }

  // ========== AUTO-DEDUCTION (for order completion) ==========

  async deductByTechCards(orderId: string, warehouseId: string, performedBy?: string, enterpriseId?: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Verify the warehouse belongs to the caller's enterprise
      if (enterpriseId) {
        const warehouseCheck = await client.query(
          `SELECT id FROM warehouses WHERE id = $1 AND enterprise_id = $2`,
          [warehouseId, enterpriseId]
        );
        if (warehouseCheck.rowCount === 0) {
          throw new Error(`Warehouse ${warehouseId} not found or does not belong to this enterprise`);
        }
      }

      // Get order items with their menu_item_ids
      const orderItems = await client.query(
        `SELECT oi.menu_item_id, oi.quantity
         FROM order_items oi WHERE oi.order_id = $1`,
        [orderId]
      );

      for (const orderItem of orderItems.rows) {
        // Get tech card ingredients for this menu item
        const ingredients = await client.query(
          `SELECT tci.inventory_item_id, tci.quantity, tci.waste_percent
           FROM tech_card_ingredients tci
           INNER JOIN tech_cards tc ON tci.tech_card_id = tc.id
           WHERE tc.menu_item_id = $1 AND tc.is_active = true`,
          [orderItem.menu_item_id]
        );

        for (const ing of ingredients.rows) {
          const wasteFactor = 1 + (parseFloat(ing.waste_percent) || 0) / 100;
          const totalQty = parseFloat(ing.quantity) * orderItem.quantity * wasteFactor;

          // Deduct from stock ATOMICALLY: fail if not enough or row missing.
          // Guarantees stock can never go negative even under concurrent orders.
          const deduct = await client.query(
            `UPDATE inventory_stock
             SET quantity = quantity - $1, updated_at = NOW()
             WHERE warehouse_id = $2 AND inventory_item_id = $3 AND quantity >= $1
             RETURNING quantity`,
            [totalQty, warehouseId, ing.inventory_item_id]
          );
          if (deduct.rowCount === 0) {
            throw new Error(
              `Insufficient stock for inventory_item ${ing.inventory_item_id} ` +
              `in warehouse ${warehouseId} (need ${totalQty})`
            );
          }

          // Record movement
          await client.query(
            `INSERT INTO stock_movements (warehouse_id, inventory_item_id, movement_type, quantity,
              reference_type, reference_id, performed_by)
             VALUES ($1, $2, 'sale', $3, 'order', $4, $5)`,
            [warehouseId, ing.inventory_item_id, totalQty, orderId, performedBy || null]
          );
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // ========== BATCH TRACKING (FIFO) ==========

  async createBatch(data: {
    inventoryItemId: string;
    warehouseId: string;
    enterpriseId?: string;
    batchNumber?: string;
    quantity: number;
    costPrice?: number;
    expiryDate?: string;
    supplierId?: string;
    invoiceId?: string;
  }): Promise<any> {
    const result = await this.pool.query(
      `INSERT INTO inventory_batches (inventory_item_id, warehouse_id, enterprise_id, batch_number, quantity, cost_price, expiry_date, supplier_id, invoice_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [data.inventoryItemId, data.warehouseId, data.enterpriseId || null,
       data.batchNumber || null, data.quantity, data.costPrice || null,
       data.expiryDate || null, data.supplierId || null, data.invoiceId || null]
    );
    return result.rows[0];
  }

  async listBatches(filters: {
    inventoryItemId?: string;
    warehouseId?: string;
    includeExpired?: boolean;
    includeDepleted?: boolean;
  }): Promise<any[]> {
    const conditions: string[] = [];
    const values: any[] = [];
    let p = 1;

    if (filters.inventoryItemId) {
      conditions.push(`b.inventory_item_id = $${p++}`);
      values.push(filters.inventoryItemId);
    }
    if (filters.warehouseId) {
      conditions.push(`b.warehouse_id = $${p++}`);
      values.push(filters.warehouseId);
    }
    if (!filters.includeDepleted) {
      conditions.push('b.is_depleted = false');
    }
    if (!filters.includeExpired) {
      conditions.push('(b.expiry_date IS NULL OR b.expiry_date > NOW())');
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await this.pool.query(
      `SELECT b.*, i.name as item_name, i.unit
       FROM inventory_batches b
       INNER JOIN inventory_items i ON b.inventory_item_id = i.id
       ${where}
       ORDER BY b.received_at ASC`,
      values
    );
    return result.rows;
  }

  async deductFIFO(
    warehouseId: string,
    inventoryItemId: string,
    quantity: number,
    client?: any
  ): Promise<{ deducted: number; batches: any[] }> {
    const conn = client || await this.pool.connect();
    const isOwnConnection = !client;
    try {
      if (isOwnConnection) await conn.query('BEGIN');

      // Lock non-depleted batches in FIFO order
      const batchResult = await conn.query(
        `SELECT * FROM inventory_batches
         WHERE warehouse_id = $1 AND inventory_item_id = $2 AND is_depleted = false
         ORDER BY received_at ASC
         FOR UPDATE`,
        [warehouseId, inventoryItemId]
      );

      const batches = batchResult.rows;
      let remaining = quantity;
      const touchedBatches: any[] = [];

      for (const batch of batches) {
        if (remaining <= 0) break;

        const available = parseFloat(batch.quantity);
        const toDeduct = Math.min(available, remaining);

        if (toDeduct >= available) {
          // Fully consume batch
          await conn.query(
            `UPDATE inventory_batches SET quantity = 0, is_depleted = true WHERE id = $1`,
            [batch.id]
          );
        } else {
          // Partially consume batch
          await conn.query(
            `UPDATE inventory_batches SET quantity = quantity - $1 WHERE id = $2`,
            [toDeduct, batch.id]
          );
        }

        touchedBatches.push({
          batchId: batch.id,
          batchNumber: batch.batch_number,
          deducted: toDeduct,
          remainingInBatch: available - toDeduct,
          costPrice: batch.cost_price,
          expiryDate: batch.expiry_date
        });

        remaining -= toDeduct;
      }

      if (remaining > 0) {
        throw new Error(
          `Insufficient batch stock for item ${inventoryItemId} in warehouse ${warehouseId}: ` +
          `requested ${quantity}, available ${quantity - remaining}`
        );
      }

      if (isOwnConnection) await conn.query('COMMIT');

      return { deducted: quantity, batches: touchedBatches };
    } catch (error) {
      if (isOwnConnection) await conn.query('ROLLBACK');
      throw error;
    } finally {
      if (isOwnConnection) conn.release();
    }
  }

  async getExpiringItems(warehouseId: string, daysAhead?: number): Promise<any[]> {
    const days = daysAhead ?? 7;
    const result = await this.pool.query(
      `SELECT b.*, i.name as item_name, i.unit, i.category
       FROM inventory_batches b
       INNER JOIN inventory_items i ON b.inventory_item_id = i.id
       WHERE b.warehouse_id = $1
         AND b.is_depleted = false
         AND b.expiry_date IS NOT NULL
         AND b.expiry_date <= NOW() + make_interval(days => $2)
       ORDER BY b.expiry_date ASC`,
      [warehouseId, days]
    );
    return result.rows;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default InventoryService;
