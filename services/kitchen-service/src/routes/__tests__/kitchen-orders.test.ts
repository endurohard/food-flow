/**
 * GET /api/kitchen/orders — источник экрана кухни (kds.html).
 *
 * Экран раньше читал /api/orders и был всегда пуст. Теперь он читает этот
 * роут, поэтому здесь закреплено то, что экран показывает: тип заказа из
 * orders.order_type («в зале» не становится самовывозом), номер стола, заказы
 * без клиента (продажа с кассы) и доступ официанта, которому KDS открыт в меню.
 */
const queries: { sql: string; params: any[] }[] = [];
jest.mock('pg', () => ({
  Pool: class { query(sql: string, params: any[]) { queries.push({ sql, params }); return Promise.resolve({ rows: [], rowCount: 0 }); } }
}));
let ctx: any = {};
jest.mock('../../middleware/auth.middleware', () => {
  const real = jest.requireActual('../../middleware/auth.middleware');
  return {
    ...real,
    authenticateUser: (req: any, _res: any, next: any) => { Object.assign(req, ctx); next(); }
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router: any = require('../kitchen.routes').default || require('../kitchen.routes');

async function run(path: string, query: any = {}) {
  const req: any = { method: 'GET', url: path, path, query, params: {}, body: {}, headers: {} };
  let status = 200; let body: any;
  const res: any = { status(c: number) { status = c; return res; }, json(b: any) { body = b; return res; } };
  // Глобальные middleware роутера (router.use) + сам обработчик
  const layers = router.stack.filter((l: any) => !l.route || (l.route.path === path && l.route.methods.get));
  for (const l of layers) {
    const handlers = l.route ? l.route.stack.map((s: any) => s.handle) : [l.handle];
    for (const h of handlers) {
      let next = false;
      await h(req, res, () => { next = true; });
      if (!next) return { status, body };
    }
  }
  return { status, body };
}

beforeEach(() => { queries.length = 0; ctx = { userId: 'u1', userRole: 'customer', enterpriseRole: 'chef', enterpriseId: 'e1' }; });

describe('GET /orders для экрана кухни', () => {
  it('тип заказа берётся из orders.order_type, а не угадывается по адресу', async () => {
    await run('/orders', { restaurantId: 'r1' });
    const sql = queries[0].sql;
    expect(sql).toMatch(/WHEN o\.order_type IN \('delivery', 'pickup', 'dine_in'\) THEN o\.order_type/);
    // проверка order_type стоит ПЕРВОЙ — иначе адрес перебьёт тип
    expect(sql.indexOf('o.order_type IN')).toBeLessThan(sql.indexOf('o.delivery_address_id IS NOT NULL'));
    expect(sql).toMatch(/as "orderType"/);
  });

  it('отдаёт номер стола и не теряет заказ без клиента', async () => {
    await run('/orders', { restaurantId: 'r1' });
    const sql = queries[0].sql;
    expect(sql).toMatch(/LEFT JOIN restaurant_tables t ON t\.id = o\.table_id/);
    expect(sql).toMatch(/t\.table_number as "tableNumber"/);
    expect(sql).toMatch(/LEFT JOIN users u ON o\.customer_id = u\.id/);
  });

  it('видны новые (confirmed) заказы и только своей организации', async () => {
    await run('/orders', { restaurantId: 'r1' });
    expect(queries[0].sql).toMatch(/o\.status IN \('confirmed', 'preparing', 'ready'\)/);
    expect(queries[0].sql).toMatch(/o\.enterprise_id = \$2/);
    expect(queries[0].params).toEqual(['r1', 'e1']);
  });

  it('официант допущен (KDS открыт ему в меню), кассир — нет', async () => {
    ctx.enterpriseRole = 'waiter';
    expect((await run('/orders', { restaurantId: 'r1' })).status).toBe(200);
    ctx.enterpriseRole = 'cashier';
    expect((await run('/orders', { restaurantId: 'r1' })).status).toBe(403);
  });
});
