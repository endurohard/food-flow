/**
 * Акции и промокоды: тенант и внятные ошибки вместо 500.
 *
 * Зачем этот тест. Экран «Лояльность» не показывал акции вовсе: таблица
 * promotions создана ранней миграцией под одну точку (restaurant_id,
 * start_date, usage_count), а код работает в терминах предприятия
 * (enterprise_id, valid_from, used_count) — GET /promotions падал с 500
 * «column enterprise_id does not exist». Схему привела в соответствие
 * миграция 046; здесь закрывается поведение роута:
 *
 *  - акция не создаётся без контекста предприятия (иначе enterprise_id = NULL,
 *    и строка не принадлежит никому, а отбор идёт именно по нему);
 *  - дубль промокода внутри предприятия — 409 с текстом, а не 500;
 *  - перевёрнутый период — 400 с текстом;
 *  - прочие ошибки БД по-прежнему 500, маскировать их нельзя.
 */
import crmRouter from '../crm.routes';

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
  authenticateInternal: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
  ROLES: { OWNER: 'owner', ADMIN: 'admin', MANAGER: 'manager', OPERATOR: 'operator' }
}));

let createImpl: (data: any) => Promise<any> = (d) => Promise.resolve({ id: 'promo-1', ...d });
let listImpl: (f: any) => Promise<any[]> = () => Promise.resolve([]);
const seen: { create: any[]; list: any[] } = { create: [], list: [] };

jest.mock('../../services/crm.service', () => ({
  CRMService: class {
    createPromotion(data: any) { seen.create.push(data); return createImpl(data); }
    listPromotions(f: any) { seen.list.push(f); return listImpl(f); }
    updatePromotion() { return Promise.resolve(null); }
    validatePromoCode() { return Promise.resolve(null); }
    listCustomers() { return Promise.resolve([]); }
    listLoyaltyPrograms() { return Promise.resolve([]); }
  }
}));

/** Ошибка Postgres с кодом и именем ограничения. */
function pgError(code: string, constraint: string, message = 'db error') {
  const e: any = new Error(message);
  e.code = code;
  e.constraint = constraint;
  return e;
}

async function callRoute(
  method: string,
  path: string,
  body: any = {},
  query: Record<string, any> = {}
): Promise<{ status: number; body: any }> {
  const router: any = crmRouter;
  const layer = router.stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()]
  );
  if (!layer) throw new Error(`Роут ${method} ${path} не найден — проверьте путь`);

  const req: any = { params: {}, body, query, headers: {} };
  let status = 200;
  let payload: any;
  const res: any = {
    status(c: number) { status = c; return res; },
    json(b: any) { payload = b; return res; }
  };
  for (const h of layer.route.stack.map((s: any) => s.handle)) {
    let advanced = false;
    await h(req, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return { status, body: payload };
}

const VALID = {
  name: 'Скидка на завтраки',
  promoType: 'percentage',
  discountValue: 10
};

beforeEach(() => {
  authCtx = { userRole: 'owner', enterpriseId: 'ent-own' };
  createImpl = (d) => Promise.resolve({ id: 'promo-1', ...d });
  listImpl = () => Promise.resolve([]);
  seen.create = [];
  seen.list = [];
});

describe('POST /promotions — тенант', () => {
  it('акция создаётся с enterprise_id из токена', async () => {
    const { status } = await callRoute('post', '/promotions', VALID);
    expect(status).toBe(201);
    expect(seen.create[0].enterpriseId).toBe('ent-own');
  });

  it('без контекста предприятия — 403, а не акция, видимая всем', async () => {
    authCtx = { userRole: 'owner', enterpriseId: undefined };
    const { status } = await callRoute('post', '/promotions', VALID);
    expect(status).toBe(403);
    // Главное: вставки не было вовсе
    expect(seen.create).toHaveLength(0);
  });
});

describe('POST /promotions — ошибки ввода называются своими словами', () => {
  it('дубль промокода внутри предприятия → 409 с текстом, а не 500', async () => {
    createImpl = () => Promise.reject(
      pgError('23505', 'idx_promotions_code_per_enterprise')
    );
    const { status, body } = await callRoute('post', '/promotions', { ...VALID, promoCode: 'LETO' });
    expect(status).toBe(409);
    expect(String(body.message)).toMatch(/уже есть/);
  });

  it('конец акции раньше начала → 400 с текстом', async () => {
    createImpl = () => Promise.reject(pgError('23514', 'promotions_valid_period'));
    const { status, body } = await callRoute('post', '/promotions', VALID);
    expect(status).toBe(400);
    expect(String(body.message)).toMatch(/раньше даты начала/);
  });

  it('прочие ошибки БД остаются 500 — маскировать их нельзя', async () => {
    createImpl = () => Promise.reject(pgError('40P01', 'none', 'deadlock detected'));
    const { status, body } = await callRoute('post', '/promotions', VALID);
    expect(status).toBe(500);
    expect(body.error).toBe('Internal server error');
  });

  it('CHECK 23514 с другим именем не выдаётся за неверный период', async () => {
    createImpl = () => Promise.reject(pgError('23514', 'promotions_used_count_non_negative'));
    const { status } = await callRoute('post', '/promotions', VALID);
    expect(status).toBe(500);
  });
});

describe('GET /promotions — отбор по предприятию', () => {
  it('список фильтруется по enterprise_id из токена', async () => {
    await callRoute('get', '/promotions');
    expect(seen.list[0].enterpriseId).toBe('ent-own');
  });

  it('super_admin видит все предприятия (enterpriseId не задан)', async () => {
    authCtx = { userRole: 'super_admin', enterpriseId: undefined };
    await callRoute('get', '/promotions');
    expect(seen.list[0].enterpriseId).toBeUndefined();
  });

  it('владелец без предприятия получает 403, а не чужие акции', async () => {
    authCtx = { userRole: 'owner', enterpriseId: undefined };
    const { status } = await callRoute('get', '/promotions');
    expect(status).toBe(403);
    expect(seen.list).toHaveLength(0);
  });

  it('isActive=false не теряется: запрос приходит с false, а не с true', async () => {
    await callRoute('get', '/promotions', {}, { isActive: 'false' });
    expect(seen.list[0].isActive).toBe(false);
  });
});
