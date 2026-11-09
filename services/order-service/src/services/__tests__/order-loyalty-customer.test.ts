import { OrderService, OrderError } from '../order.service';

const ENT = '11111111-1111-4111-8111-111111111111';
const PROFILE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function makeSvc(profiles: Record<string, { ent: string; user: string }>) {
  const svc = new OrderService('postgres://unused', {} as any);
  const calls: any[] = [];
  (svc as any).pool = {
    query: async (sql: string, params: any[]) => {
      calls.push({ sql, params });
      const p = profiles[params[0]];
      // Мок уважает условие тенанта в SQL: без него нашёлся бы чужой профиль
      const ok = p && (!/enterprise_id = \$2/.test(sql) || p.ent === params[1]);
      return ok ? { rows: [{ user_id: p.user }] } : { rows: [] };
    }
  };
  return { svc, calls };
}

describe('клиент лояльности в заказе кассы (POST /api/orders)', () => {
  it('профиль своего предприятия → users.id клиента', async () => {
    const { svc } = makeSvc({ [PROFILE]: { ent: ENT, user: USER } });
    await expect(svc.resolveLoyaltyCustomer(PROFILE, ENT)).resolves.toBe(USER);
  });

  it('профиль чужого предприятия — 400', async () => {
    const { svc } = makeSvc({ [PROFILE]: { ent: 'other', user: USER } });
    await expect(svc.resolveLoyaltyCustomer(PROFILE, ENT)).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.resolveLoyaltyCustomer(PROFILE, ENT)).rejects.toBeInstanceOf(OrderError);
  });
});
