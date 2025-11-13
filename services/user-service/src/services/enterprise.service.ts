import pkg from 'pg';
const { Pool } = pkg;

export interface Enterprise {
  id: string;
  name: string;
  legal_name?: string;
  tax_id?: string;
  phone?: string;
  email?: string;
  website?: string;
  logo_url?: string;
  subscription_plan: string;
  subscription_status: string;
  currency: string;
  timezone: string;
  language: string;
  features: any;
  is_active: boolean;
  is_demo: boolean;
  metadata: any;
  created_at: Date;
  updated_at: Date;
}

export interface EnterpriseUser {
  id: string;
  enterprise_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'manager' | 'employee' | 'viewer';
  permissions: any;
  is_active: boolean;
  joined_at: Date;
}

export interface CreateEnterpriseInput {
  name: string;
  legal_name?: string;
  tax_id?: string;
  phone?: string;
  email?: string;
  website?: string;
  subscription_plan?: string;
  currency?: string;
  timezone?: string;
  language?: string;
}

export interface UpdateEnterpriseInput {
  name?: string;
  legal_name?: string;
  tax_id?: string;
  phone?: string;
  email?: string;
  website?: string;
  logo_url?: string;
  subscription_plan?: string;
  currency?: string;
  timezone?: string;
  language?: string;
  features?: any;
  metadata?: any;
}

export class EnterpriseService {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  /**
   * Create a new enterprise
   */
  async createEnterprise(
    data: CreateEnterpriseInput,
    ownerId?: string
  ): Promise<Enterprise> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Create enterprise
      const enterpriseResult = await client.query(
        `INSERT INTO enterprises (
          name, legal_name, tax_id, phone, email, website,
          subscription_plan, currency, timezone, language
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *`,
        [
          data.name,
          data.legal_name || null,
          data.tax_id || null,
          data.phone || null,
          data.email || null,
          data.website || null,
          data.subscription_plan || 'basic',
          data.currency || 'RUB',
          data.timezone || 'Europe/Moscow',
          data.language || 'ru'
        ]
      );

      const enterprise = enterpriseResult.rows[0];

      // If owner is specified, add them to enterprise_users with owner role
      if (ownerId) {
        await client.query(
          `INSERT INTO enterprise_users (enterprise_id, user_id, role)
           VALUES ($1, $2, $3)`,
          [enterprise.id, ownerId, 'owner']
        );

        // Update user's primary enterprise_id
        await client.query(
          `UPDATE users SET enterprise_id = $1, is_enterprise_admin = true
           WHERE id = $2`,
          [enterprise.id, ownerId]
        );
      }

      await client.query('COMMIT');
      return enterprise;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get enterprise by ID
   */
  async getEnterpriseById(enterpriseId: string): Promise<Enterprise | null> {
    const result = await this.pool.query(
      'SELECT * FROM enterprises WHERE id = $1',
      [enterpriseId]
    );

    return result.rows[0] || null;
  }

  /**
   * Get all enterprises (admin only)
   */
  async getAllEnterprises(
    limit: number = 50,
    offset: number = 0
  ): Promise<{ enterprises: Enterprise[]; total: number }> {
    const countResult = await this.pool.query(
      'SELECT COUNT(*) FROM enterprises'
    );

    const result = await this.pool.query(
      `SELECT * FROM enterprises
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return {
      enterprises: result.rows,
      total: parseInt(countResult.rows[0].count)
    };
  }

  /**
   * Update enterprise
   */
  async updateEnterprise(
    enterpriseId: string,
    data: UpdateEnterpriseInput
  ): Promise<Enterprise> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    Object.entries(data).forEach(([key, value]) => {
      if (value !== undefined) {
        fields.push(`${key} = $${paramCount}`);
        values.push(value);
        paramCount++;
      }
    });

    if (fields.length === 0) {
      throw new Error('No fields to update');
    }

    values.push(enterpriseId);

    const result = await this.pool.query(
      `UPDATE enterprises
       SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $${paramCount}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      throw new Error('Enterprise not found');
    }

    return result.rows[0];
  }

  /**
   * Delete enterprise (soft delete by setting is_active to false)
   */
  async deleteEnterprise(enterpriseId: string): Promise<void> {
    await this.pool.query(
      'UPDATE enterprises SET is_active = false WHERE id = $1',
      [enterpriseId]
    );
  }

  /**
   * Get user's enterprises
   */
  async getUserEnterprises(userId: string): Promise<any[]> {
    const result = await this.pool.query(
      'SELECT * FROM get_user_enterprises($1)',
      [userId]
    );

    return result.rows;
  }

  /**
   * Check if user has access to enterprise
   */
  async checkUserAccess(
    userId: string,
    enterpriseId: string
  ): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT check_enterprise_access($1, $2) as has_access',
      [userId, enterpriseId]
    );

    return result.rows[0]?.has_access || false;
  }

  /**
   * Add user to enterprise
   */
  async addUserToEnterprise(
    enterpriseId: string,
    userId: string,
    role: string = 'employee',
    permissions: any = {}
  ): Promise<EnterpriseUser> {
    const result = await this.pool.query(
      `INSERT INTO enterprise_users (enterprise_id, user_id, role, permissions)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (enterprise_id, user_id) DO UPDATE
       SET role = $3, permissions = $4, is_active = true
       RETURNING *`,
      [enterpriseId, userId, role, JSON.stringify(permissions)]
    );

    return result.rows[0];
  }

  /**
   * Remove user from enterprise
   */
  async removeUserFromEnterprise(
    enterpriseId: string,
    userId: string
  ): Promise<void> {
    await this.pool.query(
      `UPDATE enterprise_users
       SET is_active = false
       WHERE enterprise_id = $1 AND user_id = $2`,
      [enterpriseId, userId]
    );
  }

  /**
   * Get enterprise users
   */
  async getEnterpriseUsers(enterpriseId: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT
        eu.*,
        u.email,
        u.first_name,
        u.last_name,
        u.phone,
        u.is_active as user_is_active
       FROM enterprise_users eu
       INNER JOIN users u ON eu.user_id = u.id
       WHERE eu.enterprise_id = $1 AND eu.is_active = true
       ORDER BY eu.joined_at DESC`,
      [enterpriseId]
    );

    return result.rows;
  }

  /**
   * Update user role in enterprise
   */
  async updateUserRole(
    enterpriseId: string,
    userId: string,
    role: string,
    permissions?: any
  ): Promise<EnterpriseUser> {
    const query = permissions
      ? `UPDATE enterprise_users
         SET role = $3, permissions = $4
         WHERE enterprise_id = $1 AND user_id = $2
         RETURNING *`
      : `UPDATE enterprise_users
         SET role = $3
         WHERE enterprise_id = $1 AND user_id = $2
         RETURNING *`;

    const params = permissions
      ? [enterpriseId, userId, role, JSON.stringify(permissions)]
      : [enterpriseId, userId, role];

    const result = await this.pool.query(query, params);

    if (result.rows.length === 0) {
      throw new Error('User not found in enterprise');
    }

    return result.rows[0];
  }

  /**
   * Get enterprise statistics
   */
  async getEnterpriseStats(enterpriseId: string): Promise<any> {
    const stats = await this.pool.query(
      `SELECT
        (SELECT COUNT(*) FROM users WHERE enterprise_id = $1) as total_users,
        (SELECT COUNT(*) FROM restaurants WHERE enterprise_id = $1) as total_restaurants,
        (SELECT COUNT(*) FROM orders WHERE enterprise_id = $1) as total_orders,
        (SELECT COUNT(*) FROM orders WHERE enterprise_id = $1 AND status = 'completed') as completed_orders,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE enterprise_id = $1 AND status = 'completed') as total_revenue
      `,
      [enterpriseId]
    );

    return stats.rows[0];
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default EnterpriseService;
