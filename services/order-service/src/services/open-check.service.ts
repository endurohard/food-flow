import { QueryablePool } from '../middleware/cash-register.middleware';

export interface OpenCheckItem {
  menuItemId: string;
  quantity: number;
}

/**
 * Отложенные чеки режима кассы. Каждый запрос ограничен организацией из
 * токена: id чека чужой организации не читается, не правится и не удаляется.
 */
export class OpenCheckService {
  constructor(private readonly pool: QueryablePool) {}

  private static readonly COLUMNS = `c.id, c.restaurant_id, c.label, c.items, c.status, c.created_at, c.updated_at,
              u.first_name AS created_by_name`;

  async list(enterpriseId: string, restaurantId?: string): Promise<any[]> {
    const params: any[] = [enterpriseId];
    let where = `c.enterprise_id = $1 AND c.status = 'open'`;
    if (restaurantId) {
      params.push(restaurantId);
      where += ` AND c.restaurant_id = $2`;
    }
    const r = await this.pool.query(
      `SELECT ${OpenCheckService.COLUMNS}
         FROM pos_open_checks c LEFT JOIN users u ON u.id = c.created_by
        WHERE ${where}
        ORDER BY c.created_at`,
      params
    );
    return r.rows;
  }

  async create(enterpriseId: string, userId: string, data: { restaurantId: string; label?: string; items: OpenCheckItem[] }): Promise<any> {
    // Точка должна быть своей: иначе чек «повис» бы на чужом ресторане
    const rest = await this.pool.query(
      'SELECT id FROM restaurants WHERE id = $1 AND enterprise_id = $2',
      [data.restaurantId, enterpriseId]
    );
    if (!rest.rows[0]) return null;
    const r = await this.pool.query(
      `INSERT INTO pos_open_checks (enterprise_id, restaurant_id, label, items, created_by, updated_by)
       VALUES ($1, $2, COALESCE(NULLIF($3, ''), 'Чек ' || to_char(NOW() AT TIME ZONE 'Europe/Moscow', 'HH24:MI')), $4::jsonb, $5, $5)
       RETURNING id, restaurant_id, label, items, status, created_at, updated_at`,
      [enterpriseId, data.restaurantId, data.label || '', JSON.stringify(data.items), userId]
    );
    return r.rows[0];
  }

  async update(enterpriseId: string, userId: string, id: string, data: { label?: string; items: OpenCheckItem[] }): Promise<any> {
    const r = await this.pool.query(
      `UPDATE pos_open_checks
          SET items = $1::jsonb,
              label = COALESCE(NULLIF($2, ''), label),
              updated_by = $3, updated_at = NOW()
        WHERE id = $4 AND enterprise_id = $5 AND status = 'open'
        RETURNING id, restaurant_id, label, items, status, created_at, updated_at`,
      [JSON.stringify(data.items), data.label || '', userId, id, enterpriseId]
    );
    return r.rows[0] || null;
  }

  async cancel(enterpriseId: string, userId: string, id: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE pos_open_checks
          SET status = 'cancelled', closed_at = NOW(), updated_by = $1, updated_at = NOW()
        WHERE id = $2 AND enterprise_id = $3 AND status = 'open'
        RETURNING id`,
      [userId, id, enterpriseId]
    );
    return r.rows.length > 0;
  }
}
