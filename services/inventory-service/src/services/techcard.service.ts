import pkg from 'pg';
const { Pool } = pkg;

export class TechCardService {
  private pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async list(enterpriseId?: string): Promise<any[]> {
    const condition = enterpriseId ? 'WHERE tc.enterprise_id = $1' : '';
    const values = enterpriseId ? [enterpriseId] : [];

    const result = await this.pool.query(
      `SELECT tc.*, mi.name as menu_item_name, mi.price as menu_item_price,
        oi.name as output_item_name, oi.unit as output_item_unit,
        oi.wholesale_price as output_wholesale_price, oi.retail_price as output_retail_price,
        COALESCE(
          json_agg(
            json_build_object(
              'id', tci.id,
              'inventoryItemId', tci.inventory_item_id,
              'itemName', ii.name,
              'quantity', tci.quantity,
              'unit', tci.unit,
              'wastePercent', tci.waste_percent,
              'costPrice', ii.cost_price,
              -- Та же средневзвешенная по остатку, что и в getById:
              -- список карточек не должен противоречить открытой карточке
              'avgCostPrice', (
                SELECT SUM(b.quantity * b.cost_price) / NULLIF(SUM(b.quantity), 0)
                  FROM inventory_batches b
                 WHERE b.inventory_item_id = tci.inventory_item_id
                   AND b.is_depleted = false
                   AND b.quantity > 0
                   AND b.cost_price IS NOT NULL
              )
            )
          ) FILTER (WHERE tci.id IS NOT NULL), '[]'
        ) as ingredients
       FROM tech_cards tc
       LEFT JOIN menu_items mi ON tc.menu_item_id = mi.id
       LEFT JOIN inventory_items oi ON tc.output_item_id = oi.id
       LEFT JOIN tech_card_ingredients tci ON tci.tech_card_id = tc.id
       LEFT JOIN inventory_items ii ON tci.inventory_item_id = ii.id
       ${condition}
       GROUP BY tc.id, mi.name, mi.price, oi.name, oi.unit, oi.wholesale_price, oi.retail_price
       ORDER BY COALESCE(tc.name, mi.name, oi.name)`,
      values
    );
    return result.rows;
  }

  async getById(techCardId: string, enterpriseId?: string): Promise<any> {
    const conds = ['tc.id = $1'];
    const values: any[] = [techCardId];
    if (enterpriseId) { conds.push(`tc.enterprise_id = $${values.length + 1}`); values.push(enterpriseId); }
    const result = await this.pool.query(
      `SELECT tc.*, mi.name as menu_item_name, mi.price as menu_item_price,
        oi.name as output_item_name, oi.unit as output_item_unit,
        oi.wholesale_price as output_wholesale_price, oi.retail_price as output_retail_price
       FROM tech_cards tc
       LEFT JOIN menu_items mi ON tc.menu_item_id = mi.id
       LEFT JOIN inventory_items oi ON tc.output_item_id = oi.id
       WHERE ${conds.join(' AND ')}`,
      values
    );
    if (!result.rows[0]) return null;

    const ingredients = await this.pool.query(
      `SELECT tci.*, ii.name as item_name, ii.cost_price, ii.unit as item_unit,
        -- Средневзвешенная цена ОСТАТКА на складе.
        -- ii.cost_price — цена последнего прихода (или последнего выпуска
        -- для своих полуфабрикатов): она затирается каждой накладной, из-за
        -- чего карточка показывала цену новой дорогой партии, пока по FIFO
        -- списывалась старая дешёвая. Для витрины себестоимости берём
        -- средневзвешенную — так же, как это делает iiko.
        (SELECT SUM(b.quantity * b.cost_price) / NULLIF(SUM(b.quantity), 0)
           FROM inventory_batches b
          WHERE b.inventory_item_id = tci.inventory_item_id
            AND b.is_depleted = false
            AND b.quantity > 0
            AND b.cost_price IS NOT NULL) AS avg_cost_price
       FROM tech_card_ingredients tci
       INNER JOIN inventory_items ii ON tci.inventory_item_id = ii.id
       WHERE tci.tech_card_id = $1`,
      [techCardId]
    );

    return { ...result.rows[0], ingredients: ingredients.rows };
  }

  /**
   * Проверка, что полуфабрикат не попадёт в состав сам себя
   * (прямо или через цепочку: соус → бургер → соус).
   * Без неё расчёт себестоимости и производство уходят в рекурсию.
   *
   * Обход вверх по графу: ищем, не производится ли какой-то из ингредиентов
   * из outputItemId по цепочке производственных техкарт.
   */
  private async assertNoCycle(
    client: any,
    outputItemId: string | null | undefined,
    ingredientItemIds: string[]
  ): Promise<void> {
    if (!outputItemId || ingredientItemIds.length === 0) return;

    // Прямой случай: товар сам у себя в составе
    if (ingredientItemIds.includes(outputItemId)) {
      throw new Error('Полуфабрикат не может входить в состав сам себя');
    }

    // Транзитивный случай: BFS по рёбрам «ингредиент ← выход техкарты»
    const visited = new Set<string>(ingredientItemIds);
    let frontier = [...ingredientItemIds];

    while (frontier.length > 0) {
      const parents = await client.query(
        `SELECT DISTINCT tci.inventory_item_id
         FROM tech_cards tc
         INNER JOIN tech_card_ingredients tci ON tci.tech_card_id = tc.id
         WHERE tc.output_item_id = ANY($1::uuid[]) AND tc.is_active = true`,
        [frontier]
      );

      const next: string[] = [];
      for (const row of parents.rows) {
        const id = row.inventory_item_id;
        if (id === outputItemId) {
          throw new Error(
            'Циклическая техкарта: этот полуфабрикат уже используется ' +
            'в производстве одного из своих ингредиентов'
          );
        }
        if (!visited.has(id)) {
          visited.add(id);
          next.push(id);
        }
      }
      frontier = next;
    }
  }

  async create(data: any, enterpriseId?: string): Promise<any> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const ingredientIds: string[] = (data.ingredients || []).map((i: any) => i.inventoryItemId);
      await this.assertNoCycle(client, data.outputItemId, ingredientIds);

      const tcResult = await client.query(
        `INSERT INTO tech_cards (menu_item_id, enterprise_id, yield_weight, cooking_instructions, name, output_item_id, output_quantity)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [data.menuItemId || null, enterpriseId || null, data.yieldWeight || null, data.cookingInstructions || null,
         data.name || null, data.outputItemId || null, data.outputQuantity ?? 1]
      );
      const techCard = tcResult.rows[0];

      if (data.ingredients && data.ingredients.length > 0) {
        for (const ing of data.ingredients) {
          await client.query(
            `INSERT INTO tech_card_ingredients (tech_card_id, inventory_item_id, quantity, unit, waste_percent, is_optional)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [techCard.id, ing.inventoryItemId, ing.quantity, ing.unit || null,
             ing.wastePercent || 0, ing.isOptional || false]
          );
        }
      }

      await client.query('COMMIT');
      return this.getById(techCard.id);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async update(techCardId: string, data: any, enterpriseId?: string): Promise<any> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Ownership guard: refuse to touch a tech card from another enterprise
      const ownConds = ['id = $1'];
      const ownVals: any[] = [techCardId];
      if (enterpriseId) { ownConds.push('enterprise_id = $2'); ownVals.push(enterpriseId); }
      const owned = await client.query(`SELECT id, output_item_id FROM tech_cards WHERE ${ownConds.join(' AND ')} FOR UPDATE`, ownVals);
      if (!owned.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }

      const fields: string[] = [];
      const values: any[] = [];
      let p = 1;

      if (data.yieldWeight !== undefined) { fields.push(`yield_weight = $${p++}`); values.push(data.yieldWeight); }
      if (data.cookingInstructions !== undefined) { fields.push(`cooking_instructions = $${p++}`); values.push(data.cookingInstructions); }
      if (data.isActive !== undefined) { fields.push(`is_active = $${p++}`); values.push(data.isActive); }
      if (data.name !== undefined) { fields.push(`name = $${p++}`); values.push(data.name); }
      if (data.outputItemId !== undefined) { fields.push(`output_item_id = $${p++}`); values.push(data.outputItemId); }
      if (data.outputQuantity !== undefined) { fields.push(`output_quantity = $${p++}`); values.push(data.outputQuantity); }

      if (fields.length) {
        values.push(techCardId);
        await client.query(
          `UPDATE tech_cards SET ${fields.join(', ')} WHERE id = $${p}`, values
        );
      }

      // Replace ingredients if provided
      if (data.ingredients) {
        // Защита от цикла: берём итоговый outputItemId (новый или текущий)
        const effectiveOutput = data.outputItemId !== undefined
          ? data.outputItemId
          : owned.rows[0].output_item_id;
        const ingredientIds: string[] = data.ingredients.map((i: any) => i.inventoryItemId);
        await this.assertNoCycle(client, effectiveOutput, ingredientIds);

        await client.query('DELETE FROM tech_card_ingredients WHERE tech_card_id = $1', [techCardId]);
        for (const ing of data.ingredients) {
          await client.query(
            `INSERT INTO tech_card_ingredients (tech_card_id, inventory_item_id, quantity, unit, waste_percent, is_optional)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [techCardId, ing.inventoryItemId, ing.quantity, ing.unit || null,
             ing.wastePercent || 0, ing.isOptional || false]
          );
        }
      }

      await client.query('COMMIT');
      return this.getById(techCardId, enterpriseId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async delete(techCardId: string, enterpriseId?: string): Promise<boolean> {
    const conds = ['id = $1'];
    const vals: any[] = [techCardId];
    if (enterpriseId) { conds.push('enterprise_id = $2'); vals.push(enterpriseId); }
    const r = await this.pool.query(`UPDATE tech_cards SET is_active = false WHERE ${conds.join(' AND ')}`, vals);
    return (r.rowCount ?? 0) > 0;
  }

  async getCostCalculation(techCardId: string, enterpriseId?: string): Promise<any> {
    const card = await this.getById(techCardId, enterpriseId);
    if (!card) return null;

    let totalCost = 0;
    const ingredientCosts = card.ingredients.map((ing: any) => {
      const wasteFactor = 1 + (parseFloat(ing.waste_percent) || 0) / 100;

      // Цена берётся по остатку на складе, а не по последней накладной:
      // именно по этим партиям пойдёт списание. Если остатка нет (ещё не
      // закупали или всё израсходовано), откатываемся на справочную цену —
      // иначе карточка показала бы ноль и фуд-кост стал бы бессмысленным.
      const avg = ing.avg_cost_price !== null && ing.avg_cost_price !== undefined
        ? parseFloat(ing.avg_cost_price)
        : NaN;
      const fallback = parseFloat(ing.cost_price) || 0;
      const unitPrice = Number.isFinite(avg) ? avg : fallback;
      const priceSource = Number.isFinite(avg) ? 'stock_avg' : 'last_purchase';

      const cost = parseFloat(ing.quantity) * wasteFactor * unitPrice;
      totalCost += cost;
      return { ...ing, unitPrice, priceSource, calculatedCost: cost };
    });

    const menuPrice = parseFloat(card.menu_item_price) || 0;
    const margin = menuPrice > 0 ? ((menuPrice - totalCost) / menuPrice * 100) : 0;

    // Для производственной техкарты: себестоимость единицы выпуска и маржа по опту/рознице
    const outputQty = parseFloat(card.output_quantity) || 1;
    const unitCost = totalCost / outputQty;
    const wholesalePrice = card.output_wholesale_price !== null && card.output_wholesale_price !== undefined
      ? parseFloat(card.output_wholesale_price) : null;
    const retailPrice = card.output_retail_price !== null && card.output_retail_price !== undefined
      ? parseFloat(card.output_retail_price) : null;

    return {
      techCardId: card.id,
      name: card.name,
      menuItemName: card.menu_item_name,
      outputItemName: card.output_item_name,
      outputQuantity: outputQty,
      menuPrice,
      totalCost,
      unitCost: Math.round(unitCost * 100) / 100,
      margin: Math.round(margin * 100) / 100,
      wholesalePrice,
      retailPrice,
      wholesaleMargin: wholesalePrice && wholesalePrice > 0 ? Math.round((wholesalePrice - unitCost) / wholesalePrice * 10000) / 100 : null,
      retailMargin: retailPrice && retailPrice > 0 ? Math.round((retailPrice - unitCost) / retailPrice * 10000) / 100 : null,
      ingredients: ingredientCosts
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default TechCardService;
