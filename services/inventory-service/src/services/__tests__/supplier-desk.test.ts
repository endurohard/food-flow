/**
 * Поставщики: сверка с нарастающим долгом, удаление только черновика.
 */
import { SupplierDeskService } from '../supplier-desk.service';

jest.mock('pg', () => {
  const Pool = jest.fn().mockImplementation(() => ({ connect: jest.fn(), query: jest.fn(), end: jest.fn() }));
  return { __esModule: true, default: { Pool }, Pool };
});

const ENT = 'ent-1';
function client(handler: (sql: string, params: any[]) => any[] = () => []) {
  const log: { sql: string; params: any[] }[] = [];
  return {
    log,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      log.push({ sql, params });
      const rows = handler(sql, params);
      return { rows, rowCount: rows.length };
    }),
    release: jest.fn()
  };
}
function svcWith(c: any) {
  const s = new SupplierDeskService('postgresql://test');
  (s as any).pool = { connect: jest.fn(async () => c), query: c.query };
  return s;
}

describe('ledger', () => {
  it('долг нарастает накладными и уменьшается оплатами; новые сверху', async () => {
    const c = client((sql) => {
      if (/FROM suppliers WHERE id/.test(sql)) return [{ id: 's1', name: 'Фермер', balance: '700' }];
      if (/UNION ALL/.test(sql)) return [
        { kind: 'invoice', id: 'i1', at: '2026-11-01', amount: '1000' },
        { kind: 'payment', id: 'p1', at: '2026-11-02', amount: '800' },
        { kind: 'invoice', id: 'i2', at: '2026-11-05', amount: '500.4' }
      ];
      return [];
    });
    const r = (await svcWith(c).ledger('s1', ENT))!;
    expect(r.rows.map((x) => [x.id, x.balance_after])).toEqual([['i2', 700.4], ['p1', 200], ['i1', 1000]]);
    expect(r.totals).toEqual({ invoiced: 1500.4, paid: 800, balance: 700.4, storedBalance: 700 });
    expect(c.log[1].params).toEqual(['s1', ENT]);
  });

  it('чужой поставщик — null', async () => {
    expect(await svcWith(client(() => [])).ledger('x', ENT)).toBeNull();
  });
});

describe('deleteDraftInvoice', () => {
  it('черновик удаляется в транзакции', async () => {
    const c = client((sql) => /FROM supply_invoices WHERE id/.test(sql) ? [{ id: 'inv', status: 'draft', invoice_number: 'ПР-1', photo_url: null }] : []);
    const r = await svcWith(c).deleteDraftInvoice('inv', ENT);
    expect(r).toEqual({ id: 'inv', invoice_number: 'ПР-1' });
    expect(c.log.map((q) => q.sql.trim().split(/\s+/)[0])).toEqual(['BEGIN', 'SELECT', 'DELETE', 'COMMIT']);
    expect(c.log[1].params).toEqual(['inv', ENT]);
  });

  it('принятую — 409, ничего не удалено', async () => {
    const c = client((sql) => /FROM supply_invoices WHERE id/.test(sql) ? [{ id: 'inv', status: 'received' }] : []);
    await expect(svcWith(c).deleteDraftInvoice('inv', ENT)).rejects.toMatchObject({ status: 409 });
    expect(c.log.some((q) => /^DELETE/.test(q.sql.trim()))).toBe(false);
  });

  it('чужую — 404', async () => {
    await expect(svcWith(client(() => [])).deleteDraftInvoice('inv', ENT)).rejects.toMatchObject({ status: 404 });
  });
});
