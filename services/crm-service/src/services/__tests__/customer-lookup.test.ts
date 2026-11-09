import { CRMService } from '../crm.service';

const ENT = '11111111-1111-4111-8111-111111111111';

function makeSvc(rows: any[] = []) {
  const calls: { sql: string; params: any[] }[] = [];
  const svc = new CRMService('postgres://unused');
  (svc as any).pool = {
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length };
    }
  };
  return { svc, calls };
}

describe('поиск клиента для кассы', () => {
  it('только своё предприятие, даже без строки поиска', async () => {
    const { svc, calls } = makeSvc();
    await svc.lookupCustomers(ENT);
    expect(calls[0].sql).toMatch(/WHERE cp\.enterprise_id = \$1/);
    expect(calls[0].params[0]).toBe(ENT);
  });

  it('кассе не уходят e-mail и полный телефон — только 4 последние цифры', async () => {
    const { svc } = makeSvc([{ id: 'p1', first_name: 'Анна', last_name: 'ТЕСТ', phone: '+7 (999) 123-45-67', email: 'a@x.ru', loyalty_points: 120, loyalty_tier: 'bronze' }]);
    const [c] = await svc.lookupCustomers(ENT, 'анна');
    expect(c).toEqual({ id: 'p1', name: 'Анна ТЕСТ', phoneTail: '4567', points: 120, tier: 'bronze' });
    expect(JSON.stringify(c)).not.toMatch(/a@x\.ru|999/);
  });

  it('поиск по имени и по цифрам телефона', async () => {
    const { svc, calls } = makeSvc();
    await svc.lookupCustomers(ENT, '4567');
    expect(calls[0].sql).toMatch(/ILIKE \$2/);
    expect(calls[0].sql).toMatch(/regexp_replace\(coalesce\(u\.phone, ''\), '\\D', '', 'g'\) LIKE \$3/);
    expect(calls[0].params[2]).toBe('%4567%');
  });

  it('% и _ из ввода экранируются, а не работают как шаблон', async () => {
    const { svc, calls } = makeSvc();
    await svc.lookupCustomers(ENT, '%_');
    expect(calls[0].params[1]).toBe('%\\%\\_%');
  });

  it('лимит выдачи ограничен', async () => {
    const { svc, calls } = makeSvc();
    await svc.lookupCustomers(ENT, '', 1000);
    expect(calls[0].params.at(-1)).toBe(50);
  });
});
