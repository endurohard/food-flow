/**
 * Журнал движений: фильтры работают в SQL.
 *
 * Зачем. Экран склада раньше брал последние 500 движений и фильтровал их сам —
 * приход месячной давности нельзя было найти ни по дате, ни по товару. Теперь
 * дата, типы, склад и поиск уходят в запрос; здесь проверяются сами условия
 * в тексте SQL и что пользовательский текст идёт параметром, а не в строку.
 */
import { InventoryService } from '../inventory.service';
import { parseMovementQuery } from '../../routes/inventory.routes';

function serviceWithSpy() {
  const seen: Array<{ sql: string; params: any[] }> = [];
  const svc = new InventoryService('postgres://u:p@localhost:5432/db');
  (svc as any).pool = {
    query: (sql: string, params: any[]) => {
      seen.push({ sql, params });
      return Promise.resolve({ rows: [{ n: 42 }] });
    }
  };
  return { svc, seen };
}

describe('getMovements: фильтры в SQL', () => {
  it('предприятие отбирается условием, а не только параметром', async () => {
    const { svc, seen } = serviceWithSpy();
    await svc.getMovements({ enterpriseId: 'ent-1' });
    expect(seen[0].sql).toMatch(/m\.enterprise_id\s*=\s*\$1/);
    expect(seen[0].params[0]).toBe('ent-1');
  });

  it('период — полуинтервал: с dateFrom включительно, до dateTo не включительно', async () => {
    const { svc, seen } = serviceWithSpy();
    await svc.getMovements({ enterpriseId: 'e', dateFrom: '2026-11-01T00:00:00.000Z', dateTo: '2026-11-08T00:00:00.000Z' });
    expect(seen[0].sql).toMatch(/m\.created_at\s*>=\s*\$2/);
    expect(seen[0].sql).toMatch(/m\.created_at\s*<\s*\$3/);
    expect(seen[0].params.slice(1, 3)).toEqual(['2026-11-01T00:00:00.000Z', '2026-11-08T00:00:00.000Z']);
  });

  it('несколько типов — одним ANY, один тип — равенством', async () => {
    const a = serviceWithSpy();
    await a.svc.getMovements({ movementTypes: ['receipt', 'return'] });
    expect(a.seen[0].sql).toMatch(/m\.movement_type\s*=\s*ANY\(\$1\)/);
    expect(a.seen[0].params[0]).toEqual(['receipt', 'return']);
    const b = serviceWithSpy();
    await b.svc.getMovements({ movementType: 'sale' });
    expect(b.seen[0].sql).toMatch(/m\.movement_type\s*=\s*\$1/);
  });

  it('поиск по товару и примечанию — параметром, спецсимволы LIKE экранированы', async () => {
    const { svc, seen } = serviceWithSpy();
    await svc.getMovements({ search: "100%_мука'" });
    expect(seen[0].sql).toMatch(/i\.name ILIKE \$1 OR m\.notes ILIKE \$1/);
    expect(seen[0].sql).not.toContain('мука');
    expect(seen[0].params[0]).toBe("%100\\%\\_мука'%");
  });

  it('limit и offset — последними параметрами', async () => {
    const { svc, seen } = serviceWithSpy();
    await svc.getMovements({ enterpriseId: 'e', limit: 50, offset: 100 });
    expect(seen[0].sql).toMatch(/LIMIT \$2 OFFSET \$3/);
    expect(seen[0].params).toEqual(['e', 50, 100]);
  });

  it('countMovements считает с теми же условиями', async () => {
    const { svc, seen } = serviceWithSpy();
    const n = await svc.countMovements({ enterpriseId: 'e', search: 'соль' });
    expect(n).toBe(42);
    expect(seen[0].sql).toMatch(/COUNT\(\*\)/);
    expect(seen[0].sql).toMatch(/m\.enterprise_id\s*=\s*\$1/);
    expect(seen[0].sql).toMatch(/i\.name ILIKE \$2/);
  });
});

describe('parseMovementQuery: разбор фильтров из адреса', () => {
  it('даты приводятся к ISO, мусор — 400', () => {
    const ok = parseMovementQuery({ dateFrom: '2026-11-01T00:00:00+03:00' });
    expect('filters' in ok && ok.filters.dateFrom).toBe('2026-10-31T21:00:00.000Z');
    expect(parseMovementQuery({ dateTo: 'вчера' })).toEqual({ error: 'dateTo: неверная дата' });
  });

  it('типы через запятую; посторонние символы в типе отвергаются', () => {
    const ok = parseMovementQuery({ movementType: 'receipt, return' });
    expect('filters' in ok && ok.filters.movementTypes).toEqual(['receipt', 'return']);
    expect(parseMovementQuery({ movementType: "receipt';--" })).toEqual({ error: 'movementType: неверный тип' });
  });

  it('limit ограничен 1..1000, offset не отрицательный', () => {
    const a = parseMovementQuery({ limit: '99999', offset: '-5' });
    expect('filters' in a && [a.filters.limit, a.filters.offset]).toEqual([1000, 0]);
    const b = parseMovementQuery({});
    expect('filters' in b && b.filters.limit).toBe(100);
  });

  it('id склада и товара — только UUID', () => {
    expect(parseMovementQuery({ warehouseId: '1 OR 1=1' })).toEqual({ error: 'warehouseId: неверный id' });
  });
});
