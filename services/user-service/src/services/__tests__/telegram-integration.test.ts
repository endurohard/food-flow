jest.mock('../../utils/telegram', () => {
  class TelegramError extends Error { constructor(m: string, public code?: number) { super(m); } }
  return { TelegramError, tgCall: jest.fn() };
});
process.env.ENCRYPTION_KEY = 'a'.repeat(64);

import { tgCall, TelegramError } from '../../utils/telegram';
import { TelegramIntegrationService } from '../telegram-integration.service';

const tg = tgCall as jest.Mock;
const TOKEN = '1234567890:AAH' + 'x'.repeat(32);

function fakePool(handler: (sql: string, params: any[]) => any[] = () => []) {
  const queries: { sql: string; params: any[] }[] = [];
  return { queries, async query(sql: string, params: any[] = []) { queries.push({ sql, params }); return { rows: handler(sql, params) }; } };
}
const botRow = (sql: string) => /FROM enterprise_telegram_bots WHERE enterprise_id/.test(sql)
  ? [{ bot_token: TOKEN, bot_username: 'cafe_bot', bot_name: 'Кафе', updates_offset: 10 }] : null;

beforeEach(() => tg.mockReset());

describe('saveBot', () => {
  it('отклоняет строку, не похожую на токен, не обращаясь к Telegram', async () => {
    await expect(new TelegramIntegrationService(fakePool()).saveBot('e1', 'hello', 'u1')).rejects.toMatchObject({ status: 400 });
    expect(tg).not.toHaveBeenCalled();
  });

  it('Telegram не принял токен — понятная ошибка 400', async () => {
    tg.mockRejectedValueOnce(new (TelegramError as any)('Unauthorized', 401));
    await expect(new TelegramIntegrationService(fakePool()).saveBot('e1', TOKEN, 'u1'))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining('не принял токен') });
  });

  it('бот с чужим вебхуком — 409, не сохраняем и вебхук не трогаем', async () => {
    tg.mockResolvedValueOnce({ username: 'cafe_bot' }).mockResolvedValueOnce({ url: 'https://other.example/hook' });
    const pool = fakePool();
    await expect(new TelegramIntegrationService(pool).saveBot('e1', TOKEN, 'u1')).rejects.toMatchObject({ status: 409 });
    expect(tg.mock.calls.map((c) => c[1])).toEqual(['getMe', 'getWebhookInfo']);
    expect(pool.queries.some((q) => /INSERT INTO enterprise_telegram_bots/.test(q.sql))).toBe(false);
  });

  it('токен хранится зашифрованным', async () => {
    tg.mockResolvedValueOnce({ username: 'cafe_bot', first_name: 'Кафе' }).mockResolvedValueOnce({ url: '' });
    const pool = fakePool();
    await new TelegramIntegrationService(pool).saveBot('e1', TOKEN, 'u1');
    const ins = pool.queries.find((q) => /INSERT INTO enterprise_telegram_bots/.test(q.sql))!;
    expect(ins.params[1]).toMatch(/^enc:v1:/);
    expect(ins.params[1]).not.toContain(TOKEN);
  });
});

describe('pollLinks', () => {
  it('привязывает по /start <код> только коды этой организации и сдвигает offset', async () => {
    tg.mockImplementation(async (_t: string, method: string) => method === 'getUpdates' ? [
      { update_id: 11, message: { chat: { id: 555, type: 'private' }, from: { username: 'boss' }, text: '/start abc' } },
      { update_id: 12, message: { chat: { id: 777, type: 'group' }, text: '/start abc' } }
    ] : {});
    const pool = fakePool((sql) => botRow(sql) || (/UPDATE enterprise_telegram_recipients/.test(sql) ? [{ user_id: 'u1' }] : []));
    expect(await new TelegramIntegrationService(pool).pollLinks('e1')).toBe(1);
    const link = pool.queries.filter((q) => /UPDATE enterprise_telegram_recipients/.test(q.sql));
    expect(link).toHaveLength(1); // групповой чат проигнорирован
    expect(link[0].sql).toMatch(/enterprise_id = \$1 AND link_code = \$2 AND link_expires_at > NOW\(\)/);
    expect(link[0].params).toEqual(['e1', 'abc', 555, 'boss']);
    expect(tg.mock.calls[0][2]).toMatchObject({ offset: 10 });
    const off = pool.queries.find((q) => /updates_offset = GREATEST/.test(q.sql))!;
    expect(off.params).toEqual(['e1', 13]);
  });
});

describe('notify', () => {
  it('нет бота — no_bot, без отправки', async () => {
    expect(await new TelegramIntegrationService(fakePool()).notify('e1', 'x')).toMatchObject({ skipped: 'no_bot', sent: 0 });
    expect(tg).not.toHaveBeenCalled();
  });

  it('шлёт только владельцу и админам (роль проверяется в момент отправки), ссылка на поддомен', async () => {
    tg.mockResolvedValue({});
    const pool = fakePool((sql) => botRow(sql) || (/FROM enterprise_telegram_recipients r/.test(sql)
      ? [{ chat_id: 555, subdomain: 'coffee104' }] : []));
    const r = await new TelegramIntegrationService(pool).notify('e1', 'Пора заказать', '/admin-panel/inventory.html');
    expect(r).toMatchObject({ sent: 1, failed: 0 });
    const sel = pool.queries.find((q) => /FROM enterprise_telegram_recipients r/.test(q.sql))!;
    expect(sel.sql).toMatch(/eu\.role = ANY\(\$2\)/);
    expect(sel.params[1]).toEqual(['owner', 'admin']);
    expect(tg.mock.calls[0][2].text).toBe('Пора заказать\n\nОткрыть: https://coffee104.food-flow.ru/admin-panel/inventory.html');
  });

  it('никто не привязан — no_recipients', async () => {
    const pool = fakePool((sql) => botRow(sql) || []);
    expect(await new TelegramIntegrationService(pool).notify('e1', 'x')).toMatchObject({ skipped: 'no_recipients' });
  });
});

describe('ответственные за закуп', () => {
  it('notify шлёт и закупщикам: условие (роль ИЛИ is_purchaser) и только активным в организации', async () => {
    tg.mockResolvedValue({});
    const pool = fakePool((sql) => botRow(sql) || (/FROM enterprise_telegram_recipients r/.test(sql)
      ? [{ chat_id: 555, subdomain: 'coffee104' }, { chat_id: 556, subdomain: 'coffee104' }] : []));
    const r = await new TelegramIntegrationService(pool).notify('e1', 'Пора заказать');
    expect(r).toMatchObject({ sent: 2 });
    const sel = pool.queries.find((q) => /FROM enterprise_telegram_recipients r/.test(q.sql))!;
    expect(sel.sql).toMatch(/\(eu\.role = ANY\(\$2\) OR eu\.is_purchaser\)/);
    expect(sel.sql).toMatch(/COALESCE\(eu\.is_active, true\)/);
    expect(sel.sql).toMatch(/r\.enterprise_id = \$1/);
    expect(sel.params[0]).toBe('e1');
  });

  it('есть неистёкшая ссылка — перед рассылкой дочитывает /start (закупщик нажал после ухода админа)', async () => {
    tg.mockImplementation(async (_t: string, method: string) => method === 'getUpdates' ? [
      { update_id: 20, message: { chat: { id: 900, type: 'private' }, from: { username: 'buyer' }, text: '/start code1' } }
    ] : {});
    const calls: string[] = [];
    const pool = fakePool((sql) => {
      if (/link_code IS NOT NULL AND link_expires_at > NOW\(\)/.test(sql)) return [{ '?column?': 1 }];
      if (/UPDATE enterprise_telegram_recipients/.test(sql)) { calls.push('link'); return [{ user_id: 'u9' }]; }
      if (/FROM enterprise_telegram_recipients r/.test(sql)) { calls.push('select'); return [{ chat_id: 900, subdomain: 's' }]; }
      return botRow(sql) || [];
    });
    await new TelegramIntegrationService(pool).notify('e1', 'x');
    expect(calls).toEqual(['link', 'select']); // привязка — до выборки получателей
    const pend = pool.queries.find((q) => /link_code IS NOT NULL/.test(q.sql))!;
    expect(pend.sql).toMatch(/enterprise_id = \$1/);
  });

  it('нет ожидающих ссылок — getUpdates не дёргается', async () => {
    tg.mockResolvedValue({});
    const pool = fakePool((sql) => botRow(sql) || (/FROM enterprise_telegram_recipients r/.test(sql) ? [{ chat_id: 1, subdomain: 's' }] : []));
    await new TelegramIntegrationService(pool).notify('e1', 'x');
    expect(tg.mock.calls.map((c) => c[1])).toEqual(['sendMessage']);
  });

  it('setPurchaser: сотрудник не из организации — 404; правка только в своей организации', async () => {
    const pool = fakePool(() => []);
    await expect(new TelegramIntegrationService(pool).setPurchaser('e1', 'u2', true)).rejects.toMatchObject({ status: 404 });
    const upd = pool.queries.find((q) => /UPDATE enterprise_users SET is_purchaser/.test(q.sql))!;
    expect(upd.sql).toMatch(/WHERE enterprise_id = \$1 AND user_id = \$2/);
    expect(upd.params).toEqual(['e1', 'u2', true]);
  });

  it('снятый закупщик-сотрудник отвязывается, снятый админ — нет', async () => {
    const del = (role: string) => {
      const pool = fakePool((sql) => /UPDATE enterprise_users/.test(sql) ? [{ role }] : []);
      return new TelegramIntegrationService(pool).setPurchaser('e1', 'u2', false)
        .then(() => pool.queries.filter((q) => /DELETE FROM enterprise_telegram_recipients/.test(q.sql)));
    };
    const emp = await del('employee');
    expect(emp).toHaveLength(1);
    expect(emp[0].params).toEqual(['e1', 'u2']);
    expect(await del('admin')).toHaveLength(0);
  });

  it('getStatus: получатели (с меткой закупа) отдельно от остальных сотрудников', async () => {
    const pool = fakePool((sql) => /FROM enterprise_users eu/.test(sql) ? [
      { user_id: 'o', first_name: 'Ольга', role: 'owner', is_purchaser: false, recipient: true, linked: true },
      { user_id: 'b', first_name: 'Борис', role: 'employee', is_purchaser: true, recipient: true, linked: false },
      { user_id: 'c', first_name: 'Вера', role: 'cashier', is_purchaser: false, recipient: false, linked: false }
    ] : []);
    const st = await new TelegramIntegrationService(pool).getStatus('e1', 'o');
    expect(st.recipients.map((r: any) => [r.userId, r.purchaser])).toEqual([['o', false], ['b', true]]);
    expect(st.staff).toEqual([{ userId: 'c', name: 'Вера', role: 'cashier' }]);
    const sel = pool.queries.find((q) => /FROM enterprise_users eu/.test(q.sql))!;
    expect(sel.sql).toMatch(/WHERE eu\.enterprise_id = \$1/);
  });

  it('isRecipient: ссылку можно выдать только владельцу/админу/закупщику этой организации', async () => {
    const pool = fakePool(() => []);
    expect(await new TelegramIntegrationService(pool).isRecipient('e1', 'u2')).toBe(false);
    const q = pool.queries[0];
    expect(q.sql).toMatch(/eu\.enterprise_id = \$1 AND \(eu\.role = ANY\(\$2\) OR eu\.is_purchaser\) AND eu\.user_id = \$3/);
    expect(q.params).toEqual(['e1', ['owner', 'admin'], 'u2']);
  });
});
