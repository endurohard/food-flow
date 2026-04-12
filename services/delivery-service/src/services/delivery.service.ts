import pkg from 'pg';
const { Pool } = pkg;
import { logger } from '../utils/logger';

export class DeliveryService {
  private pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  // ========== DELIVERIES ==========

  async list(filters: {
    enterpriseId?: string;
    driverId?: string; status?: string; restaurantId?: string;
    limit?: number; offset?: number;
  }): Promise<{ deliveries: any[]; total: number }> {
    const conds: string[] = [];
    const vals: any[] = [];
    let p = 1;

    // Tenant isolation via orders.enterprise_id (delivery has no own enterprise_id col)
    if (filters.enterpriseId) { conds.push(`o.enterprise_id = $${p++}`); vals.push(filters.enterpriseId); }
    if (filters.driverId) { conds.push(`d.driver_id = $${p++}`); vals.push(filters.driverId); }
    if (filters.status) { conds.push(`d.status = $${p++}`); vals.push(filters.status); }
    if (filters.restaurantId) { conds.push(`o.restaurant_id = $${p++}`); vals.push(filters.restaurantId); }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const countResult = await this.pool.query(`SELECT COUNT(*) FROM deliveries d INNER JOIN orders o ON d.order_id = o.id ${where}`, vals);

    vals.push(filters.limit || 50, filters.offset || 0);
    const result = await this.pool.query(
      `SELECT d.*, o.order_number, o.total as order_total, o.order_type,
              o.special_instructions, o.restaurant_id,
              r.name as restaurant_name,
              u.first_name as driver_first_name, u.last_name as driver_last_name, u.phone as driver_phone,
              cu.first_name as customer_first_name, cu.last_name as customer_last_name, cu.phone as customer_phone,
              a.street_address, a.city
       FROM deliveries d
       INNER JOIN orders o ON d.order_id = o.id
       LEFT JOIN restaurants r ON o.restaurant_id = r.id
       LEFT JOIN users u ON d.driver_id = u.id
       LEFT JOIN users cu ON o.customer_id = cu.id
       LEFT JOIN addresses a ON o.delivery_address_id = a.id
       ${where}
       ORDER BY d.created_at DESC
       LIMIT $${p++} OFFSET $${p}`,
      vals
    );

    return { deliveries: result.rows, total: parseInt(countResult.rows[0].count) };
  }

  async getById(deliveryId: string, enterpriseId?: string): Promise<any> {
    const conds = ['d.id = $1'];
    const vals: any[] = [deliveryId];
    if (enterpriseId) {
      conds.push(`o.enterprise_id = $2`);
      vals.push(enterpriseId);
    }
    const result = await this.pool.query(
      `SELECT d.*, o.order_number, o.total as order_total, o.order_type,
              r.name as restaurant_name,
              u.first_name as driver_first_name, u.last_name as driver_last_name,
              cu.first_name as customer_first_name, cu.last_name as customer_last_name,
              a.street_address, a.city, a.latitude as dest_lat, a.longitude as dest_lng
       FROM deliveries d
       INNER JOIN orders o ON d.order_id = o.id
       LEFT JOIN restaurants r ON o.restaurant_id = r.id
       LEFT JOIN users u ON d.driver_id = u.id
       LEFT JOIN users cu ON o.customer_id = cu.id
       LEFT JOIN addresses a ON o.delivery_address_id = a.id
       WHERE ${conds.join(' AND ')}`,
      vals
    );
    return result.rows[0] || null;
  }

  async createFromOrder(orderId: string): Promise<any> {
    // Get order with addresses
    const orderResult = await this.pool.query(
      `SELECT o.*, ra.latitude as pickup_lat, ra.longitude as pickup_lng,
              a.latitude as delivery_lat, a.longitude as delivery_lng
       FROM orders o
       LEFT JOIN restaurants r ON o.restaurant_id = r.id
       LEFT JOIN restaurant_addresses ra ON ra.restaurant_id = r.id
       LEFT JOIN addresses a ON o.delivery_address_id = a.id
       WHERE o.id = $1`,
      [orderId]
    );

    if (!orderResult.rows[0]) throw new Error('Order not found');
    const order = orderResult.rows[0];

    const result = await this.pool.query(
      `INSERT INTO deliveries (order_id, status,
        pickup_latitude, pickup_longitude, delivery_latitude, delivery_longitude, assigned_at)
       VALUES ($1, 'assigned', $2, $3, $4, $5, NOW()) RETURNING *`,
      [orderId, order.pickup_lat, order.pickup_lng, order.delivery_lat, order.delivery_lng]
    );

    return result.rows[0];
  }

  async assignDriver(deliveryId: string, driverId: string, enterpriseId?: string): Promise<any> {
    // Tenant guard: only update if delivery belongs to caller's enterprise
    if (enterpriseId) {
      const owner = await this.pool.query(
        `SELECT 1 FROM deliveries d INNER JOIN orders o ON d.order_id = o.id
         WHERE d.id = $1 AND o.enterprise_id = $2`,
        [deliveryId, enterpriseId]
      );
      if (owner.rowCount === 0) return null;
    }
    const result = await this.pool.query(
      `UPDATE deliveries SET driver_id = $1, assigned_at = NOW() WHERE id = $2 RETURNING *`,
      [driverId, deliveryId]
    );
    return result.rows[0] || null;
  }

  async updateStatus(deliveryId: string, status: string, enterpriseId?: string): Promise<any> {
    const extra: string[] = [];
    if (status === 'picked_up') extra.push('picked_up_at = NOW()');
    if (status === 'delivered') extra.push('delivered_at = NOW()');

    const setClause = [`status = $1`, ...extra].join(', ');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Tenant guard: only update if delivery belongs to caller's enterprise
      if (enterpriseId) {
        const owner = await client.query(
          `SELECT 1 FROM deliveries d INNER JOIN orders o ON d.order_id = o.id
           WHERE d.id = $1 AND o.enterprise_id = $2 FOR UPDATE OF d`,
          [deliveryId, enterpriseId]
        );
        if (owner.rowCount === 0) {
          await client.query('ROLLBACK');
          return null;
        }
      }

      const result = await client.query(
        `UPDATE deliveries SET ${setClause} WHERE id = $2 RETURNING *`,
        [status, deliveryId]
      );

      if (result.rows[0] && status === 'delivered') {
        // Update order status too
        await client.query(
          `UPDATE orders SET status = 'delivered', delivered_at = NOW() WHERE id = $1`,
          [result.rows[0].order_id]
        );

        // Increment driver shift counter (atomic — concurrent completions safe)
        if (result.rows[0].driver_id) {
          await client.query(
            `UPDATE driver_shifts SET deliveries_completed = deliveries_completed + 1
             WHERE driver_id = $1 AND status = 'active'`,
            [result.rows[0].driver_id]
          );
        }
      }

      await client.query('COMMIT');
      return result.rows[0] || null;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async updateLocation(deliveryId: string, lat: number, lng: number, speed?: number, heading?: number): Promise<void> {
    // Update current position
    await this.pool.query(
      `UPDATE deliveries SET current_latitude = $1, current_longitude = $2 WHERE id = $3`,
      [lat, lng, deliveryId]
    );

    // Record tracking point
    await this.pool.query(
      `INSERT INTO delivery_tracking (delivery_id, latitude, longitude, speed, heading)
       VALUES ($1, $2, $3, $4, $5)`,
      [deliveryId, lat, lng, speed || null, heading || null]
    );
  }

  async getTrackingHistory(deliveryId: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT * FROM delivery_tracking WHERE delivery_id = $1 ORDER BY recorded_at ASC`,
      [deliveryId]
    );
    return result.rows;
  }

  // ========== DRIVERS ==========

  async getAvailableDrivers(enterpriseId?: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.phone,
              ds.id as shift_id, ds.deliveries_completed,
              (SELECT COUNT(*) FROM deliveries d WHERE d.driver_id = u.id AND d.status IN ('assigned', 'picked_up', 'in_transit')) as active_deliveries
       FROM users u
       INNER JOIN driver_shifts ds ON ds.driver_id = u.id AND ds.status = 'active'
       WHERE u.role = 'delivery_driver' AND u.is_active = true
       ORDER BY active_deliveries ASC, ds.deliveries_completed ASC`
    );
    return result.rows;
  }

  async startShift(driverId: string, enterpriseId?: string): Promise<any> {
    // End any existing active shift
    await this.pool.query(
      `UPDATE driver_shifts SET status = 'ended', end_time = NOW()
       WHERE driver_id = $1 AND status = 'active'`,
      [driverId]
    );

    const result = await this.pool.query(
      `INSERT INTO driver_shifts (driver_id, enterprise_id, start_time, status)
       VALUES ($1, $2, NOW(), 'active') RETURNING *`,
      [driverId, enterpriseId || null]
    );
    return result.rows[0];
  }

  async endShift(driverId: string): Promise<any> {
    const result = await this.pool.query(
      `UPDATE driver_shifts SET status = 'ended', end_time = NOW()
       WHERE driver_id = $1 AND status = 'active' RETURNING *`,
      [driverId]
    );
    return result.rows[0] || null;
  }

  // ========== DELIVERY ZONES ==========

  async listZones(restaurantId: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT * FROM delivery_zones WHERE restaurant_id = $1 AND is_active = true ORDER BY name`,
      [restaurantId]
    );
    return result.rows;
  }

  async createZone(restaurantId: string, data: any, enterpriseId?: string): Promise<any> {
    const result = await this.pool.query(
      `INSERT INTO delivery_zones (restaurant_id, enterprise_id, name, polygon, delivery_fee, min_order_amount, estimated_time_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [restaurantId, enterpriseId || null, data.name, JSON.stringify(data.polygon),
       data.deliveryFee || 0, data.minOrderAmount || 0, data.estimatedTimeMinutes || 30]
    );
    return result.rows[0];
  }

  async updateZone(zoneId: string, data: any): Promise<any> {
    const fields: string[] = [];
    const values: any[] = [];
    let p = 1;
    if (data.name !== undefined) { fields.push(`name = $${p++}`); values.push(data.name); }
    if (data.polygon !== undefined) { fields.push(`polygon = $${p++}`); values.push(JSON.stringify(data.polygon)); }
    if (data.deliveryFee !== undefined) { fields.push(`delivery_fee = $${p++}`); values.push(data.deliveryFee); }
    if (data.minOrderAmount !== undefined) { fields.push(`min_order_amount = $${p++}`); values.push(data.minOrderAmount); }
    if (data.estimatedTimeMinutes !== undefined) { fields.push(`estimated_time_minutes = $${p++}`); values.push(data.estimatedTimeMinutes); }
    if (data.isActive !== undefined) { fields.push(`is_active = $${p++}`); values.push(data.isActive); }

    if (!fields.length) return null;
    values.push(zoneId);
    const result = await this.pool.query(
      `UPDATE delivery_zones SET ${fields.join(', ')} WHERE id = $${p} RETURNING *`, values
    );
    return result.rows[0] || null;
  }

  async deleteZone(zoneId: string): Promise<boolean> {
    const r = await this.pool.query('UPDATE delivery_zones SET is_active = false WHERE id = $1', [zoneId]);
    return (r.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default DeliveryService;
