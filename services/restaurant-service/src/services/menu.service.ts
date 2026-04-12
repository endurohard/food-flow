import pkg from 'pg';
const { Pool } = pkg;

export interface CreateCategoryInput {
  name: string;
  description?: string;
  displayOrder?: number;
}

export interface CreateMenuItemInput {
  categoryId?: string;
  name: string;
  description?: string;
  price: number;
  imageUrl?: string;
  isVegetarian?: boolean;
  isVegan?: boolean;
  isGlutenFree?: boolean;
  calories?: number;
  preparationTime?: number;
  sku?: string;
  costPrice?: number;
  taxRate?: number;
  unit?: string;
  weightGrams?: number;
}

export interface CreateModifierInput {
  name: string;
  modifierGroup?: string;
  priceAdjustment?: number;
  isDefault?: boolean;
}

export class MenuService {
  private pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  // ========== CATEGORIES ==========

  async getCategories(restaurantId: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT * FROM menu_categories
       WHERE restaurant_id = $1 AND is_active = true
       ORDER BY display_order ASC, name ASC`,
      [restaurantId]
    );
    return result.rows;
  }

  async createCategory(restaurantId: string, data: CreateCategoryInput, enterpriseId?: string): Promise<any> {
    const result = await this.pool.query(
      `INSERT INTO menu_categories (restaurant_id, name, description, display_order, enterprise_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [restaurantId, data.name, data.description || null, data.displayOrder || 0, enterpriseId || null]
    );
    return result.rows[0];
  }

  async updateCategory(categoryId: string, data: Partial<CreateCategoryInput> & { isActive?: boolean }): Promise<any> {
    const fields: string[] = [];
    const values: any[] = [];
    let p = 1;

    if (data.name !== undefined) { fields.push(`name = $${p++}`); values.push(data.name); }
    if (data.description !== undefined) { fields.push(`description = $${p++}`); values.push(data.description); }
    if (data.displayOrder !== undefined) { fields.push(`display_order = $${p++}`); values.push(data.displayOrder); }
    if (data.isActive !== undefined) { fields.push(`is_active = $${p++}`); values.push(data.isActive); }

    if (fields.length === 0) return null;

    values.push(categoryId);
    const result = await this.pool.query(
      `UPDATE menu_categories SET ${fields.join(', ')} WHERE id = $${p} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  async deleteCategory(categoryId: string): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE menu_categories SET is_active = false WHERE id = $1',
      [categoryId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ========== MENU ITEMS ==========

  async getItems(restaurantId: string, categoryId?: string): Promise<any[]> {
    let query = `SELECT mi.*, mc.name as category_name
       FROM menu_items mi
       LEFT JOIN menu_categories mc ON mc.id = mi.category_id
       WHERE mi.restaurant_id = $1`;
    const values: any[] = [restaurantId];

    if (categoryId) {
      query += ' AND mi.category_id = $2';
      values.push(categoryId);
    }

    query += ' ORDER BY mc.display_order ASC, mi.name ASC';
    const result = await this.pool.query(query, values);
    return result.rows;
  }

  async getItemById(itemId: string): Promise<any> {
    const result = await this.pool.query(
      `SELECT mi.*, mc.name as category_name
       FROM menu_items mi
       LEFT JOIN menu_categories mc ON mc.id = mi.category_id
       WHERE mi.id = $1`,
      [itemId]
    );
    return result.rows[0] || null;
  }

  async createItem(restaurantId: string, data: CreateMenuItemInput, enterpriseId?: string): Promise<any> {
    const result = await this.pool.query(
      `INSERT INTO menu_items (
        restaurant_id, category_id, name, description, price, image_url,
        is_vegetarian, is_vegan, is_gluten_free, calories, preparation_time,
        sku, cost_price, tax_rate, unit, weight_grams, enterprise_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING *`,
      [
        restaurantId,
        data.categoryId || null,
        data.name,
        data.description || null,
        data.price,
        data.imageUrl || null,
        data.isVegetarian || false,
        data.isVegan || false,
        data.isGlutenFree || false,
        data.calories || null,
        data.preparationTime || null,
        data.sku || null,
        data.costPrice || null,
        data.taxRate || 0,
        data.unit || 'piece',
        data.weightGrams || null,
        enterpriseId || null
      ]
    );
    return result.rows[0];
  }

  async updateItem(itemId: string, data: Partial<CreateMenuItemInput> & { isAvailable?: boolean }): Promise<any> {
    const fieldMap: Record<string, string> = {
      categoryId: 'category_id', name: 'name', description: 'description',
      price: 'price', imageUrl: 'image_url', isAvailable: 'is_available',
      isVegetarian: 'is_vegetarian', isVegan: 'is_vegan', isGlutenFree: 'is_gluten_free',
      calories: 'calories', preparationTime: 'preparation_time',
      sku: 'sku', costPrice: 'cost_price', taxRate: 'tax_rate',
      unit: 'unit', weightGrams: 'weight_grams'
    };

    const fields: string[] = [];
    const values: any[] = [];
    let p = 1;

    for (const [key, dbCol] of Object.entries(fieldMap)) {
      if ((data as any)[key] !== undefined) {
        fields.push(`${dbCol} = $${p++}`);
        values.push((data as any)[key]);
      }
    }

    if (fields.length === 0) return null;

    values.push(itemId);
    const result = await this.pool.query(
      `UPDATE menu_items SET ${fields.join(', ')} WHERE id = $${p} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  async deleteItem(itemId: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM menu_items WHERE id = $1',
      [itemId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ========== MODIFIERS ==========

  async getModifiers(menuItemId: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT * FROM menu_item_modifiers
       WHERE menu_item_id = $1 AND is_available = true
       ORDER BY modifier_group ASC, display_order ASC`,
      [menuItemId]
    );
    return result.rows;
  }

  async createModifier(menuItemId: string, data: CreateModifierInput, enterpriseId?: string): Promise<any> {
    const result = await this.pool.query(
      `INSERT INTO menu_item_modifiers (menu_item_id, name, modifier_group, price_adjustment, is_default, enterprise_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [menuItemId, data.name, data.modifierGroup || null, data.priceAdjustment || 0, data.isDefault || false, enterpriseId || null]
    );
    return result.rows[0];
  }

  async updateModifier(modifierId: string, data: Partial<CreateModifierInput> & { isAvailable?: boolean }): Promise<any> {
    const fields: string[] = [];
    const values: any[] = [];
    let p = 1;

    if (data.name !== undefined) { fields.push(`name = $${p++}`); values.push(data.name); }
    if (data.modifierGroup !== undefined) { fields.push(`modifier_group = $${p++}`); values.push(data.modifierGroup); }
    if (data.priceAdjustment !== undefined) { fields.push(`price_adjustment = $${p++}`); values.push(data.priceAdjustment); }
    if (data.isDefault !== undefined) { fields.push(`is_default = $${p++}`); values.push(data.isDefault); }
    if (data.isAvailable !== undefined) { fields.push(`is_available = $${p++}`); values.push(data.isAvailable); }

    if (fields.length === 0) return null;

    values.push(modifierId);
    const result = await this.pool.query(
      `UPDATE menu_item_modifiers SET ${fields.join(', ')} WHERE id = $${p} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  async deleteModifier(modifierId: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM menu_item_modifiers WHERE id = $1',
      [modifierId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ========== FULL MENU (nested) ==========

  async getFullMenu(restaurantId: string): Promise<any[]> {
    const categories = await this.getCategories(restaurantId);

    const items = await this.pool.query(
      `SELECT mi.*,
        COALESCE(
          json_agg(
            json_build_object(
              'id', m.id, 'name', m.name, 'modifierGroup', m.modifier_group,
              'priceAdjustment', m.price_adjustment, 'isDefault', m.is_default
            )
          ) FILTER (WHERE m.id IS NOT NULL), '[]'
        ) as modifiers
       FROM menu_items mi
       LEFT JOIN menu_item_modifiers m ON m.menu_item_id = mi.id AND m.is_available = true
       WHERE mi.restaurant_id = $1
       GROUP BY mi.id
       ORDER BY mi.name ASC`,
      [restaurantId]
    );

    const itemsByCategory = new Map<string | null, any[]>();
    for (const item of items.rows) {
      const catId = item.category_id;
      if (!itemsByCategory.has(catId)) {
        itemsByCategory.set(catId, []);
      }
      itemsByCategory.get(catId)!.push(item);
    }

    return categories.map(cat => ({
      ...cat,
      items: itemsByCategory.get(cat.id) || []
    }));
  }

  // ========== STOP-LIST ==========

  async stopMenuItem(itemId: string, reason: string, stoppedBy: string, stopUntil?: string, enterpriseId?: string): Promise<any> {
    const conditions = ['id = $1'];
    const values: any[] = [itemId];
    let p = 2;

    if (enterpriseId) {
      conditions.push(`enterprise_id = $${p++}`);
      values.push(enterpriseId);
    }

    const result = await this.pool.query(
      `UPDATE menu_items
       SET is_available = false,
           stop_reason = $${p++},
           stopped_at = NOW(),
           stop_until = $${p++},
           stopped_by = $${p++}
       WHERE ${conditions.join(' AND ')}
       RETURNING *`,
      [...values, reason, stopUntil || null, stoppedBy]
    );
    return result.rows[0] || null;
  }

  async unstopMenuItem(itemId: string, enterpriseId?: string): Promise<any> {
    const conditions = ['id = $1'];
    const values: any[] = [itemId];

    if (enterpriseId) {
      conditions.push('enterprise_id = $2');
      values.push(enterpriseId);
    }

    const result = await this.pool.query(
      `UPDATE menu_items
       SET is_available = true,
           stop_reason = NULL,
           stopped_at = NULL,
           stop_until = NULL,
           stopped_by = NULL
       WHERE ${conditions.join(' AND ')}
       RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  async getStopList(restaurantId: string, enterpriseId?: string): Promise<any[]> {
    const conditions = ['restaurant_id = $1', 'is_available = false', 'stop_reason IS NOT NULL'];
    const values: any[] = [restaurantId];
    let p = 2;

    if (enterpriseId) {
      conditions.push(`enterprise_id = $${p++}`);
      values.push(enterpriseId);
    }

    const result = await this.pool.query(
      `SELECT id, name, stop_reason, stopped_at, stop_until, stopped_by
       FROM menu_items
       WHERE ${conditions.join(' AND ')}
       ORDER BY stopped_at DESC`,
      values
    );
    return result.rows;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default MenuService;
