/** Роуты настроек ВАТС: доступ, маскирование пароля, сохранение. */

const queries: { sql: string; params: any[] }[] = [];
let nextResult: any = { rows: [], rowCount: 0 };
let nextError: any = null;

jest.mock('pg', () => ({
  default: {
    Pool: class {
      async query(sql: string, params: any[] = []) {
        queries.push({ sql, params });
        if (nextError) { const e = nextError; nextError = null; throw e; }
        return nextResult;
      }
    }
  },
  Pool: class {
    async query(sql: string, params: any[] = []) {
      queries.push({ sql, params });
      if (nextError) { const e = nextError; nextError = null; throw e; }
      return nextResult;
    }
  }
}));

let actor: any = { userId: 'u1', userRole: 'owner', enterpriseId: 'ent-1' };

jest.mock('../../middleware/enterprise.middleware', () => ({
  authenticateUser: (req: any, _res: any, next: any) => { Object.assign(req, actor); next(); },
  // В роутере используется и как middleware, и как фабрика middleware —
  // поддерживаем оба вызова, иначе модуль падает ещё при загрузке.
  enterpriseContext: (..._a: any[]) => (_req: any, _res: any, next: any) => next(),
  requireEnterpriseRole: () => (_req: any, _res: any, next: any) => next(),
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  requireSuperAdmin: (_req: any, _res: any, next: any) => next()
}));

jest.mock('../../services/enterprise.service', () => ({
  EnterpriseService: class { }
}));

jest.mock('../../config', () => ({
  config: { database: { url: 'postgres://x/y' }, jwt: { secret: 's', expiresIn: '1h' } }
}));

/**
 * Вызов обработчика напрямую по стеку роутера: supertest в проекте нет,
 * и тащить зависимость ради тестов не стоит. Прогоняем всю цепочку
 * middleware роута, иначе проверка доступа осталась бы непокрытой.
 */
function invoke(method: string, path: string, opts: any = {}) {
  process.env.ENCRYPTION_KEY = opts.noKey ? undefined as any : 'a'.repeat(64);
  if (opts.noKey) delete process.env.ENCRYPTION_KEY;
  let router: any;
  jest.isolateModules(() => { router = require('../enterprise.routes').default; });

  const layer = router.stack.find((l: any) =>
    l.route && l.route.path === path && l.route.methods[method.toLowerCase()]);
  if (!layer) throw new Error(`роут ${method} ${path} не найден`);

  const req: any = { method: method.toUpperCase(), params: opts.params || {}, body: opts.body || {}, query: {}, headers: {} };
  const out: any = { status: 200, body: undefined };
  const res: any = {
    status(c: number) { out.status = c; return res; },
    json(b: any) { out.body = b; return res; }
  };

  const handlers = layer.route.stack.map((s: any) => s.handle);
  return (async () => {
    for (const h of handlers) {
      let advanced = false;
      await h(req, res, () => { advanced = true; });
      if (!advanced) break; // обработчик ответил — цепочка закончена
    }
    return out;
  })();
}

beforeEach(() => {
  queries.length = 0;
  nextError = null;
  actor = { userId: 'u1', userRole: 'owner', enterpriseId: 'ent-1' };
});

const SETTINGS_ROW = {
  vats_enabled: true,
  vats_host: 'org.vats05.ru:443',
  vats_password: 'enc:v1:c29tZXRoaW5n',
  vats_client_type: 'foodflow',
  vats_protocol_version: 1,
  vats_last_connected_at: null,
  vats_last_error: null
};

describe('GET /:id/vats-settings', () => {
  it('пароль наружу не отдаётся, но признак «задан» есть', async () => {
    nextResult = { rows: [SETTINGS_ROW], rowCount: 1 };
    const r = await invoke('get', '/:id/vats-settings', { params: { id: 'ent-1' } });
    expect(r.status).toBe(200);
    expect(r.body.vats_password).toBe('********');
    expect(r.body.vats_password_set).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain('c29tZXRoaW5n');
  });

  it('чужое предприятие не отдаётся', async () => {
    nextResult = { rows: [SETTINGS_ROW], rowCount: 1 };
    const r = await invoke('get', '/:id/vats-settings', { params: { id: 'ent-OTHER' } });
    expect(r.status).toBe(403);
    expect(queries.length).toBe(0); // до базы запрос дойти не должен
  });

  it('супер-админ видит любое предприятие', async () => {
    actor = { userId: 'root', userRole: 'super_admin', enterpriseId: null };
    nextResult = { rows: [SETTINGS_ROW], rowCount: 1 };
    const r = await invoke('get', '/:id/vats-settings', { params: { id: 'ent-OTHER' } });
    expect(r.status).toBe(200);
  });

  it('несуществующее предприятие — 404', async () => {
    nextResult = { rows: [], rowCount: 0 };
    const r = await invoke('get', '/:id/vats-settings', { params: { id: 'ent-1' } });
    expect(r.status).toBe(404);
  });

  it('когда пароль не задан, признак false', async () => {
    nextResult = { rows: [{ ...SETTINGS_ROW, vats_password: null }], rowCount: 1 };
    const r = await invoke('get', '/:id/vats-settings', { params: { id: 'ent-1' } });
    expect(r.body.vats_password_set).toBe(false);
    expect(r.body.vats_password).toBeNull();
  });
});

describe('PUT /:id/vats-settings', () => {
  const OK = { rows: [{ vats_enabled: true, vats_host: 'org.vats05.ru:443', vats_client_type: 'foodflow', vats_protocol_version: 1 }], rowCount: 1 };

  it('пароль уходит в базу зашифрованным, а не открытым', async () => {
    nextResult = OK;
    const r = await invoke('put', '/:id/vats-settings', { params: { id: 'ent-1' }, body: { vats_enabled: true, vats_host: 'org.vats05.ru:443', vats_password: 'plain-secret' } });
    expect(r.status).toBe(200);
    const upd = queries.find(q => /UPDATE enterprises/.test(q.sql))!;
    expect(upd).toBeDefined();
    const flat = JSON.stringify(upd.params);
    expect(flat).not.toContain('plain-secret');
    expect(flat).toContain('enc:v1:');
  });

  it('пустой пароль не затирает сохранённый', async () => {
    nextResult = OK;
    await invoke('put', '/:id/vats-settings', { params: { id: 'ent-1' }, body: { vats_enabled: true, vats_host: 'org.vats05.ru:443', vats_password: '' } });
    const upd = queries.find(q => /UPDATE enterprises/.test(q.sql))!;
    // keepPassword=true и в SQL ветка сохранения прежнего значения
    expect(upd.params).toContain(true);
    expect(upd.sql).toMatch(/CASE WHEN .* THEN vats_password/);
  });

  it('маска, присланная обратно формой, не уезжает в базу как пароль', async () => {
    nextResult = OK;
    await invoke('put', '/:id/vats-settings', { params: { id: 'ent-1' }, body: { vats_enabled: true, vats_host: 'org.vats05.ru:443', vats_password: '' } });
    const upd = queries.find(q => /UPDATE enterprises/.test(q.sql))!;
    expect(JSON.stringify(upd.params)).not.toContain('********');
  });

  it('адрес без порта отбивается с понятным текстом', async () => {
    const r = await invoke('put', '/:id/vats-settings', { params: { id: 'ent-1' }, body: { vats_enabled: true, vats_host: 'org.vats05.ru', vats_password: 'p' } });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/host:port/);
    expect(queries.length).toBe(0);
  });

  it('включение без реквизитов объясняется человеку, а не кодом БД', async () => {
    nextError = Object.assign(new Error('check'), { code: '23514', constraint: 'enterprises_vats_enabled_needs_creds' });
    const r = await invoke('put', '/:id/vats-settings', { params: { id: 'ent-1' }, body: { vats_enabled: true } });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/адрес и пароль/);
  });

  it('чужое предприятие не правится', async () => {
    const r = await invoke('put', '/:id/vats-settings', { params: { id: 'ent-OTHER' }, body: { vats_enabled: false } });
    expect(r.status).toBe(403);
    expect(queries.length).toBe(0);
  });

  it('без ключа шифрования отказ 503, а пароль не сохраняется открытым', async () => {
    const r = await invoke('put', '/:id/vats-settings', {
      noKey: true,
      params: { id: 'ent-1' },
      body: { vats_enabled: true, vats_host: 'org.vats05.ru:443', vats_password: 'plain-secret' }
    });
    expect(r.status).toBe(503);
    expect(JSON.stringify(queries)).not.toContain('plain-secret');
  });

  it('выключение интеграции не требует реквизитов', async () => {
    nextResult = { rows: [{ vats_enabled: false }], rowCount: 1 };
    const r = await invoke('put', '/:id/vats-settings', { params: { id: 'ent-1' }, body: { vats_enabled: false } });
    expect(r.status).toBe(200);
  });

  it('ответ сохранения не содержит пароля ни в каком виде', async () => {
    nextResult = { rows: [{ ...OK.rows[0], vats_password: 'enc:v1:zzz' }], rowCount: 1 };
    const r = await invoke('put', '/:id/vats-settings', { params: { id: 'ent-1' }, body: { vats_enabled: true, vats_host: 'org.vats05.ru:443', vats_password: 'plain-secret' } });
    const body = JSON.stringify(r.body);
    expect(body).not.toContain('plain-secret');
    expect(body).not.toContain('enc:v1:');
  });
});
