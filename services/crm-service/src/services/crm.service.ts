import pkg from 'pg';
const { Pool } = pkg;

export class CRMService {
  private pool: InstanceType<typeof Pool>;
  constructor(connectionString: string) { this.pool = new Pool({ connectionString }); }

  // ========== CUSTOMER PROFILES ==========

  async listCustomers(filters: { enterpriseId?: string; loyaltyTier?: string; tag?: string }): Promise<any[]> {
    const conds: string[] = [];
    const vals: any[] = [];
    let p = 1;
    if (filters.enterpriseId) { conds.push(`cp.enterprise_id = $${p++}`); vals.push(filters.enterpriseId); }
    if (filters.loyaltyTier) { conds.push(`cp.loyalty_tier = $${p++}`); vals.push(filters.loyaltyTier); }
    if (filters.tag) { conds.push(`$${p++} = ANY(cp.tags)`); vals.push(filters.tag); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const result = await this.pool.query(
      `SELECT cp.*, u.email, u.first_name, u.last_name, u.phone
       FROM customer_profiles cp
       INNER JOIN users u ON cp.user_id = u.id
       ${where}
       ORDER BY cp.total_spent DESC`, vals
    );
    return result.rows;
  }

  async getCustomerProfile(userId: string): Promise<any> {
    const result = await this.pool.query(
      `SELECT cp.*, u.email, u.first_name, u.last_name, u.phone
       FROM customer_profiles cp
       INNER JOIN users u ON cp.user_id = u.id
       WHERE cp.user_id = $1`, [userId]
    );
    return result.rows[0] || null;
  }

  async createProfile(data: any): Promise<any> {
    const result = await this.pool.query(
      `INSERT INTO customer_profiles
         (user_id, enterprise_id, birthday, preferences, tags, source, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        data.userId,
        data.enterpriseId || null,
        data.birthday || null,
        data.preferences ? JSON.stringify(data.preferences) : '{}',
        data.tags || null,
        data.source || null,
        data.notes || null
      ]
    );
    return result.rows[0];
  }

  async updateProfile(userId: string, data: any, enterpriseId?: string): Promise<any> {
    const map: Record<string, string> = {
      birthday: 'birthday', preferences: 'preferences',
      tags: 'tags', source: 'source', notes: 'notes', loyaltyTier: 'loyalty_tier'
    };
    const fields: string[] = []; const values: any[] = []; let p = 1;
    for (const [k, col] of Object.entries(map)) {
      if (data[k] !== undefined) {
        fields.push(`${col} = $${p++}`);
        values.push(typeof data[k] === 'object' && data[k] !== null && !Array.isArray(data[k])
          ? JSON.stringify(data[k]) : data[k]);
      }
    }
    if (!fields.length) return null;
    const whereConds = [`user_id = $${p++}`];
    values.push(userId);
    if (enterpriseId) {
      whereConds.push(`enterprise_id = $${p++}`);
      values.push(enterpriseId);
    }
    const result = await this.pool.query(
      `UPDATE customer_profiles SET ${fields.join(', ')} WHERE ${whereConds.join(' AND ')} RETURNING *`, values
    );
    return result.rows[0] || null;
  }

  // ========== LOYALTY PROGRAMS ==========

  async listLoyaltyPrograms(enterpriseId: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT * FROM loyalty_programs WHERE enterprise_id = $1 ORDER BY created_at DESC`, [enterpriseId]
    );
    return result.rows;
  }

  async createLoyaltyProgram(data: any): Promise<any> {
    const result = await this.pool.query(
      `INSERT INTO loyalty_programs
         (enterprise_id, name, program_type, points_per_currency, redemption_rate, tier_thresholds, rules, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        data.enterpriseId,
        data.name,
        data.programType,
        data.pointsPerCurrency || 1,
        data.redemptionRate || 0.01,
        data.tierThresholds ? JSON.stringify(data.tierThresholds) : '{}',
        data.rules ? JSON.stringify(data.rules) : '{}',
        data.isActive !== undefined ? data.isActive : true
      ]
    );
    return result.rows[0];
  }

  async updateLoyaltyProgram(id: string, data: any, enterpriseId?: string): Promise<any> {
    const map: Record<string, string> = {
      name: 'name', programType: 'program_type',
      pointsPerCurrency: 'points_per_currency', redemptionRate: 'redemption_rate',
      tierThresholds: 'tier_thresholds', rules: 'rules', isActive: 'is_active'
    };
    const fields: string[] = []; const values: any[] = []; let p = 1;
    for (const [k, col] of Object.entries(map)) {
      if (data[k] !== undefined) {
        fields.push(`${col} = $${p++}`);
        values.push(typeof data[k] === 'object' && data[k] !== null
          ? JSON.stringify(data[k]) : data[k]);
      }
    }
    if (!fields.length) return null;
    const whereConds = [`id = $${p++}`];
    values.push(id);
    if (enterpriseId) {
      whereConds.push(`enterprise_id = $${p++}`);
      values.push(enterpriseId);
    }
    const result = await this.pool.query(
      `UPDATE loyalty_programs SET ${fields.join(', ')} WHERE ${whereConds.join(' AND ')} RETURNING *`, values
    );
    return result.rows[0] || null;
  }

  // ========== PROMOTIONS ==========

  async listPromotions(filters: { enterpriseId?: string; isActive?: boolean; promoType?: string }): Promise<any[]> {
    const conds: string[] = []; const vals: any[] = []; let p = 1;
    if (filters.enterpriseId) { conds.push(`enterprise_id = $${p++}`); vals.push(filters.enterpriseId); }
    if (filters.promoType) { conds.push(`promo_type = $${p++}`); vals.push(filters.promoType); }
    if (filters.isActive !== undefined) { conds.push(`is_active = $${p++}`); vals.push(filters.isActive); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const result = await this.pool.query(
      `SELECT * FROM promotions ${where} ORDER BY created_at DESC`, vals
    );
    return result.rows;
  }

  async createPromotion(data: any): Promise<any> {
    const result = await this.pool.query(
      `INSERT INTO promotions
         (enterprise_id, name, promo_type, discount_value, conditions, promo_code,
          usage_limit, valid_from, valid_until, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        data.enterpriseId,
        data.name,
        data.promoType,
        data.discountValue,
        data.conditions ? JSON.stringify(data.conditions) : '{}',
        data.promoCode || null,
        data.usageLimit || null,
        data.validFrom || null,
        data.validUntil || null,
        data.isActive !== undefined ? data.isActive : true
      ]
    );
    return result.rows[0];
  }

  async updatePromotion(id: string, data: any, enterpriseId?: string): Promise<any> {
    const map: Record<string, string> = {
      name: 'name', promoType: 'promo_type', discountValue: 'discount_value',
      conditions: 'conditions', promoCode: 'promo_code', usageLimit: 'usage_limit',
      validFrom: 'valid_from', validUntil: 'valid_until', isActive: 'is_active'
    };
    const fields: string[] = []; const values: any[] = []; let p = 1;
    for (const [k, col] of Object.entries(map)) {
      if (data[k] !== undefined) {
        fields.push(`${col} = $${p++}`);
        values.push(typeof data[k] === 'object' && data[k] !== null
          ? JSON.stringify(data[k]) : data[k]);
      }
    }
    if (!fields.length) return null;
    const whereConds = [`id = $${p++}`];
    values.push(id);
    if (enterpriseId) {
      whereConds.push(`enterprise_id = $${p++}`);
      values.push(enterpriseId);
    }
    const result = await this.pool.query(
      `UPDATE promotions SET ${fields.join(', ')} WHERE ${whereConds.join(' AND ')} RETURNING *`, values
    );
    return result.rows[0] || null;
  }

  async validatePromoCode(code: string, enterpriseId?: string): Promise<any> {
    const conds = [`promo_code = $1`, `is_active = true`];
    const vals: any[] = [code];
    let p = 2;

    // Проверяем что промокод не просрочен и не исчерпал лимит использований
    conds.push(`(valid_from IS NULL OR valid_from <= NOW())`);
    conds.push(`(valid_until IS NULL OR valid_until >= NOW())`);
    conds.push(`(usage_limit IS NULL OR used_count < usage_limit)`);

    if (enterpriseId) { conds.push(`enterprise_id = $${p++}`); vals.push(enterpriseId); }

    const result = await this.pool.query(
      `SELECT * FROM promotions WHERE ${conds.join(' AND ')}`, vals
    );
    return result.rows[0] || null;
  }

  // ========== POINTS (LOYALTY TRANSACTIONS) ==========

  async earnPoints(customerId: string, orderId: string, amount: number): Promise<any> {
    // Получаем профиль и активную программу лояльности
    const profileResult = await this.pool.query(
      `SELECT cp.*, lp.points_per_currency, lp.tier_thresholds
       FROM customer_profiles cp
       LEFT JOIN loyalty_programs lp
         ON lp.enterprise_id = cp.enterprise_id AND lp.is_active = true AND lp.program_type = 'points'
       WHERE cp.id = $1`, [customerId]
    );
    const profile = profileResult.rows[0];
    if (!profile) throw new Error('Customer profile not found');

    // Рассчитываем начисляемые баллы
    const pointsPerCurrency = parseFloat(profile.points_per_currency) || 1;
    const points = Math.floor(amount * pointsPerCurrency);

    // Записываем транзакцию
    const txResult = await this.pool.query(
      `INSERT INTO loyalty_transactions
         (customer_profile_id, enterprise_id, order_id, transaction_type, points, description)
       VALUES ($1, $2, $3, 'earn', $4, $5) RETURNING *`,
      [customerId, profile.enterprise_id, orderId, points, `Начисление за заказ на сумму ${amount}`]
    );

    // Обновляем баланс баллов и статистику покупок
    await this.pool.query(
      `UPDATE customer_profiles
       SET loyalty_points = loyalty_points + $1,
           total_orders = total_orders + 1,
           total_spent = total_spent + $2,
           average_order_value = (total_spent + $2) / (total_orders + 1),
           last_order_date = NOW()
       WHERE id = $3`,
      [points, amount, customerId]
    );

    // Пересчитываем уровень лояльности
    await this._recalculateTier(customerId, profile.tier_thresholds);

    return txResult.rows[0];
  }

  async redeemPoints(customerId: string, points: number): Promise<any> {
    if (points <= 0) throw new Error('Points to redeem must be positive');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const updateResult = await client.query(
        `UPDATE customer_profiles
         SET loyalty_points = loyalty_points - $1
         WHERE id = $2 AND loyalty_points >= $1
         RETURNING enterprise_id, loyalty_points`,
        [points, customerId]
      );

      if (updateResult.rowCount === 0) {
        const exists = await client.query(
          `SELECT 1 FROM customer_profiles WHERE id = $1`, [customerId]
        );
        await client.query('ROLLBACK');
        if (exists.rowCount === 0) throw new Error('Customer profile not found');
        throw new Error('Insufficient loyalty points');
      }

      const enterpriseId = updateResult.rows[0].enterprise_id;
      const txResult = await client.query(
        `INSERT INTO loyalty_transactions
           (customer_profile_id, enterprise_id, transaction_type, points, description)
         VALUES ($1, $2, 'redeem', $3, $4) RETURNING *`,
        [customerId, enterpriseId, -points, `Списание ${points} баллов`]
      );

      await client.query('COMMIT');
      return txResult.rows[0];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Атомарно применить промокод: инкрементирует used_count только если
   * лимит ещё не исчерпан. Возвращает обновлённую запись промо или null.
   */
  async redeemPromoCode(code: string, enterpriseId?: string): Promise<any> {
    const conds: string[] = [
      `promo_code = $1`,
      `is_active = true`,
      `(valid_from IS NULL OR valid_from <= NOW())`,
      `(valid_until IS NULL OR valid_until >= NOW())`,
      `(usage_limit IS NULL OR used_count < usage_limit)`
    ];
    const vals: any[] = [code];
    let p = 2;
    if (enterpriseId) { conds.push(`enterprise_id = $${p++}`); vals.push(enterpriseId); }

    const result = await this.pool.query(
      `UPDATE promotions
       SET used_count = used_count + 1
       WHERE ${conds.join(' AND ')}
       RETURNING *`,
      vals
    );
    return result.rows[0] || null;
  }

  async getTransactions(customerId: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT * FROM loyalty_transactions
       WHERE customer_profile_id = $1
       ORDER BY created_at DESC
       LIMIT 100`, [customerId]
    );
    return result.rows;
  }

  // ========== ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ==========

  // Пересчёт уровня лояльности на основе пороговых значений программы
  private async _recalculateTier(customerId: string, tierThresholds: any): Promise<void> {
    if (!tierThresholds) return;

    const profileResult = await this.pool.query(
      `SELECT total_spent FROM customer_profiles WHERE id = $1`, [customerId]
    );
    const totalSpent = parseFloat(profileResult.rows[0]?.total_spent) || 0;

    // Ожидаемый формат: { silver: 10000, gold: 50000, platinum: 150000 }
    let tier = 'bronze';
    const thresholds = typeof tierThresholds === 'string'
      ? JSON.parse(tierThresholds) : tierThresholds;

    if (thresholds.platinum && totalSpent >= thresholds.platinum) tier = 'platinum';
    else if (thresholds.gold && totalSpent >= thresholds.gold) tier = 'gold';
    else if (thresholds.silver && totalSpent >= thresholds.silver) tier = 'silver';

    await this.pool.query(
      `UPDATE customer_profiles SET loyalty_tier = $1 WHERE id = $2`, [tier, customerId]
    );
  }

  async close(): Promise<void> { await this.pool.end(); }
}

export default CRMService;
