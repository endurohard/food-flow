import crypto from 'crypto';
import pkg from 'pg';
const { Pool } = pkg;

export interface MovementFilters {
  enterpriseId?: string;
  warehouseId?: string;
  inventoryItemId?: string;
  movementType?: string;
  movementTypes?: string[];
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export class InventoryService {
  private pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  // ========== INVENTORY ITEMS ==========

  async listItems(filters: { enterpriseId?: string; category?: string; search?: string; lowStock?: boolean; warehouseId?: string }): Promise<any[]> {
    const conditions: string[] = [];
    const values: any[] = [];
    let p = 1;

    // Остаток по одному складу: условие — в JOIN, чтобы товар без остатка
    // на этом складе остался в списке с нулём, а не пропал.
    let stockOn = '';
    let batchWh = '';
    if (filters.warehouseId) {
      values.push(filters.warehouseId);
      stockOn = ` AND s.warehouse_id = $${p}`;
      batchWh = ` AND b.warehouse_id = $${p}`;
      p++;
    }

    if (filters.enterpriseId) { conditions.push(`i.enterprise_id = $${p++}`); values.push(filters.enterpriseId); }
    if (filters.category) { conditions.push(`i.category = $${p++}`); values.push(filters.category); }
    if (filters.search) { conditions.push(`i.name ILIKE $${p++}`); values.push(`%${filters.search}%`); }

    // batch_qty / batch_value — что лежит в партиях и по каким ценам. Стоимость
    // склада считается по ним (по ним же идёт себестоимость продаж), а не
    // «остаток × цена последней накладной», которая завышала или занижала её.
    // by_warehouse — остаток на каждом складе: в режиме «все склады» видно,
    // сколько молока в баре, а сколько на основном.
    let query = `SELECT i.*, COALESCE(SUM(s.quantity), 0) as total_stock,
       (SELECT COALESCE(SUM(b.quantity), 0) FROM inventory_batches b
         WHERE b.inventory_item_id = i.id AND b.is_depleted = false AND b.quantity > 0 AND b.cost_price IS NOT NULL${batchWh}) AS batch_qty,
       (SELECT COALESCE(SUM(b.quantity * b.cost_price), 0) FROM inventory_batches b
         WHERE b.inventory_item_id = i.id AND b.is_depleted = false AND b.quantity > 0 AND b.cost_price IS NOT NULL${batchWh}) AS batch_value,
       (SELECT COALESCE(json_agg(json_build_object('warehouseId', s2.warehouse_id, 'name', w2.name, 'qty', s2.quantity) ORDER BY w2.name), '[]'::json)
          FROM inventory_stock s2 JOIN warehouses w2 ON w2.id = s2.warehouse_id
         WHERE s2.inventory_item_id = i.id AND s2.quantity <> 0) AS by_warehouse
       FROM inventory_items i
       LEFT JOIN inventory_stock s ON s.inventory_item_id = i.id${stockOn}
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

  // ========== OWNERSHIP HELPERS (multi-tenant) ==========

  async warehouseBelongsTo(warehouseId: string, enterpriseId: string): Promise<boolean> {
    const r = await this.pool.query(
      'SELECT 1 FROM warehouses WHERE id = $1 AND enterprise_id = $2', [warehouseId, enterpriseId]
    );
    return (r.rowCount ?? 0) > 0;
  }

  async itemBelongsTo(itemId: string, enterpriseId: string): Promise<boolean> {
    const r = await this.pool.query(
      'SELECT 1 FROM inventory_items WHERE id = $1 AND enterprise_id = $2', [itemId, enterpriseId]
    );
    return (r.rowCount ?? 0) > 0;
  }

  async restaurantBelongsTo(restaurantId: string, enterpriseId: string): Promise<boolean> {
    const r = await this.pool.query(
      'SELECT 1 FROM restaurants WHERE id = $1 AND enterprise_id = $2', [restaurantId, enterpriseId]
    );
    return (r.rowCount ?? 0) > 0;
  }

  // ========== WAREHOUSES ==========

  async listWarehouses(restaurantId: string, enterpriseId?: string): Promise<any[]> {
    const conds = ['w.restaurant_id = $1', 'w.is_active = true'];
    const values: any[] = [restaurantId];
    if (enterpriseId) { conds.push(`w.enterprise_id = $${values.length + 1}`); values.push(enterpriseId); }
    const result = await this.pool.query(
      `SELECT w.*, (SELECT COUNT(*) FROM inventory_stock s WHERE s.warehouse_id = w.id) as items_count
       FROM warehouses w WHERE ${conds.join(' AND ')} ORDER BY w.name`,
      values
    );
    return result.rows;
  }

  /**
   * Склады предприятия целиком, без привязки к точке.
   *
   * Экран склада (inventory.html) грузит список складов, не выбирая точку:
   * приход и списание пишутся на склад предприятия. Требовать restaurantId
   * означало отдавать ему 400 и показывать «у предприятия нет складов» при
   * существующих складах — поэтому отбор только по тенанту.
   */
  async listWarehousesByEnterprise(enterpriseId: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT w.*, (SELECT COUNT(*) FROM inventory_stock s WHERE s.warehouse_id = w.id) as items_count
       FROM warehouses w WHERE w.enterprise_id = $1 AND w.is_active = true ORDER BY w.name`,
      [enterpriseId]
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

  async getStock(warehouseId: string, enterpriseId?: string): Promise<any[]> {
    const conds = ['s.warehouse_id = $1'];
    const values: any[] = [warehouseId];
    // inventory_stock has no enterprise_id — scope through the parent warehouse
    if (enterpriseId) { conds.push(`w.enterprise_id = $${values.length + 1}`); values.push(enterpriseId); }
    const result = await this.pool.query(
      `SELECT s.*, i.name, i.sku, i.category, i.unit, i.min_stock, i.cost_price
       FROM inventory_stock s
       INNER JOIN inventory_items i ON s.inventory_item_id = i.id
       INNER JOIN warehouses w ON s.warehouse_id = w.id
       WHERE ${conds.join(' AND ')}
       ORDER BY i.name`,
      values
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
  }, externalClient?: any): Promise<any> {
    // externalClient — соединение с уже открытой транзакцией (приёмка
    // накладной): тогда движение входит в неё и откатывается вместе с ней.
    // Без него движение — своя транзакция, как раньше.
    const own = !externalClient;
    const client = externalClient || await this.pool.connect();
    try {
      if (own) await client.query('BEGIN');

      const isInflow = ['receipt', 'return', 'adjustment_plus'].includes(data.movementType);
      // Ручной расход (списание, корректировка «минус», перемещение, продажа)
      // снимает и партии — по FIFO, как продажа по техкарте. Раньше уменьшался
      // только остаток, партии оставались полными, и следующая продажа
      // считала себестоимость по товару, которого на складе уже нет.
      let costPrice = data.costPrice;
      if (!isInflow) {
        const qty = Math.abs(data.quantity);
        const fifo = await this.consumeBatchesFIFO(client, data.warehouseId, data.inventoryItemId, qty);
        if (costPrice === undefined && qty > 0) {
          costPrice = (fifo.cost + fifo.uncovered * (await this.lastCost(client, data.inventoryItemId))) / qty;
        }
      }

      // Insert movement
      const movResult = await client.query(
        `INSERT INTO stock_movements (enterprise_id, warehouse_id, inventory_item_id,
          movement_type, quantity, cost_price, reference_type, reference_id, performed_by, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [data.enterpriseId || null, data.warehouseId, data.inventoryItemId,
         data.movementType, data.quantity, costPrice ?? null,
         data.referenceType || null, data.referenceId || null,
         data.performedBy || null, data.notes || null]
      );

      // Update stock level
      const quantityDelta = isInflow
        ? Math.abs(data.quantity)
        : -Math.abs(data.quantity);

      const stockRow = await client.query(
        `INSERT INTO inventory_stock (warehouse_id, inventory_item_id, quantity)
         VALUES ($1, $2, $3)
         ON CONFLICT (warehouse_id, inventory_item_id)
         DO UPDATE SET quantity = inventory_stock.quantity + $3, updated_at = NOW()
         RETURNING quantity`,
        [data.warehouseId, data.inventoryItemId, quantityDelta]
      );

      // Партия на любой приход: и поставка, и возврат, и корректировка «плюс».
      // Иначе остаток растёт, а партий под него нет — FIFO потом не сходится.
      // Если до прихода остаток был в минусе (продали больше, чем было),
      // часть прихода закрывает этот минус: тот товар уже продан и в партию
      // не попадает, иначе партий станет больше, чем товара на складе.
      if (isInflow) {
        const qty = Math.abs(data.quantity);
        const after = parseFloat(stockRow.rows?.[0]?.quantity);
        const before = Number.isFinite(after) ? after - qty : 0;
        const batchQty = qty - Math.min(qty, Math.max(0, -before));
        if (data.movementType !== 'receipt' && costPrice === undefined) {
          costPrice = await this.lastCost(client, data.inventoryItemId);
        }
        if (batchQty > 1e-9) {
          await client.query(
            `INSERT INTO inventory_batches (inventory_item_id, warehouse_id, enterprise_id, batch_number, quantity, cost_price, expiry_date, supplier_id, invoice_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [data.inventoryItemId, data.warehouseId, data.enterpriseId || null,
             data.batchNumber || null, batchQty,
             costPrice || null, data.expiryDate || null,
             data.supplierId || null, data.invoiceId || null]
          );
        }
      }

      // Update cost price on receipt
      if (data.movementType === 'receipt' && data.costPrice) {
        await client.query(
          'UPDATE inventory_items SET cost_price = $1 WHERE id = $2',
          [data.costPrice, data.inventoryItemId]
        );
      }

      if (own) await client.query('COMMIT');
      return movResult.rows[0];
    } catch (error) {
      if (own) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (own) client.release();
    }
  }

  /**
   * Журнал движений склада. Фильтры — в SQL, а не на странице: экран раньше
   * брал последние 500 записей и фильтровал их сам, поэтому движения старше
   * этих 500 найти было нельзя ни по дате, ни по товару.
   * dateFrom — включительно, dateTo — не включительно (полуинтервал).
   */
  async getMovements(filters: MovementFilters): Promise<any[]> {
    const { where, values } = this.movementWhere(filters);
    const p = values.length + 1;
    const result = await this.pool.query(
      `SELECT m.*, i.name as item_name, i.unit, w.name as warehouse_name, u.first_name, u.last_name
       FROM stock_movements m
       INNER JOIN inventory_items i ON m.inventory_item_id = i.id
       INNER JOIN warehouses w ON m.warehouse_id = w.id
       LEFT JOIN users u ON m.performed_by = u.id
       ${where}
       ORDER BY m.created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      [...values, filters.limit || 100, filters.offset || 0]
    );
    return result.rows;
  }

  /** Сколько движений подходит под те же фильтры — для «Показать ещё». */
  async countMovements(filters: MovementFilters): Promise<number> {
    const { where, values } = this.movementWhere(filters);
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS n
       FROM stock_movements m
       INNER JOIN inventory_items i ON m.inventory_item_id = i.id
       ${where}`,
      values
    );
    return result.rows[0] ? Number(result.rows[0].n) || 0 : 0;
  }

  private movementWhere(filters: MovementFilters): { where: string; values: any[] } {
    const conditions: string[] = [];
    const values: any[] = [];
    let p = 1;
    if (filters.enterpriseId) { conditions.push(`m.enterprise_id = $${p++}`); values.push(filters.enterpriseId); }
    if (filters.warehouseId) { conditions.push(`m.warehouse_id = $${p++}`); values.push(filters.warehouseId); }
    if (filters.inventoryItemId) { conditions.push(`m.inventory_item_id = $${p++}`); values.push(filters.inventoryItemId); }
    const types = (filters.movementTypes && filters.movementTypes.length)
      ? filters.movementTypes
      : (filters.movementType ? [filters.movementType] : []);
    if (types.length === 1) { conditions.push(`m.movement_type = $${p++}`); values.push(types[0]); }
    else if (types.length > 1) { conditions.push(`m.movement_type = ANY($${p++})`); values.push(types); }
    if (filters.dateFrom) { conditions.push(`m.created_at >= $${p++}`); values.push(filters.dateFrom); }
    if (filters.dateTo) { conditions.push(`m.created_at < $${p++}`); values.push(filters.dateTo); }
    if (filters.search) {
      conditions.push(`(i.name ILIKE $${p} OR m.notes ILIKE $${p})`); p++;
      values.push('%' + filters.search.replace(/[\\%_]/g, (c) => '\\' + c) + '%');
    }
    return { where: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '', values };
  }

  // ========== AUTO-DEDUCTION (for order completion) ==========

  /**
   * Списание ингредиентов по техкартам при продаже блюда.
   *
   * Списывает через FIFO-партии, поэтому себестоимость самостоятельно
   * произведённых полуфабрикатов (например, свой соус в бургере) берётся
   * по фактической цене выпуска, а не по нулю.
   *
   * Идемпотентно: повторный вызов для того же orderId ничего не списывает
   * (проверка по stock_movements с reference_type = 'order').
   */
  async deductByTechCards(
    orderId: string,
    warehouseId: string,
    performedBy?: string,
    enterpriseId?: string
  ): Promise<{
    deducted: Array<{ inventoryItemId: string; quantity: number; cost: number }>;
    skipped: string[];
    shortages: Array<{ inventoryItemId: string; name: string; needed: number; stockAfter: number }>;
  }> {
    // stock_movements.enterprise_id — NOT NULL, поэтому пустой тенант даёт
    // не внятный отказ, а падение на ограничении уже внутри транзакции.
    // Проверяем заранее: при internal-вызове тенант обязан прийти в теле.
    if (!enterpriseId) {
      throw new Error('Списание невозможно: не передан enterpriseId (контекст предприятия)');
    }
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

      // Защита от двойного списания: заказ мог уже быть проведён
      // (повторный переход статуса, retry из order-service).
      const already = await client.query(
        `SELECT 1 FROM stock_movements
         WHERE reference_type = 'order' AND reference_id = $1 AND movement_type = 'sale'
         LIMIT 1`,
        [orderId]
      );
      if (already.rowCount && already.rowCount > 0) {
        await client.query('COMMIT');
        return { deducted: [], skipped: ['already_deducted'], shortages: [] };
      }

      // Get order items with their menu_item_ids.
      // Дата заказа нужна, чтобы списать по версии техкарты, действовавшей
      // на момент продажи: после смены рецептуры прошлые заказы не должны
      // пересчитываться по новой карте.
      const orderItems = await client.query(
        `SELECT oi.id AS order_item_id, oi.menu_item_id, oi.quantity, o.created_at::date AS order_date
         FROM order_items oi
         INNER JOIN orders o ON o.id = oi.order_id
         WHERE oi.order_id = $1`,
        [orderId]
      );

      const deducted: Array<{ inventoryItemId: string; quantity: number; cost: number }> = [];
      const skipped: string[] = [];
      const shortages: Array<{ inventoryItemId: string; name: string; needed: number; stockAfter: number }> = [];

      for (const orderItem of orderItems.rows) {
        // Метод списания и позиция выпуска действующей на дату заказа карты.
        // Нужны ДО выборки состава: при методе «списывать готовое» сырьё
        // трогать нельзя — оно ушло со склада ещё в момент выпуска партии,
        // и повторное списание было бы двойным учётом.
        const cardMeta = await client.query(
          `SELECT tc.id, tc.write_off_method, tc.output_item_id, tc.output_quantity,
                  ii.name AS output_name
             FROM tech_cards tc
             LEFT JOIN inventory_items ii ON ii.id = tc.output_item_id
            WHERE tc.menu_item_id = $1
              AND tc.is_active = true
              AND tc.effective_from <= $2
              AND (tc.effective_to IS NULL OR tc.effective_to >= $2)
            ORDER BY tc.effective_from DESC
            LIMIT 1`,
          [orderItem.menu_item_id, orderItem.order_date]
        );
        const card = cardMeta.rows[0] || null;
        const writeOffFinished = !!card && card.write_off_method === 'finished';

        // Get tech card ingredients for this menu item.
        // Берём ОДНУ версию, действовавшую на дату заказа. LIMIT 1 в
        // подзапросе обязателен: без него при нескольких подходящих картах
        // вернулись бы ингредиенты всех сразу и списался двойной комплект.
        const ingredients = writeOffFinished
          ? { rowCount: 0, rows: [] as any[] }
          : await client.query(
          `SELECT tci.inventory_item_id, tci.quantity, tci.cold_loss_percent, tci.hot_loss_percent, tci.is_optional,
                  ii.name AS item_name
           FROM tech_card_ingredients tci
           INNER JOIN inventory_items ii ON tci.inventory_item_id = ii.id
           WHERE tci.tech_card_id = (
             SELECT tc.id FROM tech_cards tc
             WHERE tc.menu_item_id = $1
               AND tc.is_active = true
               AND tc.effective_from <= $2
               AND (tc.effective_to IS NULL OR tc.effective_to >= $2)
             ORDER BY tc.effective_from DESC
             LIMIT 1
           )`,
          [orderItem.menu_item_id, orderItem.order_date]
        );

        // Списание одной позиции склада: FIFO для фактической себестоимости,
        // атомарное уменьшение остатка, запись движения. Вынесено в замыкание,
        // потому что одинаково нужно и ингредиентам техкарты, и модификаторам.
        const deductItem = async (
          inventoryItemId: string,
          totalQty: number,
          itemName: string,
          isOptional: boolean,
          note: string
        ): Promise<void> => {
          // Необязательный ингредиент при нехватке просто пропускаем —
          // блюдо готовят без него. Проверяем ДО списания партий.
          if (isOptional) {
            const st = await client.query(
              `SELECT quantity FROM inventory_stock WHERE warehouse_id = $1 AND inventory_item_id = $2 FOR UPDATE`,
              [warehouseId, inventoryItemId]
            );
            if (!st.rows[0] || parseFloat(st.rows[0].quantity) < totalQty) {
              skipped.push(`${itemName}: недостаточно на складе, необязательный — пропущен`);
              return;
            }
          }

          // FIFO по партиям даёт фактическую себестоимость. Нехватка больше НЕ
          // отменяет списание: раньше один недостающий ингредиент откатывал
          // списание всего чека, продажа при этом проходила, и товар молча
          // оставался «на складе». Теперь недостающее уходит в минус и
          // всплывает предупреждением (stock_alerts): продали то, чего по учёту
          // нет, — это надо увидеть, а не потерять в логе.
          const fifo = await this.consumeBatchesFIFO(client, warehouseId, inventoryItemId, totalQty);
          const cost = fifo.cost + fifo.uncovered * (await this.lastCost(client, inventoryItemId));

          const after = await client.query(
            `INSERT INTO inventory_stock (warehouse_id, inventory_item_id, quantity)
             VALUES ($2, $3, -$1::numeric)
             ON CONFLICT (warehouse_id, inventory_item_id)
             DO UPDATE SET quantity = inventory_stock.quantity - $1::numeric, updated_at = NOW()
             RETURNING quantity`,
            [totalQty, warehouseId, inventoryItemId]
          );
          const left = parseFloat(after.rows[0]?.quantity);
          if (left < 0) {
            shortages.push({ inventoryItemId, name: itemName, needed: totalQty, stockAfter: left });
            note += ` — НЕХВАТКА: на складе ${left.toFixed(3)}`;
          }

          // Record movement
          await client.query(
            `INSERT INTO stock_movements (enterprise_id, warehouse_id, inventory_item_id, movement_type,
              quantity, cost_price, reference_type, reference_id, performed_by, notes, order_item_id)
             VALUES ($1, $2, $3, 'sale', $4, $5, 'order', $6, $7, $8, $9)`,
            [
              enterpriseId || null, warehouseId, inventoryItemId, totalQty,
              totalQty > 0 ? cost / totalQty : 0, orderId, performedBy || null,
              note,
              // Строка чека: по ней возврат вернёт ровно то, что списала эта позиция
              orderItem.order_item_id || null
            ]
          );

          deducted.push({ inventoryItemId, quantity: totalQty, cost });
        };

        // У блюда нет техкарты — списывать нечего, это не ошибка.
        // Выбранные модификаторы при этом списать всё равно надо: добавка
        // может иметь свой расход, даже когда у самого блюда карты нет.
        if (!card) {
          skipped.push(`menu_item ${orderItem.menu_item_id}: no tech card`);
        } else if (writeOffFinished) {
          // Метод «списывать готовое блюдо»: со склада уходит уже готовая
          // позиция (output_item_id), а не сырьё — его списали при выпуске.
          // output_quantity — выход за один цикл производства, поэтому
          // расход на порцию равен ему же: одна продажа снимает один выход.
          const perPortion = parseFloat(card.output_quantity) || 0;
          if (perPortion <= 0) {
            // Карта настроена наполовину: выпуск есть, объём не задан.
            // Молча списать ноль нельзя — учёт разойдётся незаметно.
            skipped.push(
              `menu_item ${orderItem.menu_item_id}: метод «списывать готовое», ` +
              `но не задан выход (output_quantity) — списание не выполнено`
            );
          } else {
            await deductItem(
              card.output_item_id,
              perPortion * orderItem.quantity,
              card.output_name || 'готовая позиция',
              false,
              `Списание готового блюда: ${card.output_name || card.output_item_id}`
            );
          }
        } else if (ingredients.rowCount === 0) {
          // Карта есть, но состав пуст: списывать нечего. Это не «нет карты»,
          // и умолчать нельзя — пустая карта тихо обнуляет учёт по блюду.
          skipped.push(`menu_item ${orderItem.menu_item_id}: техкарта без ингредиентов`);
        }

        for (const ing of ingredients.rows) {
          // quantity — это БРУТТО (миграция 032): столько берётся со склада.
          // Потери холодной и горячей обработки влияют на выход порции,
          // но не на списание: испарившаяся влага со склада уже ушла.
          const totalQty = parseFloat(ing.quantity) * orderItem.quantity;
          await deductItem(
            ing.inventory_item_id,
            totalQty,
            ing.item_name,
            !!ing.is_optional,
            `Списание по техкарте: ${ing.item_name}`
          );
        }

        // ── Модификаторы со складским учётом (миграция 034) ──────────────────
        // Раньше модификатор влиял только на цену в чеке, и добавка со склада
        // не уходила никогда: продали 50 кофе с сиропом — остаток сиропа не
        // изменился. Теперь модификатор может нести расход одним из двух
        // способов (они взаимоисключающи по CHECK в схеме).
        const chosenModifiers = await client.query(
          `SELECT oim.name AS chosen_name,
                  mim.name AS modifier_name,
                  mim.inventory_item_id,
                  mim.tech_card_id,
                  mim.quantity
             FROM order_item_modifiers oim
             INNER JOIN menu_item_modifiers mim ON mim.id = oim.modifier_id
            WHERE oim.order_item_id = $1
              AND mim.quantity IS NOT NULL
              AND (mim.inventory_item_id IS NOT NULL OR mim.tech_card_id IS NOT NULL)`,
          [orderItem.order_item_id]
        );

        for (const mod of chosenModifiers.rows) {
          const modName = mod.modifier_name || mod.chosen_name;
          // Расход задан на ОДИН выбор модификатора, а строка заказа может
          // быть на несколько порций — умножаем на количество блюд.
          const modQty = parseFloat(mod.quantity) * orderItem.quantity;

          // Способ 1: прямая позиция склада («доп. сыр 20 г»)
          if (mod.inventory_item_id) {
            const nameRow = await client.query(
              `SELECT name FROM inventory_items WHERE id = $1`,
              [mod.inventory_item_id]
            );
            const itemName = nameRow.rows[0]?.name || modName;
            await deductItem(
              mod.inventory_item_id,
              modQty,
              itemName,
              false,
              `Списание по модификатору «${modName}»: ${itemName}`
            );
            continue;
          }

          // Способ 2: наш полуфабрикат или блюдо по техкарте («соус Цезарь»).
          // Карта с output_item_id выпускает позицию склада — её и списываем
          // одной строкой: полуфабрикат уже сварен и лежит на складе со своей
          // себестоимостью выпуска, разбирать его обратно на сырьё неверно.
          const card = await client.query(
            `SELECT tc.output_item_id, ii.name AS output_name
               FROM tech_cards tc
               LEFT JOIN inventory_items ii ON ii.id = tc.output_item_id
              WHERE tc.id = $1 AND tc.is_active = true`,
            [mod.tech_card_id]
          );
          if (card.rowCount === 0) {
            skipped.push(`модификатор «${modName}»: техкарта неактивна или удалена`);
            continue;
          }

          if (card.rows[0].output_item_id) {
            const outName = card.rows[0].output_name || modName;
            await deductItem(
              card.rows[0].output_item_id,
              modQty,
              outName,
              false,
              `Списание по модификатору «${modName}» (полуфабрикат): ${outName}`
            );
            continue;
          }

          // Карта без выпуска на склад (обычное блюдо) — списываем её сырьё.
          // Версия берётся по дате заказа, как и для самого блюда.
          const modIngredients = await client.query(
            `SELECT tci.inventory_item_id, tci.quantity, tci.is_optional, ii.name AS item_name
               FROM tech_card_ingredients tci
               INNER JOIN inventory_items ii ON ii.id = tci.inventory_item_id
              WHERE tci.tech_card_id = $1`,
            [mod.tech_card_id]
          );
          if (modIngredients.rowCount === 0) {
            skipped.push(`модификатор «${modName}»: у техкарты нет состава`);
            continue;
          }
          for (const ing of modIngredients.rows) {
            await deductItem(
              ing.inventory_item_id,
              parseFloat(ing.quantity) * modQty,
              ing.item_name,
              !!ing.is_optional,
              `Списание по модификатору «${modName}»: ${ing.item_name}`
            );
          }
        }
      }

      await client.query('COMMIT');
      return { deducted, skipped, shortages };
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
    enterpriseId?: string;
    inventoryItemId?: string;
    warehouseId?: string;
    includeExpired?: boolean;
    includeDepleted?: boolean;
  }): Promise<any[]> {
    const conditions: string[] = [];
    const values: any[] = [];
    let p = 1;

    if (filters.enterpriseId) {
      conditions.push(`b.enterprise_id = $${p++}`);
      values.push(filters.enterpriseId);
    }
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

  /** Склады и позиции, затронутые заказом, — для перепроверки минимумов после возврата. */
  async warehousesOfOrder(orderId: string): Promise<Array<{ warehouse_id: string; items: string[] }>> {
    const r = await this.pool.query(
      `SELECT warehouse_id, array_agg(DISTINCT inventory_item_id) AS items
         FROM stock_movements WHERE reference_id = $1 GROUP BY warehouse_id`,
      [orderId]
    );
    return r.rows;
  }

  /** Приход на склад внутри транзакции: остаток + партия (минус закрывается первым). */
  private async inflow(client: any, warehouseId: string, itemId: string, qty: number, cost: number, enterpriseId: string) {
    const r = await client.query(
      `INSERT INTO inventory_stock (warehouse_id, inventory_item_id, quantity) VALUES ($1, $2, $3)
       ON CONFLICT (warehouse_id, inventory_item_id)
       DO UPDATE SET quantity = inventory_stock.quantity + $3, updated_at = NOW()
       RETURNING quantity`,
      [warehouseId, itemId, qty]
    );
    const after = parseFloat(r.rows?.[0]?.quantity);
    const before = Number.isFinite(after) ? after - qty : 0;
    const batchQty = qty - Math.min(qty, Math.max(0, -before));
    if (batchQty > 1e-9) {
      await client.query(
        `INSERT INTO inventory_batches (inventory_item_id, warehouse_id, enterprise_id, quantity, cost_price)
         VALUES ($1, $2, $3, $4, $5)`,
        [itemId, warehouseId, enterpriseId, batchQty, cost || null]
      );
    }
  }

  /**
   * Возврат на склад по возврату чека: ровно то, что списала каждая строка
   * чека (stock_movements.order_item_id), пропорционально возвращённому
   * количеству и по той же себестоимости. Уже возвращённое не возвращается
   * повторно; повтор с тем же refundId ничего не делает. Строки, проданные
   * до появления привязки к строке чека, возвращаются пропорционально всему
   * чеку.
   */
  async returnByOrder(data: {
    orderId: string; refundId: string; enterpriseId: string; performedBy?: string;
    items: Array<{ orderItemId: string; quantity: number }>;
  }): Promise<{ returned: Array<{ inventoryItemId: string; quantity: number }>; replayed: boolean }> {
    const tag = `[возврат ${data.refundId}]`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Сериализуем возвраты одного чека: два параллельных не вернут дважды
      const ord = await client.query(
        `SELECT id, order_number FROM orders WHERE id = $1 AND enterprise_id = $2 FOR UPDATE`,
        [data.orderId, data.enterpriseId]
      );
      if (!ord.rows[0]) throw new Error('ORDER_NOT_FOUND');
      const done = await client.query(
        `SELECT 1 FROM stock_movements WHERE reference_type = 'order_return' AND reference_id = $1 AND notes LIKE $2 LIMIT 1`,
        [data.orderId, `%${tag}%`]
      );
      if (done.rowCount) { await client.query('COMMIT'); return { returned: [], replayed: true }; }

      const lines = await client.query(
        `SELECT id, quantity FROM order_items WHERE order_id = $1`, [data.orderId]
      );
      const lineQty = new Map<string, number>(lines.rows.map((l: any) => [l.id, Number(l.quantity)]));
      const totalUnits = [...lineQty.values()].reduce((a, b) => a + b, 0) || 1;

      const sales = await client.query(
        `SELECT warehouse_id, inventory_item_id, order_item_id, sum(quantity) AS qty,
                sum(quantity * coalesce(cost_price, 0)) / NULLIF(sum(quantity), 0) AS cost
           FROM stock_movements
          WHERE reference_id = $1 AND movement_type = 'sale'
          GROUP BY warehouse_id, inventory_item_id, order_item_id`,
        [data.orderId]
      );
      const back = await client.query(
        `SELECT warehouse_id, inventory_item_id, order_item_id, sum(quantity) AS qty
           FROM stock_movements
          WHERE reference_type = 'order_return' AND reference_id = $1
          GROUP BY warehouse_id, inventory_item_id, order_item_id`,
        [data.orderId]
      );
      const key = (r: any) => `${r.warehouse_id}|${r.inventory_item_id}|${r.order_item_id || ''}`;
      const already = new Map<string, number>(back.rows.map((r: any) => [key(r), parseFloat(r.qty)]));

      const returned: Array<{ inventoryItemId: string; quantity: number }> = [];
      const legacyUnits = data.items.reduce((s, i) => s + i.quantity, 0);
      for (const s of sales.rows) {
        const sold = parseFloat(s.qty);
        let want = 0;
        if (s.order_item_id) {
          const req = data.items.find((i) => i.orderItemId === s.order_item_id);
          const lq = lineQty.get(s.order_item_id) || 0;
          if (!req || !lq) continue;
          want = sold * Math.min(req.quantity, lq) / lq;
        } else {
          want = sold * Math.min(legacyUnits, totalUnits) / totalUnits;
        }
        const qty = Math.round(Math.min(want, sold - (already.get(key(s)) || 0)) * 1000) / 1000;
        if (qty <= 0) continue;
        await this.inflow(client, s.warehouse_id, s.inventory_item_id, qty, parseFloat(s.cost) || 0, data.enterpriseId);
        await client.query(
          `INSERT INTO stock_movements (enterprise_id, warehouse_id, inventory_item_id, movement_type, quantity,
             cost_price, reference_type, reference_id, performed_by, notes, order_item_id)
           VALUES ($1, $2, $3, 'return', $4, $5, 'order_return', $6, $7, $8, $9)`,
          [data.enterpriseId, s.warehouse_id, s.inventory_item_id, qty, parseFloat(s.cost) || 0, data.orderId,
           data.performedBy || null, `Возврат по чеку ${ord.rows[0].order_number} ${tag}`, s.order_item_id]
        );
        returned.push({ inventoryItemId: s.inventory_item_id, quantity: qty });
      }
      await client.query('COMMIT');
      return { returned, replayed: false };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Перемещение между складами одного предприятия одной транзакцией:
   * с исходного склада товар уходит по FIFO (со своей себестоимостью),
   * на целевой приходит партией по той же средней цене. Раньше тип
   * «перемещение» только уменьшал остаток — товар исчезал в никуда.
   * Перемещать можно только то, что есть: в минус перемещение не уводит.
   */
  async transfer(data: {
    fromWarehouseId: string; toWarehouseId: string; inventoryItemId: string;
    quantity: number; notes?: string; performedBy?: string; enterpriseId: string;
  }): Promise<{ transferId: string; costPrice: number; fromQuantity: number; toQuantity: number }> {
    if (data.fromWarehouseId === data.toWarehouseId) throw new Error('TRANSFER_SAME_WAREHOUSE');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const wh = await client.query(
        `SELECT id FROM warehouses WHERE id = ANY($1::uuid[]) AND enterprise_id = $2 AND is_active = true`,
        [[data.fromWarehouseId, data.toWarehouseId], data.enterpriseId]
      );
      if (wh.rowCount !== 2) throw new Error('TRANSFER_WAREHOUSE_NOT_FOUND');
      const src = await client.query(
        `SELECT quantity FROM inventory_stock WHERE warehouse_id = $1 AND inventory_item_id = $2 FOR UPDATE`,
        [data.fromWarehouseId, data.inventoryItemId]
      );
      const have = parseFloat(src.rows[0]?.quantity ?? '0');
      if (have + 1e-9 < data.quantity) throw new Error(`TRANSFER_INSUFFICIENT:${have}`);

      const transferId = crypto.randomUUID();
      const fifo = await this.consumeBatchesFIFO(client, data.fromWarehouseId, data.inventoryItemId, data.quantity);
      const cost = (fifo.cost + fifo.uncovered * (await this.lastCost(client, data.inventoryItemId))) / data.quantity;
      const note = data.notes ? `Перемещение: ${data.notes}` : 'Перемещение между складами';

      const out = await client.query(
        `UPDATE inventory_stock SET quantity = quantity - $1, updated_at = NOW()
          WHERE warehouse_id = $2 AND inventory_item_id = $3 RETURNING quantity`,
        [data.quantity, data.fromWarehouseId, data.inventoryItemId]
      );
      await client.query(
        `INSERT INTO stock_movements (enterprise_id, warehouse_id, inventory_item_id, movement_type, quantity,
           cost_price, reference_type, reference_id, performed_by, notes)
         VALUES ($1, $2, $3, 'transfer', $4, $5, 'transfer', $6, $7, $8)`,
        [data.enterpriseId, data.fromWarehouseId, data.inventoryItemId, data.quantity, cost, transferId, data.performedBy || null, note]
      );
      const inn = await client.query(
        `INSERT INTO inventory_stock (warehouse_id, inventory_item_id, quantity) VALUES ($1, $2, $3)
         ON CONFLICT (warehouse_id, inventory_item_id)
         DO UPDATE SET quantity = inventory_stock.quantity + $3, updated_at = NOW()
         RETURNING quantity`,
        [data.toWarehouseId, data.inventoryItemId, data.quantity]
      );
      // На целевом складе мог быть минус — его закрывает приход, партия только на остаток
      const after = parseFloat(inn.rows[0].quantity);
      const batchQty = data.quantity - Math.min(data.quantity, Math.max(0, -(after - data.quantity)));
      if (batchQty > 1e-9) {
        await client.query(
          `INSERT INTO inventory_batches (inventory_item_id, warehouse_id, enterprise_id, quantity, cost_price)
           VALUES ($1, $2, $3, $4, $5)`,
          [data.inventoryItemId, data.toWarehouseId, data.enterpriseId, batchQty, cost]
        );
      }
      await client.query(
        `INSERT INTO stock_movements (enterprise_id, warehouse_id, inventory_item_id, movement_type, quantity,
           cost_price, reference_type, reference_id, performed_by, notes)
         VALUES ($1, $2, $3, 'transfer_in', $4, $5, 'transfer', $6, $7, $8)`,
        [data.enterpriseId, data.toWarehouseId, data.inventoryItemId, data.quantity, cost, transferId, data.performedBy || null, note]
      );
      await client.query('COMMIT');
      return { transferId, costPrice: cost, fromQuantity: parseFloat(out.rows[0].quantity), toQuantity: after };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Снимает количество с партий по FIFO и НЕ падает при нехватке: возвращает,
   * сколько списано с партий, их стоимость и сколько не покрыто партиями
   * (остаток без партий — старые записи, ручные корректировки, уход в минус).
   */
  async consumeBatchesFIFO(conn: any, warehouseId: string, inventoryItemId: string, quantity: number):
      Promise<{ consumed: number; cost: number; uncovered: number }> {
    const batches = await conn.query(
      `SELECT id, quantity, cost_price FROM inventory_batches
        WHERE warehouse_id = $1 AND inventory_item_id = $2 AND is_depleted = false
        ORDER BY received_at ASC
        FOR UPDATE`,
      [warehouseId, inventoryItemId]
    );
    let remaining = quantity;
    let cost = 0;
    for (const b of batches.rows) {
      if (remaining <= 1e-9) break;
      const available = parseFloat(b.quantity);
      const take = Math.min(available, remaining);
      if (take >= available - 1e-9) {
        await conn.query('UPDATE inventory_batches SET quantity = 0, is_depleted = true WHERE id = $1', [b.id]);
      } else {
        await conn.query('UPDATE inventory_batches SET quantity = quantity - $1 WHERE id = $2', [take, b.id]);
      }
      cost += take * (parseFloat(b.cost_price) || 0);
      remaining -= take;
    }
    const uncovered = Math.max(0, remaining);
    return { consumed: quantity - uncovered, cost, uncovered };
  }

  /** Последняя известная цена позиции — для части, не покрытой партиями. */
  private async lastCost(conn: any, inventoryItemId: string): Promise<number> {
    const r = await conn.query('SELECT cost_price FROM inventory_items WHERE id = $1', [inventoryItemId]);
    return parseFloat(r.rows[0]?.cost_price) || 0;
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

  async getExpiringItems(warehouseId: string | undefined, daysAhead?: number, enterpriseId?: string): Promise<any[]> {
    const days = Math.min(Math.max(daysAhead ?? 7, 0), 90);
    // Срок — дата: сравниваем с CURRENT_DATE, иначе партия «до сегодня»
    // после полуночи по UTC считалась бы на день раньше.
    const conds = [
      'b.is_depleted = false',
      'b.quantity > 0',
      'b.expiry_date IS NOT NULL',
      'b.expiry_date <= CURRENT_DATE + $1::int'
    ];
    const values: any[] = [days];
    if (warehouseId) { values.push(warehouseId); conds.push(`b.warehouse_id = $${values.length}`); }
    if (enterpriseId) { values.push(enterpriseId); conds.push(`i.enterprise_id = $${values.length}`); }
    const result = await this.pool.query(
      `SELECT b.*, i.name as item_name, i.unit, i.category, w.name AS warehouse_name,
              to_char(b.expiry_date, 'YYYY-MM-DD') AS expiry,
              (b.expiry_date - CURRENT_DATE) AS days_left
       FROM inventory_batches b
       INNER JOIN inventory_items i ON b.inventory_item_id = i.id
       LEFT JOIN warehouses w ON w.id = b.warehouse_id
       WHERE ${conds.join(' AND ')}
       ORDER BY b.expiry_date ASC, i.name ASC`,
      values
    );
    return result.rows;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default InventoryService;
