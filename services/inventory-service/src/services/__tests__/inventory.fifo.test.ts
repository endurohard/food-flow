import { InventoryService } from '../inventory.service';

jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

// pg.Pool создаётся в конструкторе сервиса — подменяем его целиком,
// иначе тест полез бы в реальную БД.
jest.mock('pg', () => {
  const Pool = jest.fn().mockImplementation(() => ({
    connect: jest.fn(),
    query: jest.fn(),
    end: jest.fn()
  }));
  return { __esModule: true, default: { Pool }, Pool };
});

/**
 * Партия на складе. received_at задаёт порядок FIFO,
 * cost_price — себестоимость, от которой зависит прибыль.
 */
function batch(id: string, qty: number, cost: number, receivedAt: string, extra: any = {}) {
  return {
    id,
    batch_number: `B-${id}`,
    quantity: String(qty),
    cost_price: String(cost),
    received_at: receivedAt,
    expiry_date: null,
    is_depleted: false,
    ...extra
  };
}

/**
 * Клиент-протокол: запоминает UPDATE'ы, чтобы проверить,
 * сколько и из какой партии реально списано.
 */
function makeConn(batches: any[]) {
  const updates: { sql: string; params: any[] }[] = [];
  const conn: any = {
    updates,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (/SELECT \* FROM inventory_batches/.test(sql)) {
        // Мок уважает направление сортировки из самого SQL: иначе тест
        // прошёл бы и при подмене FIFO на LIFO в коде сервиса.
        const desc = /ORDER BY received_at\s+DESC/i.test(sql);
        const sorted = [...batches].sort((a, b) => {
          const d = new Date(a.received_at).getTime() - new Date(b.received_at).getTime();
          return desc ? -d : d;
        });
        return { rows: sorted, rowCount: sorted.length };
      }
      if (/UPDATE inventory_batches/.test(sql)) {
        updates.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn()
  };
  return conn;
}

function makeService() {
  return new InventoryService('postgresql://test');
}

describe('deductFIFO — порядок списания', () => {
  it('списывает из самой старой партии первой', async () => {
    const conn = makeConn([
      batch('new', 100, 200, '2026-03-01'),
      batch('old', 100, 100, '2026-01-01')
    ]);
    const svc = makeService();

    const res = await svc.deductFIFO('w-1', 'i-1', 50, conn);

    expect(res.batches).toHaveLength(1);
    expect(res.batches[0].batchId).toBe('old');
  });

  it('при нехватке в первой партии переходит к следующей по дате', async () => {
    const conn = makeConn([
      batch('b1', 30, 100, '2026-01-01'),
      batch('b2', 50, 150, '2026-02-01'),
      batch('b3', 50, 200, '2026-03-01')
    ]);
    const svc = makeService();

    const res = await svc.deductFIFO('w-1', 'i-1', 60, conn);

    expect(res.batches.map((b: any) => b.batchId)).toEqual(['b1', 'b2']);
    expect(res.batches[0].deducted).toBe(30);
    expect(res.batches[1].deducted).toBe(30);
  });

  it('порядок партий строго от старой к новой, а не наоборот', async () => {
    // Ловит подмену FIFO на LIFO: при DESC порядок стал бы обратным,
    // и себестоимость считалась бы по дорогим свежим партиям
    const conn = makeConn([
      batch('b2', 10, 150, '2026-02-01'),
      batch('b4', 10, 250, '2026-04-01'),
      batch('b1', 10, 100, '2026-01-01'),
      batch('b3', 10, 200, '2026-03-01')
    ]);
    const svc = makeService();

    const res = await svc.deductFIFO('w-1', 'i-1', 40, conn);

    expect(res.batches.map((b: any) => b.batchId)).toEqual(['b1', 'b2', 'b3', 'b4']);
    expect(res.batches.map((b: any) => b.costPrice)).toEqual(['100', '150', '200', '250']);
  });

  it('выборка партий идёт в порядке FIFO и блокирует строки', async () => {
    // Без FOR UPDATE два параллельных списания спишут одну партию дважды
    const conn = makeConn([batch('b1', 10, 100, '2026-01-01')]);
    const svc = makeService();

    await svc.deductFIFO('w-1', 'i-1', 5, conn);

    const sel = conn.query.mock.calls.find((c: any) =>
      /SELECT \* FROM inventory_batches/.test(c[0])
    );
    expect(sel[0]).toMatch(/ORDER BY received_at ASC/);
    expect(sel[0]).toMatch(/FOR UPDATE/);
    expect(sel[0]).toMatch(/is_depleted = false/);
  });

  it('не берёт исчерпанные партии', async () => {
    const conn = makeConn([batch('b1', 10, 100, '2026-01-01')]);
    const svc = makeService();

    await svc.deductFIFO('w-1', 'i-1', 5, conn);

    const sel = conn.query.mock.calls.find((c: any) =>
      /SELECT \* FROM inventory_batches/.test(c[0])
    );
    expect(sel[0]).toMatch(/is_depleted = false/);
  });
});

describe('deductFIFO — количество', () => {
  it('частично израсходованная партия уменьшается, а не обнуляется', async () => {
    const conn = makeConn([batch('b1', 100, 100, '2026-01-01')]);
    const svc = makeService();

    await svc.deductFIFO('w-1', 'i-1', 40, conn);

    expect(conn.updates).toHaveLength(1);
    expect(conn.updates[0].sql).toMatch(/quantity = quantity - \$1/);
    expect(conn.updates[0].params[0]).toBe(40);
    expect(conn.updates[0].sql).not.toMatch(/is_depleted = true/);
  });

  it('полностью израсходованная партия помечается is_depleted', async () => {
    // Иначе пустая партия вечно висит в выборке и тормозит списание
    const conn = makeConn([batch('b1', 40, 100, '2026-01-01')]);
    const svc = makeService();

    await svc.deductFIFO('w-1', 'i-1', 40, conn);

    expect(conn.updates[0].sql).toMatch(/quantity = 0, is_depleted = true/);
  });

  it('точное совпадение количества закрывает партию без остатка', async () => {
    const conn = makeConn([batch('b1', 25, 100, '2026-01-01')]);
    const svc = makeService();

    const res = await svc.deductFIFO('w-1', 'i-1', 25, conn);

    expect(res.deducted).toBe(25);
    expect(res.batches[0].remainingInBatch).toBe(0);
  });

  it('сумма списаний по партиям равна запрошенному количеству', async () => {
    const conn = makeConn([
      batch('b1', 7, 100, '2026-01-01'),
      batch('b2', 13, 150, '2026-02-01'),
      batch('b3', 100, 200, '2026-03-01')
    ]);
    const svc = makeService();

    const res = await svc.deductFIFO('w-1', 'i-1', 35, conn);

    const total = res.batches.reduce((s: number, b: any) => s + b.deducted, 0);
    expect(total).toBe(35);
    expect(res.deducted).toBe(35);
  });

  it('дробное количество списывается без потери точности', async () => {
    // Килограммы и литры дробные: округление здесь воровало бы остатки
    const conn = makeConn([batch('b1', 2.5, 100, '2026-01-01')]);
    const svc = makeService();

    const res = await svc.deductFIFO('w-1', 'i-1', 1.3, conn);

    expect(res.batches[0].deducted).toBeCloseTo(1.3, 10);
    expect(res.batches[0].remainingInBatch).toBeCloseTo(1.2, 10);
  });

  it('остаток в партии считается верно при частичном списании', async () => {
    const conn = makeConn([batch('b1', 100, 100, '2026-01-01')]);
    const svc = makeService();

    const res = await svc.deductFIFO('w-1', 'i-1', 30, conn);

    expect(res.batches[0].remainingInBatch).toBe(70);
  });
});

describe('deductFIFO — себестоимость', () => {
  it('возвращает costPrice каждой затронутой партии', async () => {
    // По этим цифрам считается прибыль: потеря costPrice ломает отчёты
    const conn = makeConn([
      batch('b1', 10, 100, '2026-01-01'),
      batch('b2', 10, 250, '2026-02-01')
    ]);
    const svc = makeService();

    const res = await svc.deductFIFO('w-1', 'i-1', 15, conn);

    expect(res.batches[0].costPrice).toBe('100');
    expect(res.batches[1].costPrice).toBe('250');
  });

  it('при росте цен себестоимость берётся от старой партии, а не от новой', async () => {
    // Суть FIFO: сначала расходуется дешёвый старый товар
    const conn = makeConn([
      batch('cheap_old', 10, 50, '2026-01-01'),
      batch('expensive_new', 10, 500, '2026-06-01')
    ]);
    const svc = makeService();

    const res = await svc.deductFIFO('w-1', 'i-1', 10, conn);

    expect(res.batches).toHaveLength(1);
    expect(res.batches[0].costPrice).toBe('50');
  });

  it('взвешенная себестоимость по партиям считается верно', async () => {
    const conn = makeConn([
      batch('b1', 10, 100, '2026-01-01'),
      batch('b2', 10, 200, '2026-02-01')
    ]);
    const svc = makeService();

    const res = await svc.deductFIFO('w-1', 'i-1', 15, conn);

    const cost = res.batches.reduce(
      (s: number, b: any) => s + b.deducted * parseFloat(b.costPrice),
      0
    );
    // 10 шт по 100 + 5 шт по 200 = 2000
    expect(cost).toBe(2000);
  });
});

describe('deductFIFO — нехватка остатка', () => {
  it('нехватка товара бросает ошибку, а не списывает частично', async () => {
    const conn = makeConn([batch('b1', 5, 100, '2026-01-01')]);
    const svc = makeService();

    await expect(svc.deductFIFO('w-1', 'i-1', 10, conn)).rejects.toThrow(
      /Insufficient batch stock/
    );
  });

  it('в сообщении об ошибке видно, сколько просили и сколько есть', async () => {
    const conn = makeConn([batch('b1', 3, 100, '2026-01-01')]);
    const svc = makeService();

    await expect(svc.deductFIFO('w-1', 'i-1', 10, conn)).rejects.toThrow(
      /requested 10, available 3/
    );
  });

  it('пустой склад: ошибка, ни одного UPDATE', async () => {
    const conn = makeConn([]);
    const svc = makeService();

    await expect(svc.deductFIFO('w-1', 'i-1', 1, conn)).rejects.toThrow(
      /Insufficient batch stock/
    );
    expect(conn.updates).toHaveLength(0);
  });

  it('при внешней транзакции сервис не делает COMMIT/ROLLBACK сам', async () => {
    // Иначе он закрыл бы транзакцию заказа и списание нельзя было бы откатить
    const conn = makeConn([batch('b1', 5, 100, '2026-01-01')]);
    const svc = makeService();

    await expect(svc.deductFIFO('w-1', 'i-1', 10, conn)).rejects.toThrow();

    const sqls = conn.query.mock.calls.map((c: any) => c[0]);
    expect(sqls).not.toContain('BEGIN');
    expect(sqls).not.toContain('COMMIT');
    expect(sqls).not.toContain('ROLLBACK');
    expect(conn.release).not.toHaveBeenCalled();
  });
});

describe('deductFIFO — границы', () => {
  it('нулевое количество не трогает партии', async () => {
    const conn = makeConn([batch('b1', 10, 100, '2026-01-01')]);
    const svc = makeService();

    const res = await svc.deductFIFO('w-1', 'i-1', 0, conn);

    expect(conn.updates).toHaveLength(0);
    expect(res.batches).toHaveLength(0);
  });

  it('списание ровно всего остатка проходит и закрывает все партии', async () => {
    const conn = makeConn([
      batch('b1', 10, 100, '2026-01-01'),
      batch('b2', 15, 150, '2026-02-01')
    ]);
    const svc = makeService();

    const res = await svc.deductFIFO('w-1', 'i-1', 25, conn);

    expect(res.deducted).toBe(25);
    expect(conn.updates).toHaveLength(2);
    expect(conn.updates.every((u: any) => /is_depleted = true/.test(u.sql))).toBe(true);
  });

  it('лишние партии не затрагиваются, если хватило первых', async () => {
    const conn = makeConn([
      batch('b1', 100, 100, '2026-01-01'),
      batch('b2', 100, 150, '2026-02-01'),
      batch('b3', 100, 200, '2026-03-01')
    ]);
    const svc = makeService();

    const res = await svc.deductFIFO('w-1', 'i-1', 10, conn);

    expect(res.batches).toHaveLength(1);
    expect(conn.updates).toHaveLength(1);
  });
});
