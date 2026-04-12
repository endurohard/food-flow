import pkg from 'pg';
const { Pool } = pkg;

export interface CreateReservationInput {
  restaurantId: string;
  enterpriseId?: string;
  tableId?: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  partySize: number;
  reservationDate: string;
  reservationTime: string;
  durationMinutes?: number;
  depositAmount?: number;
  notes?: string;
  createdBy: string;
}

const VALID_STATUSES = ['pending', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show'] as const;

const STATUS_TRANSITIONS: Record<string, string[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['seated', 'cancelled', 'no_show'],
  seated: ['completed'],
  completed: [],
  cancelled: [],
  no_show: []
};

export class ReservationService {
  private pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async list(filters: {
    restaurantId: string;
    enterpriseId?: string;
    date?: string;
    status?: string;
  }): Promise<any[]> {
    const conditions: string[] = ['restaurant_id = $1'];
    const values: any[] = [filters.restaurantId];
    let p = 2;

    if (filters.enterpriseId) {
      conditions.push(`enterprise_id = $${p++}`);
      values.push(filters.enterpriseId);
    }
    if (filters.date) {
      conditions.push(`reservation_date = $${p++}`);
      values.push(filters.date);
    }
    if (filters.status) {
      conditions.push(`status = $${p++}`);
      values.push(filters.status);
    }

    const result = await this.pool.query(
      `SELECT * FROM reservations
       WHERE ${conditions.join(' AND ')}
       ORDER BY reservation_date, reservation_time`,
      values
    );
    return result.rows;
  }

  async getById(id: string, enterpriseId?: string): Promise<any> {
    const conditions = ['id = $1'];
    const values: any[] = [id];

    if (enterpriseId) {
      conditions.push('enterprise_id = $2');
      values.push(enterpriseId);
    }

    const result = await this.pool.query(
      `SELECT * FROM reservations WHERE ${conditions.join(' AND ')}`,
      values
    );
    return result.rows[0] || null;
  }

  async create(data: CreateReservationInput): Promise<any> {
    // Check for overlapping reservation on the same table if tableId is provided
    if (data.tableId) {
      const duration = data.durationMinutes || 90;
      const overlap = await this.pool.query(
        `SELECT id FROM reservations
         WHERE table_id = $1
           AND reservation_date = $2
           AND status NOT IN ('cancelled', 'no_show', 'completed')
           AND (
             ($3::time, ($3::time + ($4 || ' minutes')::interval)) OVERLAPS
             (reservation_time, (reservation_time + (duration_minutes || ' minutes')::interval))
           )
         LIMIT 1`,
        [data.tableId, data.reservationDate, data.reservationTime, duration]
      );
      if (overlap.rows.length > 0) {
        throw new OverlapError('Table is already reserved for this time slot');
      }
    }

    const result = await this.pool.query(
      `INSERT INTO reservations (
        restaurant_id, enterprise_id, table_id, customer_name, customer_phone,
        customer_email, party_size, reservation_date, reservation_time,
        duration_minutes, deposit_amount, notes, created_by, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending')
      RETURNING *`,
      [
        data.restaurantId,
        data.enterpriseId || null,
        data.tableId || null,
        data.customerName,
        data.customerPhone,
        data.customerEmail || null,
        data.partySize,
        data.reservationDate,
        data.reservationTime,
        data.durationMinutes || 90,
        data.depositAmount || null,
        data.notes || null,
        data.createdBy
      ]
    );
    return result.rows[0];
  }

  async updateStatus(id: string, status: string, enterpriseId?: string): Promise<any> {
    if (!VALID_STATUSES.includes(status as any)) {
      throw new ValidationError(`Invalid status: ${status}. Must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    // Fetch current reservation to validate transition
    const current = await this.getById(id, enterpriseId);
    if (!current) {
      return null;
    }

    const allowed = STATUS_TRANSITIONS[current.status];
    if (!allowed || !allowed.includes(status)) {
      throw new ValidationError(
        `Cannot transition from '${current.status}' to '${status}'. Allowed transitions: ${allowed?.join(', ') || 'none'}`
      );
    }

    const conditions = ['id = $1'];
    const values: any[] = [id];
    let p = 2;

    if (enterpriseId) {
      conditions.push(`enterprise_id = $${p++}`);
      values.push(enterpriseId);
    }

    const result = await this.pool.query(
      `UPDATE reservations SET status = $${p}
       WHERE ${conditions.join(' AND ')}
       RETURNING *`,
      [...values, status]
    );
    return result.rows[0] || null;
  }

  async cancel(id: string, enterpriseId?: string): Promise<any> {
    const current = await this.getById(id, enterpriseId);
    if (!current) {
      return null;
    }

    const allowed = STATUS_TRANSITIONS[current.status];
    if (!allowed || !allowed.includes('cancelled')) {
      throw new ValidationError(
        `Cannot cancel reservation with status '${current.status}'`
      );
    }

    const conditions = ['id = $1'];
    const values: any[] = [id];

    if (enterpriseId) {
      conditions.push('enterprise_id = $2');
      values.push(enterpriseId);
    }

    const result = await this.pool.query(
      `UPDATE reservations SET status = 'cancelled'
       WHERE ${conditions.join(' AND ')}
       RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class OverlapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverlapError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export default ReservationService;
