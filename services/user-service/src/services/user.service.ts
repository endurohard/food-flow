import pkg from 'pg';
const { Pool } = pkg;

export interface UpdateProfileInput {
  firstName?: string;
  lastName?: string;
  phone?: string;
}

export interface CreateAddressInput {
  title?: string;
  streetAddress: string;
  city: string;
  state?: string;
  postalCode?: string;
  country: string;
  latitude?: number;
  longitude?: number;
  isDefault?: boolean;
}

export class UserService {
  private pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async getProfile(userId: string): Promise<any> {
    const result = await this.pool.query(
      `SELECT id, email, first_name, last_name, phone, role, is_active,
              email_verified, enterprise_id, created_at, updated_at
       FROM users WHERE id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];
  }

  async updateProfile(userId: string, data: UpdateProfileInput): Promise<any> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (data.firstName !== undefined) {
      fields.push(`first_name = $${paramCount++}`);
      values.push(data.firstName);
    }
    if (data.lastName !== undefined) {
      fields.push(`last_name = $${paramCount++}`);
      values.push(data.lastName);
    }
    if (data.phone !== undefined) {
      fields.push(`phone = $${paramCount++}`);
      values.push(data.phone);
    }

    if (fields.length === 0) {
      return this.getProfile(userId);
    }

    values.push(userId);

    const result = await this.pool.query(
      `UPDATE users SET ${fields.join(', ')}
       WHERE id = $${paramCount}
       RETURNING id, email, first_name, last_name, phone, role, is_active, email_verified, enterprise_id, created_at, updated_at`,
      values
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];
  }

  async getAddresses(userId: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT id, title, street_address, city, state, postal_code, country,
              latitude, longitude, is_default, created_at
       FROM addresses WHERE user_id = $1
       ORDER BY is_default DESC, created_at DESC`,
      [userId]
    );

    return result.rows;
  }

  async createAddress(userId: string, data: CreateAddressInput): Promise<any> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // If this address is default, unset other defaults
      if (data.isDefault) {
        await client.query(
          'UPDATE addresses SET is_default = false WHERE user_id = $1',
          [userId]
        );
      }

      const result = await client.query(
        `INSERT INTO addresses (user_id, title, street_address, city, state, postal_code, country, latitude, longitude, is_default)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          userId,
          data.title || null,
          data.streetAddress,
          data.city,
          data.state || null,
          data.postalCode || null,
          data.country,
          data.latitude || null,
          data.longitude || null,
          data.isDefault || false
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

  async updateAddress(userId: string, addressId: string, data: Partial<CreateAddressInput>): Promise<any> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Verify ownership
      const check = await client.query(
        'SELECT id FROM addresses WHERE id = $1 AND user_id = $2',
        [addressId, userId]
      );
      if (check.rows.length === 0) {
        return null;
      }

      if (data.isDefault) {
        await client.query(
          'UPDATE addresses SET is_default = false WHERE user_id = $1',
          [userId]
        );
      }

      const fields: string[] = [];
      const values: any[] = [];
      let p = 1;

      if (data.title !== undefined) { fields.push(`title = $${p++}`); values.push(data.title); }
      if (data.streetAddress !== undefined) { fields.push(`street_address = $${p++}`); values.push(data.streetAddress); }
      if (data.city !== undefined) { fields.push(`city = $${p++}`); values.push(data.city); }
      if (data.state !== undefined) { fields.push(`state = $${p++}`); values.push(data.state); }
      if (data.postalCode !== undefined) { fields.push(`postal_code = $${p++}`); values.push(data.postalCode); }
      if (data.country !== undefined) { fields.push(`country = $${p++}`); values.push(data.country); }
      if (data.latitude !== undefined) { fields.push(`latitude = $${p++}`); values.push(data.latitude); }
      if (data.longitude !== undefined) { fields.push(`longitude = $${p++}`); values.push(data.longitude); }
      if (data.isDefault !== undefined) { fields.push(`is_default = $${p++}`); values.push(data.isDefault); }

      if (fields.length === 0) {
        await client.query('COMMIT');
        return check.rows[0];
      }

      values.push(addressId);
      const result = await client.query(
        `UPDATE addresses SET ${fields.join(', ')} WHERE id = $${p} RETURNING *`,
        values
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

  async deleteAddress(userId: string, addressId: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM addresses WHERE id = $1 AND user_id = $2',
      [addressId, userId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default UserService;
