/**
 * Остатки по складам в списке позиций: только склады организации товара.
 * У inventory_stock нет своего тенанта — остаток, легший на чужой склад,
 * иначе показал бы владельцу название и количество на чужом складе.
 */
import { InventoryService } from '../inventory.service';

jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

it('by_warehouse ограничен складами той же организации, что и товар', async () => {
  const seen: string[] = [];
  const svc = new InventoryService('postgresql://test');
  (svc as any).pool = { query: async (sql: string) => { seen.push(sql); return { rows: [] }; } };
  await svc.listItems({ enterpriseId: 'e1' });
  const sql = seen.find((s) => /AS by_warehouse/.test(s))!;
  expect(sql).toMatch(/s2\.quantity <> 0 AND w2\.enterprise_id = i\.enterprise_id\) AS by_warehouse/);
});
