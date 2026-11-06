import { createCashRegisterSessionMiddleware } from '../cash-register.middleware';

/**
 * Мок БД отдаёт сессию только на запрос, который сам проверяет срок жизни
 * (`expires_at > NOW()`): если условие пропадёт из SQL, alive станет undefined
 * и тест «живая сессия проходит» упадёт.
 */
function makePool(session: any | null) {
  const calls: { sql: string; params: any[] }[] = [];
  return {
    calls,
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (!/FROM cash_register_sessions/.test(sql)) throw new Error('unexpected SQL: ' + sql);
      if (!session || params[0] !== session.id) return { rows: [] };
      const row: any = { user_id: session.user_id, register_id: session.register_id, status: session.status };
      if (/expires_at > NOW\(\) AS alive/.test(sql)) row.alive = session.alive;
      return { rows: [row] };
    },
  };
}

function run(pool: any, req: any) {
  return new Promise<{ status?: number; body?: any; next: boolean }>((resolve) => {
    const res: any = {
      status(code: number) { this.code = code; return this; },
      json(body: any) { resolve({ status: this.code, body, next: false }); return this; },
    };
    createCashRegisterSessionMiddleware(pool)(req, res, (err?: any) => {
      if (err) throw err;
      resolve({ next: true });
    });
  });
}

const USER = '11111111-1111-4111-8111-111111111111';
const REG = '22222222-2222-4222-8222-222222222222';
const SID = '33333333-3333-4333-8333-333333333333';
const alive = { id: SID, user_id: USER, register_id: REG, status: 'active', alive: true };

const req = (over: any = {}) => ({
  headers: { 'x-register-session': SID },
  userId: USER,
  body: { registerId: REG, paymentMethod: 'cash' },
  ...over,
});

describe('сессия режима кассы на /api/pos/sales', () => {
  it('живая активная сессия своего кассира пропускает продажу', async () => {
    const pool = makePool(alive);
    expect((await run(pool, req())).next).toBe(true);
    expect(pool.calls[0].params).toEqual([SID]);
  });

  it('без заголовка — 403', async () => {
    const r = await run(makePool(alive), req({ headers: {} }));
    expect(r.status).toBe(403);
  });

  it('несуществующая сессия — 403', async () => {
    const r = await run(makePool(null), req());
    expect(r.status).toBe(403);
  });

  it('чужая сессия (другой пользователь в JWT) — 403', async () => {
    const r = await run(makePool(alive), req({ userId: '44444444-4444-4444-8444-444444444444' }));
    expect(r.status).toBe(403);
  });

  it('истёкшая сессия — 403', async () => {
    const r = await run(makePool({ ...alive, alive: false }), req());
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/истекла/);
  });

  it('заблокированная касса — 403 с просьбой ввести PIN', async () => {
    const r = await run(makePool({ ...alive, status: 'locked' }), req());
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/PIN/);
  });

  it('деньги в другую кассу — 403', async () => {
    const r = await run(
      makePool(alive),
      req({ body: { registerId: '55555555-5555-4555-8555-555555555555', paymentMethod: 'cash' } })
    );
    expect(r.status).toBe(403);
  });

  it('оплата картой без кассы пропускается', async () => {
    const r = await run(makePool(alive), req({ body: { paymentMethod: 'card' } }));
    expect(r.next).toBe(true);
  });
});
