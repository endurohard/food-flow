import pkg from 'pg';
const { Pool } = pkg;
import type { PoolClient } from 'pg';
import { logger } from '../utils/logger';

export interface DiscountRow {
  id: string;
  enterprise_id: string | null;
  restaurant_id: string | null;
  name: string;
  discount_type: 'percentage' | 'fixed_amount' | 'bogo' | 'combo';
  value: string; // DECIMAL comes back as string from pg
  min_order_amount: string;
  max_discount: string | null;
  applicable_to: 'order' | 'item' | 'category';
  target_id: string | null;
  is_active: boolean;
  valid_from: string | null;
  valid_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface AppliedDiscount {
  discountId: string;
  name: string;
  discountType: string;
  value: number;
  applicableTo: string;
  targetId: string | null;
  amount: number; // actual discount amount applied
}

/** Скидка по уровню карты клиента (миграция 065): процент — целое 0..100. */
export interface LoyaltyDiscount {
  tier: string;
  percent: number;
}

export const TIER_NAMES: Record<string, string> = {
  bronze: 'Бронза', silver: 'Серебро', gold: 'Золото', platinum: 'Платина'
};

/**
 * Процент скидки уровня из tier_discounts программы. Только целые 0..100:
 * касса Sigma считает ту же скидку оффлайн в копейках, и итог обязан
 * совпасть до копейки — мусор в настройке даёт 0, а не странную сумму.
 */
export function tierDiscountPercent(tierDiscounts: any, tier: string | null | undefined): number {
  let map = tierDiscounts;
  if (typeof map === 'string') { try { map = JSON.parse(map); } catch { map = {}; } }
  const v = Number((map || {})[(tier || '').toLowerCase()]);
  return Number.isInteger(v) && v > 0 && v <= 100 ? v : 0;
}

/**
 * Скидка по карте в рублях: по сумме позиций, на которые скидки действуют,
 * в копейках с округлением половины вверх — та же формула, что в Sigma:
 * (eligibleKop * percent + 50) / 100.
 */
export function loyaltyDiscountAmount(eligibleSubtotal: number, percent: number): number {
  const kop = Math.round(eligibleSubtotal * 100);
  return Math.floor((kop * percent + 50) / 100) / 100;
}

export interface DiscountCalculation {
  totalDiscount: number;
  appliedDiscounts: AppliedDiscount[];
}

export interface CreateDiscountInput {
  enterpriseId?: string;
  restaurantId?: string;
  name: string;
  discountType: 'percentage' | 'fixed_amount' | 'bogo' | 'combo';
  value: number;
  minOrderAmount?: number;
  maxDiscount?: number;
  applicableTo?: 'order' | 'item' | 'category';
  targetId?: string;
  validFrom?: string;
  validUntil?: string;
}

export class DiscountService {
  private pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  /**
   * List active discounts for a restaurant, including enterprise-wide discounts.
   */
  async listDiscounts(restaurantId: string, enterpriseId?: string): Promise<DiscountRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM discounts
       WHERE (restaurant_id = $1 OR restaurant_id IS NULL)
         AND ($2::uuid IS NULL OR enterprise_id = $2 OR enterprise_id IS NULL)
         AND is_active = true
         AND (valid_from IS NULL OR valid_from <= NOW())
         AND (valid_until IS NULL OR valid_until >= NOW())
       ORDER BY created_at DESC`,
      [restaurantId, enterpriseId || null]
    );
    return result.rows;
  }

  /**
   * Create a new discount rule.
   */
  async createDiscount(data: CreateDiscountInput): Promise<DiscountRow> {
    const result = await this.pool.query(
      `INSERT INTO discounts (
        enterprise_id, restaurant_id, name, discount_type, value,
        min_order_amount, max_discount, applicable_to, target_id,
        valid_from, valid_until
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [
        data.enterpriseId || null,
        data.restaurantId || null,
        data.name,
        data.discountType,
        data.value,
        data.minOrderAmount ?? 0,
        data.maxDiscount ?? null,
        data.applicableTo || 'order',
        data.targetId || null,
        data.validFrom || null,
        data.validUntil || null
      ]
    );
    return result.rows[0];
  }

  /**
   * Update an existing discount.
   */
  async updateDiscount(id: string, data: Partial<CreateDiscountInput>, enterpriseId?: string): Promise<DiscountRow | null> {
    // Build SET clause dynamically from provided fields
    const fields: string[] = [];
    const values: any[] = [];
    let p = 1;

    const fieldMap: Record<string, string> = {
      name: 'name',
      discountType: 'discount_type',
      value: 'value',
      minOrderAmount: 'min_order_amount',
      maxDiscount: 'max_discount',
      applicableTo: 'applicable_to',
      targetId: 'target_id',
      validFrom: 'valid_from',
      validUntil: 'valid_until',
      restaurantId: 'restaurant_id'
    };

    for (const [key, col] of Object.entries(fieldMap)) {
      if ((data as any)[key] !== undefined) {
        fields.push(`${col} = $${p++}`);
        values.push((data as any)[key]);
      }
    }

    if (fields.length === 0) return null;

    fields.push('updated_at = NOW()');

    const conditions = [`id = $${p++}`];
    values.push(id);

    if (enterpriseId) {
      conditions.push(`enterprise_id = $${p++}`);
      values.push(enterpriseId);
    }

    const result = await this.pool.query(
      `UPDATE discounts SET ${fields.join(', ')} WHERE ${conditions.join(' AND ')} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  /**
   * Soft-delete a discount by setting is_active = false.
   */
  async deactivateDiscount(id: string, enterpriseId?: string): Promise<boolean> {
    const conditions = ['id = $1'];
    const values: any[] = [id];
    if (enterpriseId) {
      conditions.push('enterprise_id = $2');
      values.push(enterpriseId);
    }

    const result = await this.pool.query(
      `UPDATE discounts SET is_active = false, updated_at = NOW()
       WHERE ${conditions.join(' AND ')} AND is_active = true
       RETURNING id`,
      values
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Calculate applicable discounts for an order using an existing transaction client.
   * This allows the calculation to participate in the order creation transaction.
   */
  static async calculateDiscountsInTx(
    client: PoolClient,
    restaurantId: string,
    subtotal: number,
    items: Array<{ menuItemId: string; categoryId?: string; subtotal: number; loyaltyAllowed?: boolean; promoAllowed?: boolean }>,
    enterpriseId?: string,
    loyalty?: LoyaltyDiscount | null
  ): Promise<DiscountCalculation> {
    // Разрешения у блюда (миграция 066): скидка по карте и акции — отдельно.
    // Не указано — разрешено. Порог min_order_amount — по всему чеку.
    const sum = (list: typeof items) => Math.round(list.reduce((s, i) => s + i.subtotal, 0) * 100) / 100;
    const eligibleItems = items.filter(i => i.promoAllowed !== false);
    const eligibleSubtotal = sum(eligibleItems);
    const loyaltySubtotal = sum(items.filter(i => i.loyaltyAllowed !== false));
    const anyDiscountSubtotal = sum(items.filter(i => i.promoAllowed !== false || i.loyaltyAllowed !== false));
    // 1. Fetch active discounts for the restaurant
    const discountResult = await client.query(
      `SELECT * FROM discounts
       WHERE (restaurant_id = $1 OR restaurant_id IS NULL)
         AND ($2::uuid IS NULL OR enterprise_id = $2 OR enterprise_id IS NULL)
         AND is_active = true
         AND (valid_from IS NULL OR valid_from <= NOW())
         AND (valid_until IS NULL OR valid_until >= NOW())`,
      [restaurantId, enterpriseId || null]
    );

    const discounts: DiscountRow[] = discountResult.rows;
    const appliedDiscounts: AppliedDiscount[] = [];
    let totalDiscount = 0;

    for (const disc of discounts) {
      const minOrder = parseFloat(disc.min_order_amount || '0');
      const value = parseFloat(disc.value);
      const maxDisc = disc.max_discount ? parseFloat(disc.max_discount) : null;

      let discountAmount = 0;

      if (disc.applicable_to === 'order') {
        // Check min_order_amount against subtotal
        if (subtotal < minOrder) continue;

        if (disc.discount_type === 'percentage') {
          discountAmount = eligibleSubtotal * value / 100;
        } else if (disc.discount_type === 'fixed_amount') {
          discountAmount = Math.min(value, eligibleSubtotal);
        }
        // bogo and combo are handled at item level, skip for order-level
        if (disc.discount_type === 'bogo' || disc.discount_type === 'combo') continue;

      } else if (disc.applicable_to === 'item') {
        // Apply to specific menu item
        const matchingItems = eligibleItems.filter(i => i.menuItemId === disc.target_id);
        if (matchingItems.length === 0) continue;

        const itemTotal = matchingItems.reduce((sum, i) => sum + i.subtotal, 0);
        if (disc.discount_type === 'percentage') {
          discountAmount = itemTotal * value / 100;
        } else if (disc.discount_type === 'fixed_amount') {
          discountAmount = Math.min(value, itemTotal);
        } else if (disc.discount_type === 'bogo') {
          // Buy one get one: discount the cheapest matching item
          const cheapest = Math.min(...matchingItems.map(i => i.subtotal / 1)); // simplified
          discountAmount = matchingItems.length >= 2 ? cheapest : 0;
        }

      } else if (disc.applicable_to === 'category') {
        // Apply to items in a specific category
        const matchingItems = eligibleItems.filter(i => i.categoryId === disc.target_id);
        if (matchingItems.length === 0) continue;

        const catTotal = matchingItems.reduce((sum, i) => sum + i.subtotal, 0);
        if (disc.discount_type === 'percentage') {
          discountAmount = catTotal * value / 100;
        } else if (disc.discount_type === 'fixed_amount') {
          discountAmount = Math.min(value, catTotal);
        }
      }

      // Cap at max_discount if set
      if (maxDisc !== null && discountAmount > maxDisc) {
        discountAmount = maxDisc;
      }

      // Discount cannot exceed the subtotal
      if (discountAmount <= 0) continue;

      discountAmount = Math.round(discountAmount * 100) / 100;

      appliedDiscounts.push({
        discountId: disc.id,
        name: disc.name,
        discountType: disc.discount_type,
        value,
        applicableTo: disc.applicable_to,
        targetId: disc.target_id,
        amount: discountAmount
      });

      totalDiscount += discountAmount;
    }

    // Акции — не больше суммы позиций, где они разрешены
    if (totalDiscount > eligibleSubtotal) totalDiscount = eligibleSubtotal;

    // Скидка по уровню карты — от суммы позиций, где она разрешена
    if (loyalty && loyalty.percent > 0 && loyaltySubtotal > 0) {
      const amount = loyaltyDiscountAmount(loyaltySubtotal, loyalty.percent);
      if (amount > 0) {
        appliedDiscounts.push({
          discountId: 'loyalty',
          name: `Скидка по карте: ${TIER_NAMES[loyalty.tier] || loyalty.tier} ${loyalty.percent}%`,
          discountType: 'loyalty',
          value: loyalty.percent,
          applicableTo: 'order',
          targetId: null,
          amount
        });
        totalDiscount += amount;
      }
    }

    // Скидки не больше суммы позиций, на которые хоть какая-то действует:
    // позиции без обоих разрешений оплачиваются полностью
    if (totalDiscount > anyDiscountSubtotal) {
      totalDiscount = anyDiscountSubtotal;
    }

    totalDiscount = Math.round(totalDiscount * 100) / 100;

    return { totalDiscount, appliedDiscounts };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default DiscountService;
