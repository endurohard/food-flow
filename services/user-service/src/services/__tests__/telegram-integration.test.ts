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
