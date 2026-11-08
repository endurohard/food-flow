import pkg from 'pg';
const { Pool } = pkg;

export interface CreateTableInput {
  tableNumber: string;
  section?: string;
  seats?: number;
  posX?: number;
  posY?: number;
  width?: number;
  height?: number;
  shape?: string;
}

/** Ошибка с HTTP-кодом: роут отдаёт её как есть, без 500. */
export class TableError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class TableService {
  private pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async list(restaurantId: string, enterpriseId?: string): Promise<any[]> {
    const conds = ['t.restaurant_id = $1', 't.is_active = true'];
    const values: any[] = [restaurantId];
    if (enterpriseId) {
      conds.push(`t.enterprise_id = $${values.length + 1}`);
      values.push(enterpriseId);
    }
    const result = await this.pool.query(
      `SELECT t.*, o.order_number, o.status as order_status, o.total as order_total
       FROM restaurant_tables t
       LEFT JOIN orders o ON t.current_order_id = o.id
       WHERE ${conds.join(' AND ')}
       ORDER BY t.section ASC, t.table_number ASC`,
      values
    );
    return result.rows;
  }

  /**
   * Предприятие стола берём из самой точки, а не из токена: иначе по чужому
   * restaurantId можно было завести стол в чужой точке со своим enterprise_id.
   */
  async create(restaurantId: string, data: CreateTableInput, enterpriseId?: string): Promise<any> {
    const rest = await this.pool.query(
      'SELECT enterprise_id FROM restaurants WHERE id = $1',
      [restaurantId]
    );
    const owner = rest.rows[0];
    if (!owner || (enterpriseId && owner.enterprise_id !== enterpriseId)) {
      throw new TableError(404, 'Точка не найдена в вашем предприятии');
    }
    await this.assertNumberFree(restaurantId, data.tableNumber);

    const result = await this.pool.query(
      `INSERT INTO restaurant_tables (restaurant_id, table_number, section, seats,
        pos_x, pos_y, width, height, shape, enterprise_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        restaurantId,
        data.tableNumber,
        data.section || null,
        data.seats || 4,
        data.posX || 0,
        data.posY || 0,
        data.width || 100,
        data.height || 100,
        data.shape || 'rectangle',
        owner.enterprise_id
      ]
    );
    return result.rows[0];
  }

  /** Два активных «Стола 3» в одной точке — касса и официант путают заказы. */
  private async assertNumberFree(restaurantId: string, tableNumber: string, exceptId?: string): Promise<void> {
    const values: any[] = [restaurantId, tableNumber];
    let extra = '';
    if (exceptId) {
      values.push(exceptId);
      extra = ' AND id <> $3';
    }
    const dup = await this.pool.query(
      `SELECT 1 FROM restaurant_tables
        WHERE restaurant_id = $1 AND table_number = $2 AND is_active = true${extra}`,
      values
    );
    if ((dup.rowCount ?? 0) > 0) {
      throw new TableError(409, `Стол № ${tableNumber} уже есть в этой точке`);
    }
  }

  async update(tableId: string, data: Partial<CreateTableInput> & { status?: string }, enterpriseId?: string): Promise<any> {
    const fieldMap: Record<string, string> = {
      tableNumber: 'table_number', section: 'section', seats: 'seats',
      posX: 'pos_x', posY: 'pos_y', width: 'width', height: 'height',
      shape: 'shape', status: 'status'
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

    if (data.tableNumber !== undefined) {
      const cur = await this.pool.query(
        `SELECT restaurant_id FROM restaurant_tables WHERE id = $1${enterpriseId ? ' AND enterprise_id = $2' : ''}`,
        enterpriseId ? [tableId, enterpriseId] : [tableId]
      );
      if (!cur.rows[0]) return null;
      await this.assertNumberFree(cur.rows[0].restaurant_id, data.tableNumber, tableId);
    }

    const conds = [`id = $${p++}`];
    values.push(tableId);
    if (enterpriseId) {
      conds.push(`enterprise_id = $${p++}`);
      values.push(enterpriseId);
    }
    const result = await this.pool.query(
      `UPDATE restaurant_tables SET ${fields.join(', ')} WHERE ${conds.join(' AND ')} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  async delete(tableId: string, enterpriseId?: string): Promise<boolean> {
    const conds = ['id = $1'];
    const values: any[] = [tableId];
    if (enterpriseId) {
      conds.push('enterprise_id = $2');
      values.push(enterpriseId);
    }
    const result = await this.pool.query(
      `UPDATE restaurant_tables SET is_active = false WHERE ${conds.join(' AND ')}`,
      values
    );
    return (result.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default TableService;
