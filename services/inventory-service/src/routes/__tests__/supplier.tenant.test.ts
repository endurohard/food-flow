/**
 * Изоляция предприятий на приёмке накладной.
 *
 * Зачем этот тест. На проде нашлось 8 позиций предприятия «Органика»,
 * оприходованных на склад предприятия «Кофейня 104»: накладная была заведена
 * на чужой склад мимо API, и подтверждение разложило товар по чужому складу.
 * `inventory_stock` не имеет enterprise_id — тенант определяется ТОЛЬКО через
 * склад, поэтому владелец соседней организации видел чужой товар как свой
 * остаток.
 *
 * База закрыта триггерами миграции 045. Здесь проверяется поведение роута:
 * нарушение тенанта обязано стать 400 с понятным текстом, а не 500
 * «Internal server error», по которому непонятно, что именно не так.
 */
import express from 'express';
import supplierRouter from '../supplier.routes';

jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

// Аутентификация подменяется: нас интересует обработка ошибки, а не JWT.
jest.mock('../../middleware/auth.middleware', () => ({
  authenticateUser: (req: any, _res: any, next: any) => {
    req.userId = 'user-1';
    req.userRole = 'owner';
    req.enterpriseId = 'ent-own';
    next();
  },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
  ROLES: { OWNER: 'owner', ADMIN: 'admin', MANAGER: 'manager', OPERATOR: 'operator' }
}));

/** Ошибка, которую отдаёт Postgres при срабатывании триггера из 045. */
function tenantError(name: string) {
  const e: any = new Error(
    `${name}: склад ae7b3724 принадлежит предприятию ed39fa26, позиция 84093445 — предприятию 67269721`
  );
  e.code = '23514';
  return e;
}

let confirmImpl: () => Promise<any>;

jest.mock('../../services/supplier.service', () => ({
  SupplierService: class {
    confirmInvoice() { return confirmImpl(); }
    invoiceBelongsTo() { return Promise.resolve(true); }
    supplierBelongsTo() { return Promise.resolve(true); }
    list() { return Promise.resolve([]); }
    listInvoices() { return Promise.resolve([]); }
  }
}));

jest.mock('../../services/inventory.service', () => ({
  InventoryService: class {
    warehouseBelongsTo() { return Promise.resolve(true); }
    itemBelongsTo() { return Promise.resolve(true); }
  }
}));

/** Находит слой роутера по методу и пути и прогоняет ВСЮ цепочку обработчиков. */
async function callRoute(method: string, path: string): Promise<{ status: number; body: any }> {
  const router: any = supplierRouter;
  const layer = router.stack.find((l: any) =>
    l.route && l.route.path === path && l.route.methods[method.toLowerCase()]
  );
  if (!layer) throw new Error(`Роут ${method} ${path} не найден — проверьте путь`);

  const req: any = { params: { id: 'inv-1' }, body: {}, query: {}, headers: {} };
  let status = 200;
  let body: any;
  const res: any = {
    status(c: number) { status = c; return res; },
    json(b: any) { body = b; return res; }
  };

  const handlers = layer.route.stack.map((s: any) => s.handle);
  for (const h of handlers) {
    let advanced = false;
    await h(req, res, () => { advanced = true; });
    if (!advanced) break; // обработчик ответил сам
  }
  return { status, body };
}

describe('POST /invoices/:id/confirm — чужой склад', () => {
  it('нарушение тенанта отдаётся как 400 с понятным текстом, а не 500', async () => {
    confirmImpl = () => Promise.reject(tenantError('warehouse_item_tenant_mismatch'));
    const { status, body } = await callRoute('post', '/invoices/:id/confirm');
    expect(status).toBe(400);
    expect(body.error).toBe('TenantMismatch');
    // Текст обязан называть причину: иначе оператор видит «ошибку сервера»
    // и не понимает, что накладная выписана на чужой склад.
    expect(String(body.message)).toMatch(/другому предприятию/);
  });

  it('то же для несовпадения предприятия самого движения', async () => {
    confirmImpl = () => Promise.reject(tenantError('movement_tenant_mismatch'));
    const { status, body } = await callRoute('post', '/invoices/:id/confirm');
    expect(status).toBe(400);
    expect(body.error).toBe('TenantMismatch');
  });

  it('прочие ошибки БД по-прежнему 500 — маскировать их нельзя', async () => {
    const e: any = new Error('deadlock detected');
    e.code = '40P01';
    confirmImpl = () => Promise.reject(e);
    const { status, body } = await callRoute('post', '/invoices/:id/confirm');
    expect(status).toBe(500);
    expect(body.error).toBe('Internal server error');
  });

  it('CHECK с кодом 23514 без tenant_mismatch не выдаётся за чужой склад', async () => {
    const e: any = new Error('new row violates check constraint "quantity_positive"');
    e.code = '23514';
    confirmImpl = () => Promise.reject(e);
    const { status } = await callRoute('post', '/invoices/:id/confirm');
    expect(status).toBe(500);
  });

  it('успешная приёмка не затронута', async () => {
    confirmImpl = () => Promise.resolve({ id: 'inv-1', status: 'received' });
    const { status, body } = await callRoute('post', '/invoices/:id/confirm');
    expect(status).toBe(200);
    expect(body.invoice.status).toBe('received');
  });
});
