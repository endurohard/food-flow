/**
 * GET /api/inventory/warehouses — список складов для экрана склада.
 *
 * Зачем этот тест. Роут требовал query-параметр restaurantId и отдавал 400
 * «restaurantId is required», а экран склада (inventory.html) грузит список
 * складов, не выбирая точку. На проде это значило: у предприятия есть склад,
 * а на экране «У предприятия нет ни одного склада» и недоступные приход,
 * списание и выпуск продукции. Ошибки в консоли при этом не было — фронт
 * показывал своё сообщение о пустом списке.
 *
 * Проверяется ровно то поведение, которое видит пользователь: без
 * restaurantId приходят склады предприятия, с restaurantId — склады точки,
 * и ни в одном случае чужие склады не попадают в выдачу.
 */
import inventoryRouter from '../inventory.routes';

jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

let authCtx: { userRole: string; enterpriseId?: string } = {
  userRole: 'owner',
  enterpriseId: 'ent-own'
};

jest.mock('../../middleware/auth.middleware', () => ({
  authenticateUser: (req: any, _res: any, next: any) => {
    req.userId = 'user-1';
    req.userRole = authCtx.userRole;
    req.enterpriseId = authCtx.enterpriseId;
    next();
  },
  // Мок обязан отдавать ВСЕ middleware, которые импортирует роут-файл:
  // отсутствующий экспорт приходит в router.post как undefined, и модуль
  // падает на загрузке («requires a callback function»), не дойдя до тестов.
  authenticateInternal: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
  ROLES: { OWNER: 'owner', ADMIN: 'admin', MANAGER: 'manager', OPERATOR: 'operator' }
}));

/** Склады в «базе»: у двух предприятий по одному, плюс склад другой точки. */
const WAREHOUSES = [
  { id: 'wh-own-1', name: 'Основной склад', enterprise_id: 'ent-own', restaurant_id: 'rest-own' },
  { id: 'wh-own-2', name: 'Заготовочный', enterprise_id: 'ent-own', restaurant_id: 'rest-own-2' },
  { id: 'wh-other', name: 'Основной склад', enterprise_id: 'ent-other', restaurant_id: 'rest-other' }
];

const calls: { byEnterprise: string[]; byRestaurant: Array<[string, string | undefined]> } = {
  byEnterprise: [],
  byRestaurant: []
};

jest.mock('../../services/inventory.service', () => ({
  InventoryService: class {
    listWarehousesByEnterprise(enterpriseId: string) {
      calls.byEnterprise.push(enterpriseId);
      return Promise.resolve(WAREHOUSES.filter((w) => w.enterprise_id === enterpriseId));
    }
    listWarehouses(restaurantId: string, enterpriseId?: string) {
      calls.byRestaurant.push([restaurantId, enterpriseId]);
      return Promise.resolve(
        WAREHOUSES.filter(
          (w) =>
            w.restaurant_id === restaurantId &&
            (enterpriseId === undefined || w.enterprise_id === enterpriseId)
        )
      );
    }
    warehouseBelongsTo() { return Promise.resolve(true); }
    itemBelongsTo() { return Promise.resolve(true); }
  }
}));

/** Находит слой роутера по методу и пути и прогоняет ВСЮ цепочку обработчиков. */
async function callRoute(
  method: string,
  path: string,
  query: Record<string, any> = {}
): Promise<{ status: number; body: any }> {
  const router: any = inventoryRouter;
  const layer = router.stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()]
  );
  if (!layer) throw new Error(`Роут ${method} ${path} не найден — проверьте путь`);

  const req: any = { params: {}, body: {}, query, headers: {} };
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
    if (!advanced) break;
  }
  return { status, body };
}

beforeEach(() => {
  authCtx = { userRole: 'owner', enterpriseId: 'ent-own' };
  calls.byEnterprise = [];
  calls.byRestaurant = [];
});

describe('GET /warehouses без restaurantId', () => {
  it('отдаёт склады предприятия, а не 400 — иначе экран склада пуст', async () => {
    const { status, body } = await callRoute('get', '/warehouses');
    expect(status).toBe(200);
    expect(body.warehouses.map((w: any) => w.id)).toEqual(['wh-own-1', 'wh-own-2']);
  });

  it('отбор идёт по предприятию из токена, а не по чему-то из запроса', async () => {
    await callRoute('get', '/warehouses');
    expect(calls.byEnterprise).toEqual(['ent-own']);
  });

  it('чужие склады не попадают в выдачу', async () => {
    const { body } = await callRoute('get', '/warehouses');
    const ents = body.warehouses.map((w: any) => w.enterprise_id);
    expect(ents.every((e: string) => e === 'ent-own')).toBe(true);
    expect(body.warehouses.find((w: any) => w.id === 'wh-other')).toBeUndefined();
  });

  it('без контекста предприятия — 403, а не выдача всего подряд', async () => {
    authCtx = { userRole: 'owner', enterpriseId: undefined };
    const { status } = await callRoute('get', '/warehouses');
    expect(status).toBe(403);
  });

  it('super_admin без restaurantId получает 400: тенанта нет, отбирать нечем', async () => {
    authCtx = { userRole: 'super_admin', enterpriseId: undefined };
    const { status, body } = await callRoute('get', '/warehouses');
    expect(status).toBe(400);
    expect(body.error).toMatch(/restaurantId/);
  });
});

describe('GET /warehouses с restaurantId', () => {
  it('отдаёт склады точки и по-прежнему фильтрует по предприятию', async () => {
    const { status, body } = await callRoute('get', '/warehouses', { restaurantId: 'rest-own' });
    expect(status).toBe(200);
    expect(body.warehouses.map((w: any) => w.id)).toEqual(['wh-own-1']);
    expect(calls.byRestaurant).toEqual([['rest-own', 'ent-own']]);
    // Путь «по предприятию» не должен задействоваться, иначе фильтр по точке потерян
    expect(calls.byEnterprise).toEqual([]);
  });

  it('чужая точка не отдаёт чужие склады владельцу', async () => {
    const { status, body } = await callRoute('get', '/warehouses', { restaurantId: 'rest-other' });
    expect(status).toBe(200);
    expect(body.warehouses).toEqual([]);
  });
});
