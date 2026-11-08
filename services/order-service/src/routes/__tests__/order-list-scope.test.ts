import { resolveOrderListScope } from '../order-list-scope';

const ENT = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

describe('чьи заказы отдаёт GET /api/orders', () => {
  it('владелец видит все заказы своего предприятия, а не только «свои как клиента»', () => {
    // Регресс: раньше customerId = userId, и у владельца Кофейни 104 список был пуст
    const s = resolveOrderListScope({ userId: ME, userRole: 'restaurant_owner', enterpriseRole: 'owner', enterpriseId: ENT });
    expect(s).toEqual({ ok: true, enterpriseId: ENT, customerId: undefined });
  });

  it('кассир (role=customer, enterpriseRole=cashier) — сотрудник, видит заказы предприятия', () => {
    const s = resolveOrderListScope({ userId: ME, userRole: 'customer', enterpriseRole: 'cashier', enterpriseId: ENT });
    expect(s).toEqual({ ok: true, enterpriseId: ENT, customerId: undefined });
  });

  it('сотрудник может отфильтровать по клиенту явно', () => {
    const s = resolveOrderListScope({ userId: ME, userRole: 'admin', enterpriseRole: 'admin', enterpriseId: ENT, queryCustomerId: OTHER });
    expect(s).toEqual({ ok: true, enterpriseId: ENT, customerId: OTHER });
  });

  it('клиент видит только свои заказы, чужой customerId из запроса игнорируется', () => {
    const s = resolveOrderListScope({ userId: ME, userRole: 'customer', queryCustomerId: OTHER });
    expect(s).toEqual({ ok: true, enterpriseId: undefined, customerId: ME });
  });

  it('сотрудник без предприятия получает 403, а не заказы всех организаций', () => {
    const s = resolveOrderListScope({ userId: ME, userRole: 'admin', enterpriseRole: 'admin' });
    expect(s.ok).toBe(false);
  });

  it('super_admin без предприятия видит всё', () => {
    const s = resolveOrderListScope({ userId: ME, userRole: 'super_admin' });
    expect(s).toEqual({ ok: true, enterpriseId: undefined, customerId: undefined });
  });

  it('предприятие сотрудника всегда в фильтре', () => {
    for (const role of ['owner', 'admin', 'manager', 'cashier', 'waiter']) {
      const s = resolveOrderListScope({ userId: ME, userRole: 'customer', enterpriseRole: role, enterpriseId: ENT });
      expect(s.ok && s.enterpriseId).toBe(ENT);
    }
  });
});
