import pkg from 'pg';
const { Pool } = pkg;

export interface CreateRestaurantInput {
  name: string;
  description?: string;
  phone?: string;
  email?: string;
  cuisineType?: string[];
  opensAt?: string;
  closesAt?: string;
  deliveryFee?: number;
  minimumOrder?: number;
  estimatedDeliveryTime?: number;
}

export interface UpdateRestaurantInput extends Partial<CreateRestaurantInput> {
  logoUrl?: string;
  coverImageUrl?: string;
  isActive?: boolean;
}

export class RestaurantService {
  private pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async list(filters: {
    enterpriseId?: string;
    ownerId?: string;
    isActive?: boolean;
    cuisineType?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ restaurants: any[]; total: number }> {
    const conditions: string[] = [];
    const values: any[] = [];
    let p = 1;

    if (filters.enterpriseId) {
      conditions.push(`r.enterprise_id = $${p++}`);
      values.push(filters.enterpriseId);
    }
    if (filters.ownerId) {
      conditions.push(`r.owner_id = $${p++}`);
      values.push(filters.ownerId);
    }
    if (filters.isActive !== undefined) {
      conditions.push(`r.is_active = $${p++}`);
      values.push(filters.isActive);
    }
    if (filters.cuisineType) {
      conditions.push(`$${p++} = ANY(r.cuisine_type)`);
      values.push(filters.cuisineType);
    }
    if (filters.search) {
      conditions.push(`(r.name ILIKE $${p} OR r.description ILIKE $${p})`);
      values.push(`%${filters.search}%`);
      p++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;

    const countResult = await this.pool.query(
      `SELECT COUNT(*) FROM restaurants r ${where}`,
      values
    );

    values.push(limit, offset);
    const result = await this.pool.query(
      `SELECT r.*, ra.street_address, ra.city, ra.state, ra.postal_code,
              ra.country, ra.latitude, ra.longitude
       FROM restaurants r
       LEFT JOIN restaurant_addresses ra ON ra.restaurant_id = r.id
       ${where}
       ORDER BY r.created_at DESC
       LIMIT $${p++} OFFSET $${p}`,
      values
    );

    return {
      restaurants: result.rows,
      total: parseInt(countResult.rows[0].count)
    };
  }

  async getById(id: string, enterpriseId?: string): Promise<any> {
    const conds = ['r.id = $1'];
    const vals: any[] = [id];
    if (enterpriseId) {
      conds.push(`r.enterprise_id = $2`);
      vals.push(enterpriseId);
    }
    const result = await this.pool.query(
      `SELECT r.*, ra.street_address, ra.city, ra.state, ra.postal_code,
              ra.country, ra.latitude, ra.longitude
       FROM restaurants r
       LEFT JOIN restaurant_addresses ra ON ra.restaurant_id = r.id
       WHERE ${conds.join(' AND ')}`,
      vals
    );
    return result.rows[0] || null;
  }

  async create(ownerId: string, data: CreateRestaurantInput, enterpriseId?: string): Promise<any> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `INSERT INTO restaurants (owner_id, name, description, phone, email,
          cuisine_type, opens_at, closes_at, delivery_fee, minimum_order,
          estimated_delivery_time, enterprise_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          ownerId,
          data.name,
          data.description || null,
          data.phone || null,
          data.email || null,
          data.cuisineType || [],
          data.opensAt || null,
          data.closesAt || null,
          data.deliveryFee || null,
          data.minimumOrder || null,
          data.estimatedDeliveryTime || null,
          enterpriseId || null
        ]
      );

      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async update(id: string, data: UpdateRestaurantInput, enterpriseId?: string): Promise<any> {
    const fields: string[] = [];
    const values: any[] = [];
    let p = 1;

    const fieldMap: Record<string, string> = {
      name: 'name',
      description: 'description',
      phone: 'phone',
      email: 'email',
      cuisineType: 'cuisine_type',
      opensAt: 'opens_at',
      closesAt: 'closes_at',
      deliveryFee: 'delivery_fee',
      minimumOrder: 'minimum_order',
      estimatedDeliveryTime: 'estimated_delivery_time',
      logoUrl: 'logo_url',
      coverImageUrl: 'cover_image_url',
      isActive: 'is_active'
    };

    for (const [key, dbCol] of Object.entries(fieldMap)) {
      if ((data as any)[key] !== undefined) {
        fields.push(`${dbCol} = $${p++}`);
        values.push((data as any)[key]);
      }
    }

    if (fields.length === 0) {
      return this.getById(id, enterpriseId);
    }

    const whereConds = [`id = $${p++}`];
    values.push(id);
    if (enterpriseId) {
      whereConds.push(`enterprise_id = $${p++}`);
      values.push(enterpriseId);
    }
    const result = await this.pool.query(
      `UPDATE restaurants SET ${fields.join(', ')}
       WHERE ${whereConds.join(' AND ')}
       RETURNING *`,
      values
    );

    return result.rows[0] || null;
  }

  async delete(id: string, enterpriseId?: string): Promise<boolean> {
    const conds = ['id = $1'];
    const vals: any[] = [id];
    if (enterpriseId) {
      conds.push(`enterprise_id = $2`);
      vals.push(enterpriseId);
    }
    const result = await this.pool.query(
      `UPDATE restaurants SET is_active = false WHERE ${conds.join(' AND ')}`,
      vals
    );
    return (result.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default RestaurantService;
