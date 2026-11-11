/**
 * Кто может писать в закупки: поставщики, накладные и их позиции, приёмка,
 * заказы поставщикам. Раньше эти маршруты проверяли только вход — провести
 * приход и долг поставщику мог любой сотрудник, в том числе кассир.
 */
const purchasers = new Set<string>();
jest.mock('../../services/stock-alerts.instance', () => ({
  stockAlerts: { isPurchaser: (e: string, u: string) => Promise.resolve(purchasers.has(`${e}:${u}`)) },
  checkStockLater: jest.fn()
}));
jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { requireStockWriter, requireSupplierPayer } from '../../middleware/stock-writer';
import supplierRouter from '../supplier.routes';
import invoiceItemRouter from '../invoice-item.routes';
import purchaseOrderRouter from '../purchase-order.routes';

async function run(mw: any, ctx: any) {
  const req: any = { ...ctx };
  let status = 200; let passed = false;
  const res: any = { status(c: number) { status = c; return res; }, json() { return res; } };
  await mw(req, res, () => { passed = true; });
  return passed ? 'pass' : status;
}

beforeEach(() => purchasers.clear());

describe('requireStockWriter', () => {
  const base = { userId: 'u1', enterpriseId: 'e1', userRole: 'customer' };
  it.each(['owner', 'admin', 'manager', 'operator'])('%s — проходит', async (r) => {
    expect(await run(requireStockWriter, { ...base, enterpriseRole: r })).toBe('pass');
  });
  it.each(['cashier', 'waiter', 'chef', 'employee', 'viewer'])('%s без назначения — 403', async (r) => {
    expect(await run(requireStockWriter, { ...base, enterpriseRole: r })).toBe(403);
  });
  it('кассир, назначенный ответственным за закуп, — проходит', async () => {
    purchasers.add('e1:u1');
    expect(await run(requireStockWriter, { ...base, enterpriseRole: 'cashier' })).toBe('pass');
  });
  it('закупщик другой организации — 403', async () => {
    purchasers.add('e2:u1');
    expect(await run(requireStockWriter, { ...base, enterpriseRole: 'cashier' })).toBe(403);
  });
  it('владелец ресторана по users.role и внутренний вызов — проходят', async () => {
    expect(await run(requireStockWriter, { ...base, userRole: 'restaurant_owner' })).toBe('pass');
    expect(await run(requireStockWriter, { isInternal: true })).toBe('pass');
  });
});

describe('requireSupplierPayer — деньги поставщику', () => {
  const base = { userId: 'u1', enterpriseId: 'e1', userRole: 'customer' };
  it('менеджер платит, оператор и закупщик — нет', async () => {
    purchasers.add('e1:u1');
    expect(await run(requireSupplierPayer, { ...base, enterpriseRole: 'manager' })).toBe('pass');
    expect(await run(requireSupplierPayer, { ...base, enterpriseRole: 'operator' })).toBe(403);
    expect(await run(requireSupplierPayer, { ...base, enterpriseRole: 'cashier' })).toBe(403);
  });
});

describe('проверка стоит на КАЖДОМ записывающем маршруте закупок', () => {
  const writes = (router: any) => router.stack
    .filter((l: any) => l.route && ['post', 'put', 'delete', 'patch'].some((m) => l.route.methods[m]))
    .map((l: any) => ({ path: Object.keys(l.route.methods)[0] + ' ' + l.route.path, handles: l.route.stack.map((s: any) => s.handle) }));

  it.each([
    ['supplier.routes', supplierRouter], ['invoice-item.routes', invoiceItemRouter], ['purchase-order.routes', purchaseOrderRouter]
  ])('%s', (_n, router) => {
    const list = writes(router as any);
    expect(list.length).toBeGreaterThan(0);
    const unguarded = list
      .filter((w: any) => w.path !== 'post /invoices/from-photo') // только внутренний токен
      .filter((w: any) => !w.handles.includes(requireStockWriter) && !w.handles.includes(requireSupplierPayer))
      .map((w: any) => w.path);
    expect(unguarded).toEqual([]);
  });

  it('оплата поставщику — именно requireSupplierPayer', () => {
    const pay = writes(supplierRouter as any).find((w: any) => w.path === 'post /:id/payments');
    expect(pay.handles).toContain(requireSupplierPayer);
    expect(pay.handles).not.toContain(requireStockWriter);
  });
});
