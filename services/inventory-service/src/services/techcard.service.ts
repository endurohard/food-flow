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
        COALESCE(
          json_agg(
            json_build_object(
              'id', tci.id,
              'inventoryItemId', tci.inventory_item_id,
              'itemName', ii.name,
              'quantity', tci.quantity,
              'unit', tci.unit,
              'wastePercent', tci.waste_percent,
              'costPrice', ii.cost_price
            )
          ) FILTER (WHERE tci.id IS NOT NULL), '[]'
        ) as ingredients
       FROM tech_cards tc
       INNER JOIN menu_items mi ON tc.menu_item_id = mi.id
       LEFT JOIN tech_card_ingredients tci ON tci.tech_card_id = tc.id
       LEFT JOIN inventory_items ii ON tci.inventory_item_id = ii.id
       ${condition}
       GROUP BY tc.id, mi.name, mi.price
       ORDER BY mi.name`,
      values
    );
    return result.rows;
  }

  async getById(techCardId: string): Promise<any> {
    const result = await this.pool.query(
      `SELECT tc.*, mi.name as menu_item_name, mi.price as menu_item_price
       FROM tech_cards tc
       INNER JOIN menu_items mi ON tc.menu_item_id = mi.id
       WHERE tc.id = $1`,
      [techCardId]
    );
    if (!result.rows[0]) return null;

    const ingredients = await this.pool.query(
      `SELECT tci.*, ii.name as item_name, ii.cost_price, ii.unit as item_unit
       FROM tech_card_ingredients tci
       INNER JOIN inventory_items ii ON tci.inventory_item_id = ii.id
       WHERE tci.tech_card_id = $1`,
      [techCardId]
    );

    return { ...result.rows[0], ingredients: ingredients.rows };
  }

  async create(data: any, enterpriseId?: string): Promise<any> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const tcResult = await client.query(
        `INSERT INTO tech_cards (menu_item_id, enterprise_id, yield_weight, cooking_instructions)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [data.menuItemId, enterpriseId || null, data.yieldWeight || null, data.cookingInstructions || null]
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

  async update(techCardId: string, data: any): Promise<any> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const fields: string[] = [];
      const values: any[] = [];
      let p = 1;

      if (data.yieldWeight !== undefined) { fields.push(`yield_weight = $${p++}`); values.push(data.yieldWeight); }
      if (data.cookingInstructions !== undefined) { fields.push(`cooking_instructions = $${p++}`); values.push(data.cookingInstructions); }
      if (data.isActive !== undefined) { fields.push(`is_active = $${p++}`); values.push(data.isActive); }

      if (fields.length) {
        values.push(techCardId);
        await client.query(
          `UPDATE tech_cards SET ${fields.join(', ')} WHERE id = $${p}`, values
        );
      }

      // Replace ingredients if provided
      if (data.ingredients) {
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
      return this.getById(techCardId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async delete(techCardId: string): Promise<boolean> {
    const r = await this.pool.query('UPDATE tech_cards SET is_active = false WHERE id = $1', [techCardId]);
    return (r.rowCount ?? 0) > 0;
  }

  async getCostCalculation(techCardId: string): Promise<any> {
    const card = await this.getById(techCardId);
    if (!card) return null;

    let totalCost = 0;
    const ingredientCosts = card.ingredients.map((ing: any) => {
      const wasteFactor = 1 + (parseFloat(ing.waste_percent) || 0) / 100;
      const cost = parseFloat(ing.quantity) * wasteFactor * (parseFloat(ing.cost_price) || 0);
      totalCost += cost;
      return { ...ing, calculatedCost: cost };
    });

    const menuPrice = parseFloat(card.menu_item_price) || 0;
    const margin = menuPrice > 0 ? ((menuPrice - totalCost) / menuPrice * 100) : 0;

    return {
      techCardId: card.id,
      menuItemName: card.menu_item_name,
      menuPrice,
      totalCost,
      margin: Math.round(margin * 100) / 100,
      ingredients: ingredientCosts
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default TechCardService;
