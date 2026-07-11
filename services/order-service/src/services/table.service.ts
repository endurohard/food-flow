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

  async create(restaurantId: string, data: CreateTableInput, enterpriseId?: string): Promise<any> {
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
        enterpriseId || null
      ]
    );
    return result.rows[0];
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
