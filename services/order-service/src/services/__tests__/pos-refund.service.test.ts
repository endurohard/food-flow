import jwt from 'jsonwebtoken';
import { PosRefundService, PosRefundError } from '../pos-refund.service';

const SECRET = 'test-secret';
const ENT = 'ent-1';

/** Клиент с журналом; ответы подбираются по SQL. */
function makeDb(opts: {
  order?: any; lines?: any[]; register?: any; replay?: any;
}) {
  const queries: { sql: string; params: any[] }[] = [];
  const client: any = {
    queries,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      if (/FROM pos_refunds WHERE enterprise_id/.test(sql)) return { rows: opts.replay ? [opts.replay] : [] };
      if (/FROM orders o\s+WHERE o.id/.test(sql)) return { rows: opts.order ? [opts.order] : [] };
      if (/FROM order_items WHERE order_id/.test(sql)) return { rows: opts.lines || [] };
      if (/FROM cash_registers/.test(sql)) return { rows: opts.register ? [opts.register] : [] };
      if (/INSERT INTO cash_operations/.test(sql)) return { rows: [{ id: 'co-1' }] };
      return { rows: [], rowCount: 1 };
    }),
    release: jest.fn(),
  };
  return { pool: { connect: async () => client, query: client.query }, client, queries };
}

const approval = { approverId: 'adm', enterpriseId: ENT, registerId: 'reg-1', sessionId: 'sess-1', cashierId: 'cas', action: 'refund' as const };
const ORDER = { id: 'o1', order_number: 'POS-1', restaurant_id: 'r1', subtotal: '400', total: '360', refunded_amount: '0', payment_method: 'cash', status: 'completed' };
const LINES = [
  { id: 'l1', quantity: 2, refunded_quantity: 0, subtotal: '200' },   // 2 × 100
  { id: 'l2', quantity: 1, refunded_quantity: 0, subtotal: '200' },
];
const ops = (q: any[], re: RegExp) => q.filter((x) => re.test(x.sql));

describe('verifyApproval', () => {
  const svc = new PosRefundService({}, SECRET);
  const good = () => jwt.sign({ typ: 'pos_approval', ...approval }, SECRET, { expiresIn: '5m' });
  const exp = { enterpriseId: ENT, cashierId: 'cas', sessionId: 'sess-1', action: 'refund' };

  it('принимает допуск, выданный на эту смену и это действие', () => {
    expect(svc.verifyApproval(good(), exp).approverId).toBe('adm');
  });
  it('допуск на смену оплаты не годится для возврата', () => {
    expect(() => svc.verifyApproval(good(), { ...exp, action: 'payment_change' })).toThrow(PosRefundError);
  });
  it('допуск с другой смены кассы не принимается', () => {
    expect(() => svc.verifyApproval(good(), { ...exp, sessionId: 'other' })).toThrow(/другое действие или другую кассу/);
  });
  it('другой кассир не воспользуется чужим допуском', () => {
    expect(() => svc.verifyApproval(good(), { ...exp, cashierId: 'x' })).toThrow(PosRefundError);
  });
  it('подделанная подпись и истёкший допуск — отказ', () => {
    expect(() => svc.verifyApproval(jwt.sign({ typ: 'pos_approval', ...approval }, 'wrong'), exp)).toThrow(/истекло/);
    expect(() => svc.verifyApproval(jwt.sign({ typ: 'pos_approval', ...approval }, SECRET, { expiresIn: -1 }), exp)).toThrow(/истекло/);
  });
});

describe('refund', () => {
  it('частичный возврат: сумма строки со скидкой чека, наличные уходят из кассы', async () => {
    const after = jest.fn().mockResolvedValue(undefined);
    const { pool, queries } = makeDb({ order: ORDER, lines: LINES, register: { id: 'reg-1', current_balance: '1000' } });
    const r = await new PosRefundService(pool, SECRET, after).refund({
      enterpriseId: ENT, cashierId: 'cas', orderId: 'o1', refundId: 'rf1', approval, items: [{ orderItemId: 'l1', quantity: 1 }],
    });
    // 100 из 400 по чеку на 360 → 90
    expect(r).toMatchObject({ amount: 90, fullRefund: false, paymentMethod: 'cash' });
    const co = ops(queries, /INSERT INTO cash_operations/)[0];
    expect(co.sql).toMatch(/'refund'/);
    expect(co.params[2]).toBe(90);
    expect(ops(queries, /UPDATE cash_registers SET current_balance = current_balance - \$1/)[0].params).toEqual([90, 'reg-1']);
    expect(ops(queries, /UPDATE order_items SET refunded_quantity/)[0].params).toEqual([1, 'l1']);
    expect(after).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'o1', refundId: 'rf1', items: [{ orderItemId: 'l1', quantity: 1 }] }));
  });

  it('последний возврат забирает остаток до копейки и закрывает чек', async () => {
    const order = { ...ORDER, refunded_amount: '90' };
    const lines = [{ ...LINES[0], refunded_quantity: 1 }, LINES[1]];
    const { pool, queries } = makeDb({ order, lines, register: { id: 'reg-1', current_balance: '1000' } });
    const r = await new PosRefundService(pool, SECRET).refund({
      enterpriseId: ENT, cashierId: 'cas', orderId: 'o1', refundId: 'rf2', approval,
      items: [{ orderItemId: 'l1', quantity: 1 }, { orderItemId: 'l2', quantity: 1 }],
    });
    expect(r).toMatchObject({ amount: 270, fullRefund: true });
    const upd = ops(queries, /UPDATE orders SET refunded_amount/)[0];
    expect(upd.params).toEqual([270, true, 'o1']);
    expect(upd.sql).toMatch(/'cancelled'::order_status/);
  });

  it('вернуть больше, чем осталось в строке, нельзя', async () => {
    const { pool, queries } = makeDb({ order: ORDER, lines: [{ ...LINES[0], refunded_quantity: 2 }, LINES[1]],
                                       register: { id: 'reg-1', current_balance: '1000' } });
    await expect(new PosRefundService(pool, SECRET).refund({
      enterpriseId: ENT, cashierId: 'cas', orderId: 'o1', refundId: 'rf3', approval, items: [{ orderItemId: 'l1', quantity: 1 }],
    })).rejects.toThrow(/не больше 0 шт/);
    expect(ops(queries, /ROLLBACK/)).toHaveLength(1);
    expect(ops(queries, /INSERT INTO cash_operations/)).toHaveLength(0);
  });

  it('в кассе не хватает наличных — отказ, деньги не двигаются', async () => {
    const { pool, queries } = makeDb({ order: ORDER, lines: LINES, register: { id: 'reg-1', current_balance: '50' } });
    await expect(new PosRefundService(pool, SECRET).refund({
      enterpriseId: ENT, cashierId: 'cas', orderId: 'o1', refundId: 'rf4', approval, items: [{ orderItemId: 'l2', quantity: 1 }],
    })).rejects.toThrow(/недостаточно наличных/);
    expect(ops(queries, /UPDATE cash_registers/)).toHaveLength(0);
  });

  it('возврат по карте наличные в кассе не трогает', async () => {
    const { pool, queries } = makeDb({ order: { ...ORDER, payment_method: 'card' }, lines: LINES });
    const r = await new PosRefundService(pool, SECRET).refund({
      enterpriseId: ENT, cashierId: 'cas', orderId: 'o1', refundId: 'rf5', approval, items: [{ orderItemId: 'l2', quantity: 1 }],
    });
    expect(r.paymentMethod).toBe('card');
    expect(ops(queries, /cash_registers|cash_operations/)).toHaveLength(0);
  });

  it('повтор с тем же refundId не возвращает деньги второй раз', async () => {
    const { pool, queries } = makeDb({ replay: { order_id: 'o1', amount: '90', payment_method: 'cash' } });
    const r = await new PosRefundService(pool, SECRET).refund({
      enterpriseId: ENT, cashierId: 'cas', orderId: 'o1', refundId: 'rf1', approval, items: [{ orderItemId: 'l1', quantity: 1 }],
    });
    expect(r).toMatchObject({ replayed: true, amount: 90 });
    expect(ops(queries, /INSERT INTO|UPDATE/)).toHaveLength(0);
  });

  it('чек не с кассы этой организации — 404', async () => {
    const { pool } = makeDb({ order: null });
    await expect(new PosRefundService(pool, SECRET).refund({
      enterpriseId: ENT, cashierId: 'cas', orderId: 'o1', refundId: 'rf6', approval, items: [{ orderItemId: 'l1', quantity: 1 }],
    })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('changePayment', () => {
  const ap = { ...approval, action: 'payment_change' as const };
  it('наличные → карта: из кассы уходит вся сумма чека', async () => {
    const { pool, queries } = makeDb({ order: ORDER, register: { id: 'reg-1', current_balance: '1000' } });
    const r = await new PosRefundService(pool, SECRET).changePayment({
      enterpriseId: ENT, cashierId: 'cas', orderId: 'o1', refundId: 'c1', approval: ap, paymentMethod: 'card',
    });
    expect(r).toMatchObject({ amount: 360, paymentMethod: 'card' });
    expect(ops(queries, /current_balance - \$1/)[0].params).toEqual([360, 'reg-1']);
    expect(ops(queries, /INSERT INTO cash_operations/)[0].params[2]).toBe('cash_out');
    expect(ops(queries, /UPDATE orders SET payment_method/)[0].params).toEqual(['card', 'o1']);
  });
  it('карта → наличные: сумма приходит в кассу', async () => {
    const { pool, queries } = makeDb({ order: { ...ORDER, payment_method: 'card' }, register: { id: 'reg-1', current_balance: '0' } });
    await new PosRefundService(pool, SECRET).changePayment({
      enterpriseId: ENT, cashierId: 'cas', orderId: 'o1', refundId: 'c2', approval: ap, paymentMethod: 'cash',
    });
    expect(ops(queries, /current_balance \+ \$1/)[0].params).toEqual([360, 'reg-1']);
  });
  it('по чеку с возвратом смена оплаты запрещена', async () => {
    const { pool } = makeDb({ order: { ...ORDER, refunded_amount: '90' } });
    await expect(new PosRefundService(pool, SECRET).changePayment({
      enterpriseId: ENT, cashierId: 'cas', orderId: 'o1', refundId: 'c3', approval: ap, paymentMethod: 'card',
    })).rejects.toMatchObject({ statusCode: 409 });
  });
  it('тот же способ оплаты — отказ', async () => {
    const { pool } = makeDb({ order: ORDER });
    await expect(new PosRefundService(pool, SECRET).changePayment({
      enterpriseId: ENT, cashierId: 'cas', orderId: 'o1', refundId: 'c4', approval: ap, paymentMethod: 'cash',
    })).rejects.toThrow(/уже оплачен этим способом/);
  });
});
