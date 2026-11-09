/**
 * GET /api/inventory/stock-alerts — колокольчик «пора заказать».
 *
 * Ответственный за закуп (enterprise_users.is_purchaser) может иметь любую
 * роль — повар, сотрудник, кассир. Ему колокольчик положен наравне с
 * руководящими ролями, а прочим сотрудникам без назначения — нет.
 */
import inventoryRouter from '../inventory.routes';

jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

let authCtx: { userRole: string; enterpriseRole?: string; enterpriseId?: string } = {
  userRole: 'customer', enterpriseRole: 'employee', enterpriseId: 'ent-own'
};

jest.mock('../../middleware/auth.middleware', () => ({
  authenticateUser: (req: any, _res: any, next: any) => {
    req.userId = 'user-1';
    req.userRole = authCtx.userRole;
    req.enterpriseRole = authCtx.enterpriseRole;
    req.enterpriseId = authCtx.enterpriseId;
    next();
  },
  authenticateInternal: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
  ROLES: { OWNER: 'owner', ADMIN: 'admin', MANAGER: 'manager', OPERATOR: 'operator' }
}));

const purchasers = new Set<string>();
const purchaserCalls: Array<[string, string]> = [];
jest.mock('../../services/stock-alerts.instance', () => ({
  stockAlerts: {
    isPurchaser: (ent: string, user: string) => {
      purchaserCalls.push([ent, user]);
      return Promise.resolve(purchasers.has(`${ent}:${user}`));
    },
    listOpen: (ent: string) => Promise.resolve([{ id: 'a1', enterprise: ent }])
  },
  checkStockLater: jest.fn()
}));

async function callRoute(method: string, path: string): Promise<{ status: number; body: any }> {
  const router: any = inventoryRouter;
  const layer = router.stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()]
  );
  if (!layer) throw new Error(`Роут ${method} ${path} не найден`);
  const req: any = { params: {}, body: {}, query: {}, headers: {} };
  let status = 200;
  let body: any;
  const res: any = {
    status(c: number) { status = c; return res; },
    json(b: any) { body = b; return res; }
  };
  for (const h of layer.route.stack.map((s: any) => s.handle)) {
    let advanced = false;
    await h(req, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return { status, body };
}

beforeEach(() => {
  authCtx = { userRole: 'customer', enterpriseRole: 'employee', enterpriseId: 'ent-own' };
  purchasers.clear();
  purchaserCalls.length = 0;
});

describe('GET /stock-alerts — кому виден колокольчик', () => {
  it('сотрудник без назначения на закуп — 403', async () => {
    const { status } = await callRoute('get', '/stock-alerts');
    expect(status).toBe(403);
  });

  it('сотрудник, назначенный на закуп, видит предупреждения своей организации', async () => {
    purchasers.add('ent-own:user-1');
    const { status, body } = await callRoute('get', '/stock-alerts');
    expect(status).toBe(200);
    expect(body.alerts).toEqual([{ id: 'a1', enterprise: 'ent-own' }]);
    // Назначение проверяется в организации из токена, а не в любой
    expect(purchaserCalls).toEqual([['ent-own', 'user-1']]);
  });

  it('закупщик ДРУГОЙ организации доступа не получает', async () => {
    purchasers.add('ent-other:user-1');
    const { status } = await callRoute('get', '/stock-alerts');
    expect(status).toBe(403);
  });

  it('менеджер видит без назначения, проверка закупщика не нужна', async () => {
    authCtx.enterpriseRole = 'manager';
    const { status } = await callRoute('get', '/stock-alerts');
    expect(status).toBe(200);
    expect(purchaserCalls).toHaveLength(0);
  });

  it('владелец ресторана (users.role) видит', async () => {
    authCtx = { userRole: 'restaurant_owner', enterpriseId: 'ent-own' };
    expect((await callRoute('get', '/stock-alerts')).status).toBe(200);
  });
});
