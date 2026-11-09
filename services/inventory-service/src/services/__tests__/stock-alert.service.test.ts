import { StockAlertService } from '../stock-alert.service';

jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

type Q = { sql: string; params: any[] };

function fakePool(pending: any[] = []) {
  const queries: Q[] = [];
  return {
    queries,
    async query(sql: string, params: any[] = []) {
      queries.push({ sql, params });
      if (/FROM stock_alerts a\s+JOIN inventory_items/.test(sql) && /telegram_sent_at IS NULL/.test(sql)) return { rows: pending };
      return { rows: [] };
    }
  };
}

const alert = (id: string, ent = 'e1', name = 'Зерно') =>
  ({ id, enterprise_id: ent, quantity: '0.400', min_stock: '1.000', name, unit: 'кг', warehouse: 'Основной склад' });

const updates = (pool: any) => pool.queries.filter((q: Q) => /^\s*UPDATE stock_alerts SET/.test(q.sql));

describe('StockAlertService.sweep', () => {
  it('открывает предупреждение только при min_stock > 0 и остатке не выше минимума, без дублей', async () => {
    const pool = fakePool();
    await new StockAlertService(pool).sweep({ warehouseId: 'w1', itemIds: ['i1'] });
    const ins = pool.queries.find((q) => /INSERT INTO stock_alerts/.test(q.sql))!;
    expect(ins.sql).toMatch(/i\.min_stock > 0 AND s\.quantity <= i\.min_stock/);
    expect(ins.sql).toMatch(/ON CONFLICT \(warehouse_id, inventory_item_id\) WHERE resolved_at IS NULL DO NOTHING/);
    expect(ins.params).toEqual(['w1', ['i1']]);
  });

  it('минус открывает предупреждение и без заданного минимума', async () => {
    const pool = fakePool();
    await new StockAlertService(pool).sweep({ warehouseId: 'w1' });
    const ins = pool.queries.find((q) => /INSERT INTO stock_alerts/.test(q.sql))!;
    expect(ins.sql).toMatch(/OR s\.quantity < 0\)/);
    const upd = pool.queries.find((q) => /UPDATE stock_alerts a SET resolved_at/.test(q.sql))!;
    expect(upd.sql).toMatch(/s\.quantity >= 0/);
  });

  it('«заканчивается» перешло в минус — переотправляем один раз', async () => {
    const pool = fakePool();
    await new StockAlertService(pool).sweep({ warehouseId: 'w1' });
    const re = pool.queries.find((q) => /telegram_sent_at = NULL/.test(q.sql))!;
    expect(re.sql).toMatch(/a\.quantity >= 0 AND s\.quantity < 0/);
  });

  it('закрывает предупреждение, когда остаток пополнили выше минимума', async () => {
    const pool = fakePool();
    await new StockAlertService(pool).sweep({ warehouseId: 'w1' });
    const upd = pool.queries.find((q) => /UPDATE stock_alerts a SET resolved_at = NOW\(\)/.test(q.sql))!;
    expect(upd.sql).toMatch(/s\.quantity > i\.min_stock/);
  });

  it('пустой список позиций — в базу не ходим', async () => {
    const pool = fakePool();
    expect(await new StockAlertService(pool).sweep({ warehouseId: 'w1', itemIds: [] })).toEqual({ opened: 0, resolved: 0, notified: 0 });
    expect(pool.queries).toHaveLength(0);
  });
});

describe('StockAlertService.sendPending', () => {
  it('одно сообщение на организацию со всеми позициями, после отправки помечаем отправленным', async () => {
    const pool = fakePool([alert('a1'), alert('a2', 'e1', 'Молоко'), alert('b1', 'e2')]);
    const notifier = jest.fn().mockResolvedValue({ sent: 1, failed: 0 });
    expect(await new StockAlertService(pool, notifier).sendPending()).toBe(2);
    expect(notifier).toHaveBeenCalledTimes(2);
    const [ent, text, link] = notifier.mock.calls[0];
    expect(ent).toBe('e1');
    expect(text).toContain('Пора заказать');
    expect(text).toContain('• Зерно — осталось 0.4 кг (минимум 1), Основной склад');
    expect(text).toContain('Молоко');
    expect(link).toBe('/admin-panel/inventory.html');
    const u = updates(pool);
    expect(u[0].sql).toMatch(/telegram_sent_at = NOW\(\)/);
    expect(u[0].params[0]).toEqual(['a1', 'a2']);
  });

  it('минус в сообщении — отдельным блоком «продано больше, чем есть»', async () => {
    const pool = fakePool([{ ...alert('a1'), quantity: '-0.030' }, alert('a2', 'e1', 'Молоко')]);
    const notifier = jest.fn().mockResolvedValue({ sent: 1, failed: 0 });
    await new StockAlertService(pool, notifier).sendPending();
    const text = notifier.mock.calls[0][1];
    expect(text).toContain('Продано больше, чем есть на складе');
    expect(text).toContain('• Зерно — на складе -0.03 кг, Основной склад');
    expect(text).toContain('Пора заказать');
    expect(text).toContain('Молоко');
  });

  it('нет бота — больше не пытаемся, причина записана', async () => {
    const pool = fakePool([alert('a1')]);
    await new StockAlertService(pool, jest.fn().mockResolvedValue({ sent: 0, failed: 0, skipped: 'no_bot' })).sendPending();
    const u = updates(pool)[0];
    expect(u.sql).not.toMatch(/telegram_sent_at = NOW/);
    expect(u.params).toEqual([['a1'], 5, 'Telegram-бот не подключён']);
  });

  it('сбой связи — попытка засчитана, отправленным не помечаем (повтор на следующем проходе)', async () => {
    const pool = fakePool([alert('a1')]);
    await new StockAlertService(pool, jest.fn().mockRejectedValue(new Error('ETIMEDOUT'))).sendPending();
    const u = updates(pool)[0];
    expect(u.sql).toMatch(/telegram_attempts = telegram_attempts \+ 1/);
    expect(u.sql).not.toMatch(/telegram_sent_at = NOW/);
    expect(u.params).toEqual([['a1'], 'ETIMEDOUT']);
  });

  it('без настроенной отправки ничего не делаем — предупреждение живёт в колокольчике', async () => {
    const pool = fakePool([alert('a1')]);
    expect(await new StockAlertService(pool).sendPending()).toBe(0);
    expect(pool.queries).toHaveLength(0);
  });
});

describe('StockAlertService.isPurchaser', () => {
  it('ищет назначение в заданной организации и только у активного сотрудника', async () => {
    const pool = fakePool();
    expect(await new StockAlertService(pool).isPurchaser('e1', 'u1')).toBe(false);
    const q = pool.queries[0];
    expect(q.sql).toMatch(/enterprise_id = \$1 AND user_id = \$2 AND is_purchaser AND COALESCE\(is_active, true\)/);
    expect(q.params).toEqual(['e1', 'u1']);
  });
});
