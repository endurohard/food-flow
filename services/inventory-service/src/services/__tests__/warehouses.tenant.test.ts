/**
 * listWarehousesByEnterprise — отбор складов по тенанту на уровне SQL.
 *
 * Зачем отдельно от теста роута. В тесте роута сервис подменён моком, который
 * фильтрует по enterprise_id сам, — поэтому мутация, убирающая условие из
 * SQL (`w.enterprise_id = $1` → `$1 IS NOT NULL`), там не ловится: параметр на
 * месте, отбора нет, тесты зелёные. Утечка чужих складов в выдачу — ровно та
 * авария, которую закрывала миграция 045, поэтому условие проверяется в самом
 * тексте запроса.
 */
import { InventoryService } from '../inventory.service';

describe('listWarehousesByEnterprise: SQL отбирает по предприятию', () => {
  function serviceWithSpy() {
    const seen: Array<{ sql: string; params: any[] }> = [];
    // Конструктор принимает СТРОКУ подключения и создаёт Pool сам, поэтому
    // передать фейковый pool аргументом нельзя — подменяем приватное поле
    // после создания. Иначе запрос уходит в настоящий pg и падает на разборе
    // строки подключения, а падение читается как провал проверки.
    const svc = new InventoryService('postgres://u:p@localhost:5432/db');
    (svc as any).pool = {
      query: (sql: string, params: any[]) => {
        seen.push({ sql, params });
        return Promise.resolve({ rows: [] });
      }
    };
    return { svc, seen };
  }

  it('условие по enterprise_id присутствует в запросе, а не только параметр', async () => {
    const { svc, seen } = serviceWithSpy();
    await svc.listWarehousesByEnterprise('ent-own');
    const { sql, params } = seen[0];
    // Проверяем САМО условие: наличие параметра проходит и при `$1 IS NOT NULL`
    expect(sql).toMatch(/w\.enterprise_id\s*=\s*\$1/);
    expect(params).toEqual(['ent-own']);
  });

  it('отбираются только активные склады', async () => {
    const { svc, seen } = serviceWithSpy();
    await svc.listWarehousesByEnterprise('ent-own');
    expect(seen[0].sql).toMatch(/w\.is_active\s*=\s*true/);
  });

  it('запрос не фильтрует по точке: экран склада грузит склады предприятия целиком', async () => {
    const { svc, seen } = serviceWithSpy();
    await svc.listWarehousesByEnterprise('ent-own');
    expect(seen[0].sql).not.toMatch(/restaurant_id/);
  });
});
