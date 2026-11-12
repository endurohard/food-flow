/**
 * Скидка по уровню карты (миграция 065) и позиции «без скидки».
 * Формула обязана совпадать с Sigma до копейки: касса считает её оффлайн
 * и берёт с гостя ровно эту сумму.
 */
import { DiscountService, loyaltyDiscountAmount, tierDiscountPercent } from '../discount.service';
import { OrderService } from '../order.service';

const noPromos = (rows: any[] = []) => ({ query: jest.fn(async () => ({ rows })) }) as any;
const it_ = (subtotal: number, noDiscount = false, menuItemId = 'm', categoryId?: string) => ({ menuItemId, categoryId, subtotal, noDiscount });

describe('формула', () => {
  it('копейки, половина вверх: (kop * % + 50) / 100', () => {
    expect(loyaltyDiscountAmount(340, 10)).toBe(34);
    expect(loyaltyDiscountAmount(123.45, 3)).toBe(3.7);    // 370.35 коп → 370
    expect(loyaltyDiscountAmount(116.5, 3)).toBe(3.5);     // 349.5 коп → 350
    expect(loyaltyDiscountAmount(0.1 + 0.2, 50)).toBe(0.15);
  });
  it('процент уровня — только целые 0..100, иначе 0', () => {
    const map = { bronze: 3, silver: '5', gold: 10.5, platinum: 150 };
    expect(tierDiscountPercent(map, 'bronze')).toBe(3);
    expect(tierDiscountPercent(map, 'SILVER')).toBe(5);
    expect(tierDiscountPercent(map, 'gold')).toBe(0);
    expect(tierDiscountPercent(map, 'platinum')).toBe(0);
    expect(tierDiscountPercent('{"gold":10}', 'gold')).toBe(10);
    expect(tierDiscountPercent('мусор', 'gold')).toBe(0);
    expect(tierDiscountPercent(null, null)).toBe(0);
  });
});

describe('calculateDiscountsInTx', () => {
  it('скидка по карте — только с позиций со скидкой, доплата за сорт внутри строки', async () => {
    // эспрессо на Эфиопии 170 (120 + 50) и позиция без скидки 300
    const r = await DiscountService.calculateDiscountsInTx(noPromos(), 'r', 470, [it_(170), it_(300, true)], 'e', { tier: 'gold', percent: 10 });
    expect(r.totalDiscount).toBe(17);
    expect(r.appliedDiscounts).toEqual([expect.objectContaining({ discountType: 'loyalty', name: 'Скидка по карте: Золото 10%', amount: 17, value: 10 })]);
  });
  it('без клиента — скидки по карте нет', async () => {
    const r = await DiscountService.calculateDiscountsInTx(noPromos(), 'r', 170, [it_(170)], 'e', null);
    expect(r.totalDiscount).toBe(0);
  });
  it('акция «процент на чек» тоже не трогает позиции без скидки', async () => {
    const promo = { id: 'p', name: 'Акция', discount_type: 'percentage', value: '20', min_order_amount: '0', max_discount: null, applicable_to: 'order', target_id: null };
    const r = await DiscountService.calculateDiscountsInTx(noPromos([promo]), 'r', 400, [it_(100), it_(300, true)], 'e');
    expect(r.totalDiscount).toBe(20);
  });
  it('фикс-сумма и категория — не больше позиций со скидкой; итог скидок не съедает позиции без скидки', async () => {
    const fixed = { id: 'f', name: 'Минус 500', discount_type: 'fixed_amount', value: '500', min_order_amount: '0', max_discount: null, applicable_to: 'order', target_id: null };
    const cat = { id: 'c', name: 'Кофе −50%', discount_type: 'percentage', value: '50', min_order_amount: '0', max_discount: null, applicable_to: 'category', target_id: 'coffee' };
    const r = await DiscountService.calculateDiscountsInTx(noPromos([fixed, cat]), 'r', 400,
      [it_(100, false, 'a', 'coffee'), it_(300, true, 'b', 'coffee')], 'e', { tier: 'gold', percent: 10 });
    expect(r.appliedDiscounts.find(d => d.discountId === 'c')!.amount).toBe(50);
    expect(r.appliedDiscounts.find(d => d.discountId === 'f')!.amount).toBe(100);
    expect(r.totalDiscount).toBe(100);
  });
});

describe('OrderService.resolveLoyaltyDiscount', () => {
  const svc = (row: any) => {
    const s = new OrderService('postgres://unused', {} as any);
    const calls: any[] = [];
    (s as any).pool = { query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows: row ? [row] : [] }; } };
    return { s, calls };
  };
  it('уровень клиента → процент программы его организации', async () => {
    const { s, calls } = svc({ loyalty_tier: 'Gold', tier_discounts: { gold: 10 } });
    await expect(s.resolveLoyaltyDiscount('p', 'e')).resolves.toEqual({ tier: 'gold', percent: 10 });
    expect(calls[0].sql).toMatch(/cp\.id = \$1 AND cp\.enterprise_id = \$2/);
    expect(calls[0].sql).toMatch(/lp\.enterprise_id = cp\.enterprise_id AND lp\.is_active = true/);
    expect(calls[0].params).toEqual(['p', 'e']);
  });
  it('нет процента или клиента — null', async () => {
    await expect(svc({ loyalty_tier: 'bronze', tier_discounts: {} }).s.resolveLoyaltyDiscount('p', 'e')).resolves.toBeNull();
    await expect(svc(null).s.resolveLoyaltyDiscount('p', 'e')).resolves.toBeNull();
  });
});
