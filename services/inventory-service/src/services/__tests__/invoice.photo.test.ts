/**
 * Черновик накладной из фото: файл ложится в хранилище организации, повтор
 * того же фото черновик не дублирует, отдача фото не выходит за хранилище.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SupplierService } from '../supplier.service';

jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('pg', () => {
  const Pool = jest.fn().mockImplementation(() => ({ connect: jest.fn(), query: jest.fn(), end: jest.fn() }));
  return { __esModule: true, default: { Pool }, Pool };
});

const ENT = '11111111-1111-4111-8111-111111111111';

function svc(handler: (sql: string, params: any[]) => any[]) {
  const s = new SupplierService('postgresql://test');
  const queries: { sql: string; params: any[] }[] = [];
  (s as any).pool = { query: jest.fn(async (sql: string, params: any[] = []) => { queries.push({ sql, params }); return { rows: handler(sql, params) }; }) };
  (s as any).nextInvoiceNumber = jest.fn(async () => 'ПР-2026-00007');
  return { s, queries };
}

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inv-photo-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('createDraftFromPhoto', () => {
  it('создаёт черновик на основном складе, файл — в папке организации', async () => {
    const { s, queries } = svc((sql, params) => {
      if (/FROM warehouses/.test(sql)) return [{ id: 'wh-main' }];
      if (/INSERT INTO supply_invoices/.test(sql)) return [{ id: 'inv-1', invoice_number: params[2], photo_url: params[3] }];
      return [];
    });
    const r = await s.createDraftFromPhoto({ enterpriseId: ENT, userId: 'u', fileId: 'uniq-1', mime: 'image/jpeg',
      body: Buffer.from('IMG'), caption: 'Фермер' }, dir);
    expect(r.duplicate).toBe(false);
    expect(r.invoice.invoice_number).toBe('ПР-2026-00007');
    const ins = queries.find((q) => /INSERT INTO supply_invoices/.test(q.sql))!;
    expect(ins.sql).toMatch(/'draft'/);
    expect(ins.params[1]).toBe('wh-main');
    expect(ins.params[4]).toBe('uniq-1');
    expect(ins.params[6]).toBe('Из Telegram: Фермер');
    const rel = ins.params[3] as string;
    expect(rel.startsWith(ENT + path.sep)).toBe(true);
    expect(rel.endsWith('.jpg')).toBe(true);
    expect((await fs.readFile(path.join(dir, rel))).toString()).toBe('IMG');
  });

  it('то же фото второй раз — возвращает прежний черновик, ничего не пишет', async () => {
    const { s, queries } = svc((sql) => /telegram_file_id = \$2/.test(sql) ? [{ id: 'inv-1', invoice_number: 'ПР-1' }] : []);
    const r = await s.createDraftFromPhoto({ enterpriseId: ENT, fileId: 'uniq-1', mime: 'image/jpeg', body: Buffer.from('IMG') }, dir);
    expect(r).toEqual({ invoice: { id: 'inv-1', invoice_number: 'ПР-1' }, duplicate: true });
    expect(queries.some((q) => /INSERT/.test(q.sql))).toBe(false);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('не картинка и не PDF — отказ', async () => {
    const { s } = svc(() => []);
    await expect(s.createDraftFromPhoto({ enterpriseId: ENT, fileId: 'x', mime: 'text/html', body: Buffer.from('<b>') }, dir))
      .rejects.toThrow(/фотография/);
  });
});

describe('getInvoicePhotoPath', () => {
  it('путь внутри хранилища отдаётся, выход наружу — нет', async () => {
    const ok = svc(() => [{ photo_url: path.join(ENT, 'a.jpg') }]);
    expect(await ok.s.getInvoicePhotoPath('inv', dir, ENT)).toBe(path.join(path.resolve(dir), ENT, 'a.jpg'));
    const bad = svc(() => [{ photo_url: '../../etc/passwd' }]);
    expect(await bad.s.getInvoicePhotoPath('inv', dir, ENT)).toBeNull();
    const ext = svc(() => [{ photo_url: 'https://example.com/a.jpg' }]);
    expect(await ext.s.getInvoicePhotoPath('inv', dir, ENT)).toBeNull();
  });

  it('чужая организация — условие по enterprise_id в запросе', async () => {
    const { s, queries } = svc(() => []);
    await s.getInvoicePhotoPath('inv', dir, ENT);
    expect(queries[0].sql).toMatch(/enterprise_id = \$2/);
    expect(queries[0].params).toEqual(['inv', ENT]);
  });
});

describe('updateDraftHeader: шапка черновика', () => {
  it('меняет только переданные поля и только у непринятой накладной своей организации', async () => {
    const { s, queries } = svc((sql) => /^UPDATE/.test(sql.trim()) ? [{ id: 'inv-1', supplier_id: 'sup-1' }] : []);
    const r = await s.updateDraftHeader('inv-1', { supplierId: 'sup-1' }, ENT);
    expect(r).toEqual({ id: 'inv-1', supplier_id: 'sup-1' });
    const q = queries[0];
    expect(q.sql).toMatch(/SET supplier_id = \$1, updated_at = NOW\(\)/);
    expect(q.sql).toMatch(/status <> 'received'/);
    expect(q.sql).toMatch(/enterprise_id = \$3/);
    expect(q.params).toEqual(['sup-1', 'inv-1', ENT]);
  });

  it('принятую накладную не меняет — понятная ошибка', async () => {
    const { s } = svc((sql) => /SELECT status/.test(sql) ? [{ status: 'received' }] : []);
    await expect(s.updateDraftHeader('inv-1', { supplierId: 'sup-1' }, ENT)).rejects.toThrow(/уже принята/);
  });

  it('пустая строка сохраняется как «не выбран»', async () => {
    const { s, queries } = svc(() => [{ id: 'inv-1' }]);
    await s.updateDraftHeader('inv-1', { warehouseId: '' }, ENT);
    expect(queries[0].params[0]).toBeNull();
  });
});
