/** PIN-эндпоинты режима кассы: доступ по токену, касса своей организации, PIN, сессии. */
import bcrypt from 'bcryptjs';

const PIN_HASH = bcrypt.hashSync('1234', 4);
const USER = '11111111-1111-4111-8111-111111111111';
const ENT = '22222222-2222-4222-8222-222222222222';
const REG = '33333333-3333-4333-8333-333333333333';
const SID = '44444444-4444-4444-8444-444444444444';

const queries: { sql: string; params: any[] }[] = [];
const db: { registerOwner: string | null; session: any | null; hasPin: boolean } = { registerOwner: ENT, session: null, hasPin: true };

/** Правила от частного к общему: ответ зависит от текста SQL и параметров. */
function answer(sql: string, params: any[]) {
  queries.push({ sql, params });
  if (/FROM cash_registers WHERE id = \$1 AND enterprise_id = \$2/.test(sql)) {
    return { rows: params[0] === REG && params[1] === db.registerOwner ? [{ '?column?': 1 }] : [] };
  }
  if (/SELECT pin_hash IS NOT NULL AS has_pin FROM users WHERE id = \$1/.test(sql)) {
    return { rows: params[0] === USER ? [{ has_pin: db.hasPin }] : [] };
  }
  if (/SELECT pin_hash FROM users WHERE id = \$1/.test(sql)) {
    return { rows: params[0] === USER ? [{ pin_hash: PIN_HASH }] : [] };
  }
  if (/FROM cash_register_sessions[\s\S]*ORDER BY created_at DESC[\s\S]*LIMIT 1/.test(sql)) {
    return { rows: db.session && params[0] === REG && params[1] === USER ? [db.session] : [] };
  }
  return { rows: [], rowCount: 1 };
}

jest.mock('pg', () => {
  class Pool {
    async query(sql: string, params: any[] = []) { return answer(sql, params); }
    async connect() {
      return { query: async (sql: string, params: any[] = []) => answer(sql, params), release: () => {} };
    }
  }
  return { default: { Pool }, Pool };
});

let actor: any = null;
jest.mock('../../middleware/enterprise.middleware', () => ({
  authenticateUser: (req: any, res: any, next: any) => {
    if (!actor) return res.status(401).json({ error: 'Unauthorized' });
    Object.assign(req, actor);
    next();
  },
}));

jest.mock('../../config', () => ({
  config: {
    database: { url: 'postgres://x/y' },
    jwt: { secret: 's', expiresIn: '1h', refreshSecret: 'r', refreshExpiresIn: '7d' },
    bcrypt: { saltRounds: 4 },
  },
}));

function invoke(path: string, body: any) {
  let router: any;
  jest.isolateModules(() => { router = require('../auth.routes').default; });
  const layer = router.stack.find((l: any) => l.route && l.route.path === path && l.route.methods.post);
  if (!layer) throw new Error(`роут POST ${path} не найден`);
  const req: any = { method: 'POST', params: {}, body, query: {}, headers: {} };
  const out: any = { status: 200, body: undefined };
  const res: any = {
    status(c: number) { out.status = c; return res; },
    json(b: any) { out.body = b; return res; },
  };
  const handlers = layer.route.stack.map((s: any) => s.handle);
  return (async () => {
    for (const h of handlers) {
      let advanced = false;
      await h(req, res, () => { advanced = true; });
      if (!advanced) break;
    }
    return out;
  })();
}

beforeEach(() => {
  queries.length = 0;
  actor = { userId: USER, userRole: 'customer', enterpriseId: ENT };
  db.registerOwner = ENT;
  db.session = null;
  db.hasPin = true;
});

const sqlOf = (re: RegExp) => queries.filter((q) => re.test(q.sql));

describe('POST /cash-register/verify', () => {
  it('без токена — 401, в БД не ходим', async () => {
    actor = null;
    const r = await invoke('/cash-register/verify', { pin: '1234', registerId: REG });
    expect(r.status).toBe(401);
    expect(queries).toHaveLength(0);
  });

  it('касса чужой организации — 404, сессия не создаётся', async () => {
    db.registerOwner = '55555555-5555-4555-8555-555555555555';
    const r = await invoke('/cash-register/verify', { pin: '1234', registerId: REG });
    expect(r.status).toBe(404);
    expect(sqlOf(/INSERT INTO cash_register_sessions/)).toHaveLength(0);
  });

  it('неверный PIN — 401 Invalid PIN', async () => {
    const r = await invoke('/cash-register/verify', { pin: '9999', registerId: REG });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('Invalid PIN');
    expect(sqlOf(/INSERT INTO cash_register_sessions/)).toHaveLength(0);
  });

  it('верный PIN — новая активная сессия на кассе этого кассира', async () => {
    const r = await invoke('/cash-register/verify', { pin: '1234', registerId: REG });
    expect(r.status).toBe(200);
    const ins = sqlOf(/INSERT INTO cash_register_sessions/)[0];
    expect(ins.params[0]).toBe(r.body.registerSessionId);
    expect(ins.params.slice(1, 3)).toEqual([USER, REG]);
    // Срок — смена, а не минуты
    expect(ins.params[3].getTime() - Date.now()).toBeGreaterThan(8 * 60 * 60 * 1000);
    // Прежние сессии этого кассира на этой кассе гасятся
    const upd = sqlOf(/UPDATE cash_register_sessions SET status = 'locked'/)[0];
    expect(upd.sql).toMatch(/user_id = \$1 AND register_id = \$2/);
    expect(upd.params).toEqual([USER, REG]);
  });

  it('пользователь без PIN (владелец) — 403 No PIN, а не «неверный PIN»', async () => {
    db.hasPin = false;
    const r = await invoke('/cash-register/verify', { pin: '1234', registerId: REG });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('No PIN');
    expect(r.body.message).toMatch(/логином кассира/);
  });

  it('без registerId — 400', async () => {
    const r = await invoke('/cash-register/verify', { pin: '1234' });
    expect(r.status).toBe(400);
  });
});

describe('POST /cash-register/lock и /unlock', () => {
  it('блокировка без PIN блокирует последнюю сессию', async () => {
    db.session = { id: SID, status: 'active', expires_at: new Date(Date.now() + 3600e3) };
    const r = await invoke('/cash-register/lock', { registerId: REG });
    expect(r.status).toBe(200);
    const upd = sqlOf(/SET status = 'locked'/)[0];
    expect(upd.params).toEqual([SID]);
  });

  it('разблокировка неверным PIN — 401, статус не меняется', async () => {
    db.session = { id: SID, status: 'locked', expires_at: new Date(Date.now() + 3600e3) };
    const r = await invoke('/cash-register/unlock', { pin: '0000', registerId: REG });
    expect(r.status).toBe(401);
    expect(sqlOf(/SET status = 'active'/)).toHaveLength(0);
  });

  it('разблокировка живой сессии возвращает тот же id', async () => {
    db.session = { id: SID, status: 'locked', expires_at: new Date(Date.now() + 3600e3) };
    const r = await invoke('/cash-register/unlock', { pin: '1234', registerId: REG });
    expect(r.status).toBe(200);
    expect(r.body.registerSessionId).toBe(SID);
    expect(sqlOf(/SET status = 'active'/)[0].params[1]).toBe(SID);
  });

  it('истёкшая сессия не воскрешается — открывается новая', async () => {
    db.session = { id: SID, status: 'locked', expires_at: new Date(Date.now() - 1000) };
    const r = await invoke('/cash-register/unlock', { pin: '1234', registerId: REG });
    expect(r.status).toBe(200);
    expect(r.body.registerSessionId).not.toBe(SID);
    expect(sqlOf(/SET status = 'active'/)).toHaveLength(0);
    expect(sqlOf(/INSERT INTO cash_register_sessions/)).toHaveLength(1);
  });
});
