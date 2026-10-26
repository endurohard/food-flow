import pkg from 'pg';
const { Pool } = pkg;

/**
 * Единое дерево номенклатуры (миграция 037).
 *
 * Позиции физически живут в двух таблицах: menu_items (блюда и товары,
 * которые продаются) и inventory_items (товары и заготовки на складе).
 * Сливать их нельзя — на них завязаны заказы, склад и техкарты, поэтому
 * чтение идёт через представление v_nomenclature, а запись адресуется
 * в исходную таблицу по полю source.
 */

export type NomenclatureSource = 'menu' | 'inventory';

export interface NomenclatureGroup {
  id: string;
  parentId: string | null;
  name: string;
  sku: string | null;
  displayOrder: number;
  deletedAt: string | null;
}

export class NomenclatureService {
  private pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  // ========== ГРУППЫ ==========

  async listGroups(enterpriseId: string, includeDeleted = false): Promise<any[]> {
    const r = await this.pool.query(
      `SELECT id, parent_id, name, sku, display_order, deleted_at
         FROM nomenclature_groups
        WHERE enterprise_id = $1 ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
        ORDER BY display_order, name`,
      [enterpriseId]
    );
    return r.rows;
  }

  async createGroup(data: any, enterpriseId: string): Promise<any> {
    // Родитель обязан принадлежать тому же предприятию, иначе через подложенный
    // parentId можно было бы встроить свою группу в чужое дерево.
    if (data.parentId && !(await this.groupBelongsTo(data.parentId, enterpriseId))) {
      throw new Error('PARENT_NOT_FOUND');
    }
    const r = await this.pool.query(
      `INSERT INTO nomenclature_groups (enterprise_id, parent_id, name, sku, display_order)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [enterpriseId, data.parentId || null, data.name, data.sku || null, data.displayOrder ?? 0]
    );
    return r.rows[0];
  }

  async updateGroup(groupId: string, data: any, enterpriseId: string): Promise<any> {
    if (data.parentId !== undefined && data.parentId !== null) {
      if (!(await this.groupBelongsTo(data.parentId, enterpriseId))) throw new Error('PARENT_NOT_FOUND');
      // Цикл длиннее одного звена (A -> B -> A) CHECK'ом не ловится:
      // он видит только одну строку. Поэтому поднимаемся по предкам нового
      // родителя и проверяем, не встретится ли сама перемещаемая группа.
      if (await this.isDescendantOf(data.parentId, groupId)) throw new Error('CYCLE');
    }
    const map: Record<string, string> = {
      parentId: 'parent_id', name: 'name', sku: 'sku', displayOrder: 'display_order'
    };
    const fields: string[] = [];
    const values: any[] = [];
    let p = 1;
    for (const [k, col] of Object.entries(map)) {
      if (data[k] !== undefined) { fields.push(`${col} = $${p++}`); values.push(data[k]); }
    }
    if (!fields.length) return null;
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(groupId, enterpriseId);
    const r = await this.pool.query(
      `UPDATE nomenclature_groups SET ${fields.join(', ')}
        WHERE id = $${p++} AND enterprise_id = $${p} RETURNING *`,
      values
    );
    return r.rows[0] || null;
  }

  /** Мягкое удаление: группа с живыми детьми или позициями не удаляется. */
  async deleteGroup(groupId: string, enterpriseId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const own = await client.query(
        'SELECT 1 FROM nomenclature_groups WHERE id = $1 AND enterprise_id = $2 AND deleted_at IS NULL',
        [groupId, enterpriseId]
      );
      if (!own.rowCount) throw new Error('NOT_FOUND');

      const kids = await client.query(
        'SELECT count(*)::int AS n FROM nomenclature_groups WHERE parent_id = $1 AND deleted_at IS NULL',
        [groupId]
      );
      if (kids.rows[0].n > 0) throw new Error('HAS_CHILDREN');

      const items = await client.query(
        `SELECT (SELECT count(*) FROM menu_items      WHERE nomenclature_group_id = $1 AND deleted_at IS NULL)
              + (SELECT count(*) FROM inventory_items WHERE nomenclature_group_id = $1 AND deleted_at IS NULL)
              AS n`,
        [groupId]
      );
      if (Number(items.rows[0].n) > 0) throw new Error('HAS_ITEMS');

      await client.query(
        'UPDATE nomenclature_groups SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1',
        [groupId]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async restoreGroup(groupId: string, enterpriseId: string): Promise<any> {
    const r = await this.pool.query(
      `UPDATE nomenclature_groups SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND enterprise_id = $2 RETURNING *`,
      [groupId, enterpriseId]
    );
    return r.rows[0] || null;
  }

  // ========== ПОЗИЦИИ ==========

  /**
   * Плоский список позиций дерева. Фильтры соответствуют вкладкам экрана:
   * БЛЮДА (dish), ТОВАРЫ (good), ЗАГОТОВКИ (prepared).
   */
  async listItems(enterpriseId: string, opts: {
    itemType?: string; groupId?: string; includeDeleted?: boolean; search?: string;
  } = {}): Promise<any[]> {
    const conds = ['enterprise_id = $1'];
    const vals: any[] = [enterpriseId];
    let p = 2;
    if (!opts.includeDeleted) conds.push('deleted_at IS NULL');
    if (opts.itemType) { conds.push(`item_type = $${p++}`); vals.push(opts.itemType); }
    if (opts.groupId) { conds.push(`nomenclature_group_id = $${p++}`); vals.push(opts.groupId); }
    if (opts.search) {
      // Ищем и по названию, и по артикулу: в дереве iiko привычно искать по номеру.
      conds.push(`(name ILIKE $${p} OR coalesce(sku,'') ILIKE $${p})`);
      vals.push(`%${opts.search}%`);
      p++;
    }
    const r = await this.pool.query(
      `SELECT id, source, nomenclature_group_id, name, sku, item_type, unit, category,
              accounting_category, tax_category, product_category, prep_station,
              cash_order, price, cost_price, is_available, deleted_at
         FROM v_nomenclature
        WHERE ${conds.join(' AND ')}
        ORDER BY name`,
      vals
    );
    return r.rows;
  }

  /** Дерево групп с вложенными позициями — то, что рисует экран. */
  async getTree(enterpriseId: string, opts: { itemType?: string; includeDeleted?: boolean } = {}): Promise<any> {
    const [groups, items] = await Promise.all([
      this.listGroups(enterpriseId, opts.includeDeleted),
      this.listItems(enterpriseId, opts)
    ]);
    const byId = new Map<string, any>();
    for (const g of groups) {
      byId.set(g.id, {
        id: g.id, name: g.name, sku: g.sku, displayOrder: g.display_order,
        deletedAt: g.deleted_at, children: [], items: []
      });
    }
    const roots: any[] = [];
    for (const g of groups) {
      const node = byId.get(g.id);
      const parent = g.parent_id ? byId.get(g.parent_id) : null;
      // Родитель за пределами выборки (например, удалён и скрыт) — показываем
      // узел в корне, иначе ветка молча исчезнет из дерева вместе с позициями.
      if (parent) parent.children.push(node); else roots.push(node);
    }
    const ungrouped: any[] = [];
    for (const it of items) {
      const node = it.nomenclature_group_id ? byId.get(it.nomenclature_group_id) : null;
      if (node) node.items.push(it); else ungrouped.push(it);
    }
    return { groups: roots, ungrouped };
  }

  async getItem(id: string, source: NomenclatureSource, enterpriseId: string): Promise<any> {
    const r = await this.pool.query(
      'SELECT * FROM v_nomenclature WHERE id = $1 AND source = $2 AND enterprise_id = $3',
      [id, source, enterpriseId]
    );
    return r.rows[0] || null;
  }

  /**
   * Правка полей номенклатуры у существующей позиции. Цена, остатки и прочая
   * бизнес-логика живут в своих сервисах — здесь только справочные поля.
   */
  async updateItem(id: string, source: NomenclatureSource, data: any, enterpriseId: string): Promise<any> {
    if (data.groupId) {
      if (!(await this.groupBelongsTo(data.groupId, enterpriseId))) throw new Error('GROUP_NOT_FOUND');
    }
    const table = source === 'menu' ? 'menu_items' : 'inventory_items';
    const common: Record<string, string> = {
      groupId: 'nomenclature_group_id', name: 'name', sku: 'sku', itemType: 'item_type',
      accountingCategory: 'accounting_category', taxCategory: 'tax_category',
      productCategory: 'product_category'
    };
    const map = source === 'menu'
      ? { ...common, prepStationId: 'prep_station_id', cashOrder: 'cash_order' }
      : { ...common, unit: 'unit' };

    const fields: string[] = [];
    const values: any[] = [];
    let p = 1;
    for (const [k, col] of Object.entries(map)) {
      if (data[k] !== undefined) { fields.push(`${col} = $${p++}`); values.push(data[k]); }
    }
    if (!fields.length) return null;
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id, enterpriseId);
    const r = await this.pool.query(
      `UPDATE ${table} SET ${fields.join(', ')}
        WHERE id = $${p++} AND enterprise_id = $${p} RETURNING *`,
      values
    );
    return r.rows[0] || null;
  }

  /** Мягкое удаление позиции — тумблер «Показать удалённые» вернёт её на экран. */
  async deleteItem(id: string, source: NomenclatureSource, enterpriseId: string): Promise<boolean> {
    const table = source === 'menu' ? 'menu_items' : 'inventory_items';
    const r = await this.pool.query(
      `UPDATE ${table} SET deleted_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND enterprise_id = $2 AND deleted_at IS NULL`,
      [id, enterpriseId]
    );
    return (r.rowCount ?? 0) > 0;
  }

  async restoreItem(id: string, source: NomenclatureSource, enterpriseId: string): Promise<boolean> {
    const table = source === 'menu' ? 'menu_items' : 'inventory_items';
    const r = await this.pool.query(
      `UPDATE ${table} SET deleted_at = NULL WHERE id = $1 AND enterprise_id = $2`,
      [id, enterpriseId]
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Порядок позиций на кассе — отдельная сортировка, не совпадает с деревом. */
  async reorderCash(items: Array<{ id: string; cashOrder: number }>, enterpriseId: string): Promise<number> {
    if (!items.length) return 0;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let n = 0;
      for (const it of items) {
        const r = await client.query(
          'UPDATE menu_items SET cash_order = $1 WHERE id = $2 AND enterprise_id = $3',
          [it.cashOrder, it.id, enterpriseId]
        );
        n += r.rowCount ?? 0;
      }
      await client.query('COMMIT');
      return n;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // ========== ПРОВЕРКИ ВЛАДЕНИЯ ==========

  async groupBelongsTo(groupId: string, enterpriseId: string): Promise<boolean> {
    const r = await this.pool.query(
      'SELECT 1 FROM nomenclature_groups WHERE id = $1 AND enterprise_id = $2',
      [groupId, enterpriseId]
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Является ли candidateId потомком ancestorId (защита от цикла при переносе). */
  async isDescendantOf(candidateId: string, ancestorId: string): Promise<boolean> {
    if (candidateId === ancestorId) return true;
    const r = await this.pool.query(
      `WITH RECURSIVE up AS (
         SELECT id, parent_id FROM nomenclature_groups WHERE id = $1
         UNION ALL
         SELECT g.id, g.parent_id FROM nomenclature_groups g JOIN up ON g.id = up.parent_id
       )
       SELECT 1 FROM up WHERE id = $2 LIMIT 1`,
      [candidateId, ancestorId]
    );
    return (r.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
