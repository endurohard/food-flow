import pkg from 'pg';
const { Pool } = pkg;

export class CounterpartyService {
  private pool: InstanceType<typeof Pool>;

  constructor(pool: InstanceType<typeof Pool>) {
    this.pool = pool;
  }

  async list(filters: { enterpriseId?: string; managerId?: string; search?: string; includeInactive?: boolean }): Promise<any[]> {
    const conditions: string[] = [];
    const values: any[] = [];
    let p = 1;
    if (!filters.includeInactive) conditions.push('c.is_active = true');
    if (filters.enterpriseId) { conditions.push(`c.enterprise_id = $${p++}`); values.push(filters.enterpriseId); }
    if (filters.managerId) { conditions.push(`c.manager_id = $${p++}`); values.push(filters.managerId); }
    if (filters.search) {
      conditions.push(`(c.name ILIKE $${p} OR c.legal_name ILIKE $${p} OR c.phone ILIKE $${p} OR c.tax_id ILIKE $${p})`);
      values.push(`%${filters.search}%`);
      p++;
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await this.pool.query(
      `SELECT c.*,
              u.first_name AS manager_first_name, u.last_name AS manager_last_name
       FROM counterparties c
       LEFT JOIN users u ON c.manager_id = u.id
       ${where}
       ORDER BY c.name`,
      values
    );
    return result.rows;
  }

  async getById(id: string, enterpriseId?: string): Promise<any | null> {
    const conds = ['c.id = $1'];
    const vals: any[] = [id];
    if (enterpriseId) { conds.push('c.enterprise_id = $2'); vals.push(enterpriseId); }
    const result = await this.pool.query(
      `SELECT c.*,
              u.first_name AS manager_first_name, u.last_name AS manager_last_name
       FROM counterparties c
       LEFT JOIN users u ON c.manager_id = u.id
       WHERE ${conds.join(' AND ')}`,
      vals
    );
    return result.rows[0] || null;
  }

  async create(data: any, enterpriseId?: string): Promise<any> {
    const result = await this.pool.query(
      `INSERT INTO counterparties (enterprise_id, name, legal_name, tax_id, contact_person, phone,
         whatsapp_phone, email, address, delivery_address, manager_id, payment_terms,
         payment_deferral_days, credit_limit, price_type, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [enterpriseId || null, data.name, data.legalName || null, data.taxId || null,
       data.contactPerson || null, data.phone || null, data.whatsappPhone || data.phone || null,
       data.email || null, data.address || null, data.deliveryAddress || null,
       data.managerId || null, data.paymentTerms || 'on_delivery',
       data.paymentDeferralDays ?? 0, data.creditLimit ?? 0,
       data.priceType || 'wholesale', data.notes || null]
    );
    return result.rows[0];
  }

  async update(id: string, data: any, enterpriseId?: string): Promise<any | null> {
    const map: Record<string, string> = {
      name: 'name', legalName: 'legal_name', taxId: 'tax_id', contactPerson: 'contact_person',
      phone: 'phone', whatsappPhone: 'whatsapp_phone', email: 'email', address: 'address',
      deliveryAddress: 'delivery_address', managerId: 'manager_id', paymentTerms: 'payment_terms',
      paymentDeferralDays: 'payment_deferral_days', creditLimit: 'credit_limit',
      priceType: 'price_type', notes: 'notes', isActive: 'is_active'
    };
    const fields: string[] = [];
    const values: any[] = [];
    let p = 1;
    for (const [k, col] of Object.entries(map)) {
      if (data[k] !== undefined) { fields.push(`${col} = $${p++}`); values.push(data[k]); }
    }
    if (!fields.length) return null;
    fields.push('updated_at = NOW()');
    const whereConds = [`id = $${p++}`];
    values.push(id);
    if (enterpriseId) { whereConds.push(`enterprise_id = $${p++}`); values.push(enterpriseId); }
    const result = await this.pool.query(
      `UPDATE counterparties SET ${fields.join(', ')} WHERE ${whereConds.join(' AND ')} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  async deactivate(id: string, enterpriseId?: string): Promise<boolean> {
    const conds = ['id = $1'];
    const vals: any[] = [id];
    if (enterpriseId) { conds.push('enterprise_id = $2'); vals.push(enterpriseId); }
    const r = await this.pool.query(
      `UPDATE counterparties SET is_active = false, updated_at = NOW() WHERE ${conds.join(' AND ')}`, vals
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Баланс контрагента: текущий долг + история взаиморасчётов */
  async getBalance(id: string, enterpriseId?: string): Promise<any | null> {
    const cp = await this.getById(id, enterpriseId);
    if (!cp) return null;

    const ordersConds = ['counterparty_id = $1', "status NOT IN ('draft', 'cancelled')"];
    const ordersVals: any[] = [id];
    if (enterpriseId) { ordersConds.push('enterprise_id = $2'); ordersVals.push(enterpriseId); }
    const orders = await this.pool.query(
      `SELECT COUNT(*) AS orders_count,
              COALESCE(SUM(total_amount), 0) AS total_ordered,
              COALESCE(SUM(paid_amount), 0) AS total_paid
       FROM wholesale_orders
       WHERE ${ordersConds.join(' AND ')}`,
      ordersVals
    );
    const payConds = ['counterparty_id = $1'];
    const payVals: any[] = [id];
    if (enterpriseId) { payConds.push('enterprise_id = $2'); payVals.push(enterpriseId); }
    const payments = await this.pool.query(
      `SELECT payment_type, method, COALESCE(SUM(amount), 0) AS total
       FROM counterparty_payments
       WHERE ${payConds.join(' AND ')}
       GROUP BY payment_type, method`,
      payVals
    );
    return {
      counterpartyId: id,
      name: cp.name,
      balance: parseFloat(cp.balance),
      creditLimit: parseFloat(cp.credit_limit),
      paymentTerms: cp.payment_terms,
      ordersCount: parseInt(orders.rows[0].orders_count, 10),
      totalOrdered: parseFloat(orders.rows[0].total_ordered),
      totalPaid: parseFloat(orders.rows[0].total_paid),
      paymentsBreakdown: payments.rows
    };
  }
}

export default CounterpartyService;
