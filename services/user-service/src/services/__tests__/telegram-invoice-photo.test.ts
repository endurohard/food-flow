/**
 * Фото накладной, присланное боту организации, уходит на склад черновиком.
 *
 * Проверяется: что считается файлом накладной; что фото принимается только
 * от привязанного получателя (владелец, админ, закупщик) и через того же
 * бота; что на склад уходит сам файл с внутренним токеном и id организации;
 * что человек получает ответ с номером черновика.
 */
jest.mock('../../utils/telegram', () => {
  class TelegramError extends Error { constructor(m: string, public code?: number) { super(m); } }
  return { TelegramError, tgCall: jest.fn(), tgDownload: jest.fn() };
});
process.env.ENCRYPTION_KEY = 'a'.repeat(64);

import { tgCall, tgDownload } from '../../utils/telegram';
import { TelegramIntegrationService, invoiceFile } from '../telegram-integration.service';
import { encryptSecret } from '../../utils/secrets';

const tg = tgCall as jest.Mock;
const dl = tgDownload as jest.Mock;
const TOKEN = '1234567890:AAH' + 'x'.repeat(32);
const ENT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

const photoMsg = (extra: any = {}) => ({
  chat: { id: 555000111, type: 'private' }, from: { username: 'buyer' },
  photo: [{ file_id: 'small', file_unique_id: 'u-small', file_size: 1000 }, { file_id: 'big', file_unique_id: 'u-big', file_size: 90000 }],
  ...extra
});

function pool(recipient: boolean) {
  const queries: { sql: string; params: any[] }[] = [];
  return {
    queries,
    async query(sql: string, params: any[] = []) {
      queries.push({ sql, params });
      if (/FROM enterprise_telegram_bots WHERE enterprise_id/.test(sql)) {
        return { rows: [{ bot_token: encryptSecret(TOKEN), bot_username: 'cafe_bot', bot_name: 'Кафе', updates_offset: 5 }] };
      }
      if (/FROM enterprise_telegram_recipients r/.test(sql)) return { rows: recipient ? [{ user_id: USER }] : [] };
      return { rows: [] };
    }
  };
}

const realFetch = global.fetch;
beforeEach(() => {
  tg.mockReset(); dl.mockReset();
  process.env.INVENTORY_SERVICE_URL = 'http://inventory-service:3006';
  process.env.INTERNAL_TOKEN = 'secret-internal';
});
afterAll(() => { global.fetch = realFetch; });

describe('invoiceFile: что считается накладной', () => {
  it('у фото берётся самый крупный размер', () => {
    expect(invoiceFile(photoMsg())).toEqual({ fileId: 'big', uniqueId: 'u-big', mime: 'image/jpeg', size: 90000 });
  });
  it('PDF и картинка документом — да, прочие документы и текст — нет', () => {
    expect(invoiceFile({ document: { file_id: 'd', file_unique_id: 'ud', mime_type: 'application/pdf' } })?.mime).toBe('application/pdf');
    expect(invoiceFile({ document: { file_id: 'd', file_unique_id: 'ud', mime_type: 'application/zip' } })).toBeNull();
    expect(invoiceFile({ text: 'привет' })).toBeNull();
  });
});

describe('свой бот: фото → черновик накладной', () => {
  it('от получателя — файл уходит на склад, в ответ номер черновика', async () => {
    tg.mockImplementation(async (_t: string, method: string) => {
      if (method === 'getUpdates') return [{ update_id: 7, message: photoMsg({ caption: 'Фермер, молоко' }) }];
      if (method === 'getFile') return { file_path: 'photos/file_1.jpg' };
      return {};
    });
    dl.mockResolvedValue(Buffer.from('JPEGDATA'));
    const fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ invoice: { invoice_number: 'ПР-2026-00042' }, duplicate: false }) }));
    global.fetch = fetchMock as any;

    const p = pool(true);
    await new TelegramIntegrationService(p).pollLinks(ENT);

    expect(tg.mock.calls.find((c) => c[1] === 'getFile')[2]).toEqual({ file_id: 'big' });
    const [url, init] = (fetchMock.mock.calls as any[])[0];
    expect(url).toContain('/api/suppliers/invoices/from-photo?');
    expect(url).toContain('enterpriseId=' + ENT);
    expect(url).toContain('fileId=u-big');
    expect(init.headers).toMatchObject({ 'Content-Type': 'image/jpeg', 'X-Internal-Token': 'secret-internal' });
    expect(init.body.toString()).toBe('JPEGDATA');
    const reply = tg.mock.calls.find((c) => c[1] === 'sendMessage')[2];
    expect(reply.text).toContain('ПР-2026-00042');
    // искали получателя этой организации и этого бота
    const q = p.queries.find((x) => /FROM enterprise_telegram_recipients r/.test(x.sql))!;
    expect(q.params).toEqual([ENT, ['owner', 'admin'], 555000111, 'cafe_bot']);
  });

  it('от постороннего — ничего не скачивается и не создаётся', async () => {
    tg.mockImplementation(async (_t: string, method: string) =>
      method === 'getUpdates' ? [{ update_id: 8, message: photoMsg() }] : {});
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    await new TelegramIntegrationService(pool(false)).pollLinks(ENT);
    expect(tg.mock.calls.some((c) => c[1] === 'getFile')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tg.mock.calls.find((c) => c[1] === 'sendMessage')[2].text).toMatch(/только от владельца/);
  });

  it('склад не настроен — понятный ответ, без скачивания', async () => {
    delete process.env.INVENTORY_SERVICE_URL;
    tg.mockImplementation(async (_t: string, method: string) =>
      method === 'getUpdates' ? [{ update_id: 9, message: photoMsg() }] : {});
    await new TelegramIntegrationService(pool(true)).pollLinks(ENT);
    expect(dl).not.toHaveBeenCalled();
    expect(tg.mock.calls.find((c) => c[1] === 'sendMessage')[2].text).toMatch(/не настроен/);
  });

  it('два опроса одного бота одновременно не идут', async () => {
    let release: () => void = () => undefined;
    tg.mockImplementation((_t: string, method: string) => method === 'getUpdates'
      ? new Promise((r) => { release = () => r([]); }) : Promise.resolve({}));
    const svc = new TelegramIntegrationService(pool(true));
    const first = svc.pollLinks(ENT);
    await new Promise((r) => setTimeout(r, 0));
    expect(await svc.pollLinks(ENT)).toBe(0);
    release();
    await first;
    expect(tg.mock.calls.filter((c) => c[1] === 'getUpdates')).toHaveLength(1);
  });
});
