/** Нумерация накладных и долг в списке. */
import { SupplierService } from '../supplier.service';

jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const calls: { sql: string; params: any[] }[] = [];
let result: any = { rows: [], rowCount: 0 };

jest.mock('pg', () => {
  class Pool {
    async query(sql: string, params: any[] = []) {
      calls.push({ sql, params });
      return result;
    }
    async connect() { return { query: this.query.bind(this), release() {} }; }
  }
  return { Pool, default: { Pool } };
});

function svc() {
  return new SupplierService('postgres://x/y');
}

beforeEach(() => { calls.length = 0; });

describe('nextInvoiceNumber', () => {
  it('номер берётся из функции БД, а не собирается в коде', async () => {
    result = { rows: [{ number: 'ПР-2026-00001' }], rowCount: 1 };
    const n = await svc().nextInvoiceNumber('ent-1');
    expect(n).toBe('ПР-2026-00001');
    const q = calls.find(c => /next_invoice_number/.test(c.sql));
    expect(q).toBeDefined();
    // Иначе два одновременных приёма получат одинаковый номер
    expect(q!.sql).toMatch(/SELECT next_invoice_number\(\$1\)/);
  });

  it('номер выдаётся строго для своего предприятия', async () => {
    result = { rows: [{ number: 'ПР-2026-00007' }], rowCount: 1 };
    await svc().nextInvoiceNumber('ent-42');
    const q = calls.find(c => /next_invoice_number/.test(c.sql))!;
    expect(q.params).toEqual(['ent-42']);
  });
});

describe('listInvoices: долг и оплата', () => {
  it('долг считается запросом, а не хранится отдельным полем', async () => {
    result = { rows: [], rowCount: 0 };
    await svc().listInvoices({ enterpriseId: 'ent-1' });
    const q = calls.find(c => /FROM supply_invoices/.test(c.sql))!;
    expect(q).toBeDefined();
    expect(q.sql).toMatch(/AS debt\b/);
    // total_amount - paid_amount, иначе долг разъедется с суммой накладной
    expect(q.sql).toMatch(/total_amount.*-.*paid_amount/s);
  });

  it('переплата не даёт отрицательного долга', async () => {
    result = { rows: [], rowCount: 0 };
    await svc().listInvoices({ enterpriseId: 'ent-1' });
    const q = calls.find(c => /FROM supply_invoices/.test(c.sql))!;
    expect(q.sql).toMatch(/GREATEST/);
  });

  it('выборка ограничена своим предприятием', async () => {
    result = { rows: [], rowCount: 0 };
    await svc().listInvoices({ enterpriseId: 'ent-1' });
    const q = calls.find(c => /FROM supply_invoices/.test(c.sql))!;
    expect(q.sql).toMatch(/si\.enterprise_id = \$1/);
    expect(q.params).toContain('ent-1');
  });

  it('фильтр по поставщику и статусу доходит до запроса', async () => {
    result = { rows: [], rowCount: 0 };
    await svc().listInvoices({ enterpriseId: 'e', supplierId: 's', status: 'received' });
    const q = calls.find(c => /FROM supply_invoices/.test(c.sql))!;
    expect(q.sql).toMatch(/si\.supplier_id = \$2/);
    expect(q.sql).toMatch(/si\.status = \$3/);
    expect(q.params).toEqual(['e', 's', 'received']);
  });
});
