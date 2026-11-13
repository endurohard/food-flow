/**
 * Карта клиента (миграция 066): открытая страница по секрету ссылки,
 * ссылка для кассира, поиск по номеру карты.
 */
import { CRMService, cardBaseUrl, nextTier } from '../crm.service';

const TOKEN = 'a'.repeat(64);
function makeSvc(handler: (sql: string, params: any[]) => any) {
  const calls: { sql: string; params: any[] }[] = [];
  const svc = new CRMService('postgres://unused');
  (svc as any).pool = { query: async (sql: string, params: any[] = []) => { calls.push({ sql, params }); return handler(sql, params); } };
  return { svc, calls };
}

describe('открытая карта по ссылке', () => {
  const profile = { id: 'p1', enterprise_id: 'e1', card_number: '10000001', loyalty_points: 120, loyalty_tier: 'Gold', total_spent: '12500.50',
    first_name: 'Анна', last_name: 'Секретова', phone: '+79991234567', email: 'a@x.ru', enterprise_name: 'Кофейня 104',
    program: { tier_discounts: { gold: 10 }, tier_thresholds: { silver: 5000, gold: 10000, platinum: 20000 } } };
  const handler = (sql: string) => /FROM customer_profiles cp/.test(sql) ? { rows: [profile] }
    : { rows: [{ created_at: '2026-11-12T10:00:00Z', transaction_type: 'earn', points: 15, description: 'Заказ ORD-1' }] };

  it('отдаёт карту без телефона, фамилии, e-mail и id', async () => {
    const { svc } = makeSvc(handler);
    const card = await svc.getCardByToken(TOKEN);
    expect(card).toMatchObject({ number: '10000001', customerName: 'Анна', enterpriseName: 'Кофейня 104', points: 120, tier: 'gold',
      tierName: 'Золото', discountPercent: 10, totalSpent: 12500.5,
      nextTier: { tier: 'platinum', name: 'Платина', threshold: 20000, remaining: 7499.5 } });
    expect(card.recent).toEqual([{ date: '2026-11-12T10:00:00Z', type: 'earn', points: 15, description: 'Заказ ORD-1' }]);
    expect(JSON.stringify(card)).not.toMatch(/Секретова|7999|a@x|p1|e1/);
  });
  it('ищет строго по токену, история — своего профиля и организации', async () => {
    const { svc, calls } = makeSvc(handler);
    await svc.getCardByToken(TOKEN);
    expect(calls[0].sql).toMatch(/WHERE cp\.card_token = \$1/);
    expect(calls[0].params).toEqual([TOKEN]);
    expect(calls[1].sql).toMatch(/customer_profile_id = \$1 AND enterprise_id = \$2/);
    expect(calls[1].params).toEqual(['p1', 'e1']);
  });
  it('кривой токен — в базу не ходит, null', async () => {
    for (const bad of ['', 'abc', 'A'.repeat(64), 'a'.repeat(63), "' OR 1=1 --".padEnd(64, 'a'), '10000001']) {
      const { svc, calls } = makeSvc(handler);
      await expect(svc.getCardByToken(bad)).resolves.toBeNull();
      expect(calls).toHaveLength(0);
    }
  });
  it('неизвестный токен — null', async () => {
    const { svc } = makeSvc(() => ({ rows: [] }));
    await expect(svc.getCardByToken(TOKEN)).resolves.toBeNull();
  });
});

describe('ссылка для кассира', () => {
  it('профиль только своей организации; rotate меняет секрет, без rotate — прежний', async () => {
    const { svc, calls } = makeSvc(() => ({ rows: [{ card_token: TOKEN }] }));
    await svc.getCardLink('p1', 'e1');
    await svc.getCardLink('p1', 'e1', true);
    expect(calls[0].sql).toMatch(/WHERE cp\.id = \$1 AND cp\.enterprise_id = \$2/);
    expect(calls[0].sql).toMatch(/CASE WHEN \$3 THEN replace\(gen_random_uuid\(\)::text \|\| gen_random_uuid\(\)::text, '-', ''\)\s+ELSE cp\.card_token END/);
    expect(calls[0].params).toEqual(['p1', 'e1', false]);
    expect(calls[1].params).toEqual(['p1', 'e1', true]);
  });
});

describe('поиск клиента кассиром по номеру карты', () => {
  it('точное совпадение номера карты в условии и номер в выдаче', async () => {
    const { svc, calls } = makeSvc(() => ({ rows: [{ id: 'p1', first_name: 'А', loyalty_points: 0, loyalty_tier: 'bronze', card_number: '10000001' }] }));
    const [c] = await svc.lookupCustomers('e1', '10000001');
    expect(c.cardNumber).toBe('10000001');
    expect(calls[0].sql).toMatch(/OR cp\.card_number = \$(\d+)/);
    const n = Number(/cp\.card_number = \$(\d+)/.exec(calls[0].sql)![1]);
    expect(calls[0].params[n - 1]).toBe('10000001');
  });
});

describe('адрес страницы карты', () => {
  it('поддомен кассира, https', () => {
    expect(cardBaseUrl({ 'x-forwarded-host': 'kofe104.food-flow.ru' })).toBe('https://kofe104.food-flow.ru');
    expect(cardBaseUrl({ host: 'Kofe104.Food-Flow.ru' })).toBe('https://kofe104.food-flow.ru');
  });
  it('внутренний или мусорный адрес — общий домен', () => {
    for (const h of ['localhost', 'localhost:3010', '192.168.2.248', '10.0.0.5:80', '176.98.155.78', '', 'evil.com/"><script>']) {
      expect(cardBaseUrl({ host: h })).toBe('https://food-flow.ru');
    }
  });
});

describe('следующий уровень', () => {
  it('ближайший уровень выше с заданным порогом', () => {
    expect(nextTier('bronze', { gold: 10000 }, 3000)).toEqual({ tier: 'gold', name: 'Золото', threshold: 10000, remaining: 7000 });
    expect(nextTier('platinum', { gold: 1 }, 0)).toBeNull();
    expect(nextTier('silver', '{"gold":100}', 150)).toEqual({ tier: 'gold', name: 'Золото', threshold: 100, remaining: 0 });
    expect(nextTier('bronze', {}, 0)).toBeNull();
  });
});
