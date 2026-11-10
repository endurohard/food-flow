/**
 * Себестоимость техкарты — по складу, с которого блюдо списывается.
 *
 * Зачем. Средняя цена остатка считалась по всем складам предприятия, а
 * продажа списывает с основного склада заведения блюда. При двух точках
 * (или отдельном складе бара) фуд-кост в карточке расходился с фактическим
 * списанием. Теперь склад определяется так же, как в order-service, и если
 * на нём партий нет — берётся цена последнего прихода, как при FIFO.
 */
import { TechCardService } from '../techcard.service';

const queries: { sql: string; params: any[] }[] = [];
let rows: (sql: string, params: any[]) => any[] = () => [];

jest.mock('pg', () => {
  class Pool {
    async query(sql: string, params: any[] = []) {
      queries.push({ sql, params });
      const r = rows(sql, params);
      return { rows: r, rowCount: r.length };
    }
    async connect() { return { query: this.query.bind(this), release() {} }; }
  }
  return { Pool, default: { Pool } };
});

const svc = () => new TechCardService('postgresql://test');
beforeEach(() => { queries.length = 0; rows = () => []; });

const CARD = { id: 'tc-1', menu_item_id: 'mi-1', menu_item_price: '500', output_quantity: '1' };
const ING = (over: any) => ({ inventory_item_id: 'flour', item_name: 'Мука', quantity: '0.2',
  cold_loss_percent: 0, hot_loss_percent: 0, cost_price: '40', effective_cost_price: '40', ...over });

describe('склад для себестоимости', () => {
  it('без параметра — основной склад заведения блюда', async () => {
    rows = (sql) => /FROM tech_cards tc\s+JOIN menu_items/.test(sql) ? [{ id: 'wh-main', name: 'Кухня' }] : [];
    const wh = await svc().resolveCostWarehouse('tc-1', 'ent');
    expect(wh).toEqual({ id: 'wh-main', name: 'Кухня' });
    const q = queries[0].sql;
    expect(q).toMatch(/w\.restaurant_id = mi\.restaurant_id/);
    expect(q).toMatch(/ORDER BY \(w\.warehouse_type = 'main'\) DESC/);
  });

  it('явный склад проверяется на принадлежность предприятию', async () => {
    await svc().resolveCostWarehouse('tc-1', 'ent', 'wh-x');
    expect(queries[0].sql).toMatch(/enterprise_id = \$2/);
    expect(queries[0].params).toEqual(['wh-x', 'ent']);
  });

  it('чужой склад — расчёта нет (404), а не расчёт по чужим ценам', async () => {
    expect(await svc().getCostCalculation('tc-1', 'ent', 'wh-alien')).toBeNull();
  });
});

describe('цена ингредиента по складу', () => {
  function setup(ing: any) {
    rows = (sql) => {
      if (/JOIN menu_items mi ON mi\.id = tc\.menu_item_id/.test(sql)) return [{ id: 'wh-main', name: 'Кухня' }];
      if (/FROM tech_card_ingredients/.test(sql)) return [ing];
      if (/FROM tech_cards tc/.test(sql)) return [CARD];
      return [];
    };
  }

  it('средняя считается по партиям только этого склада', async () => {
    setup(ING({ avg_cost_price: '55', last_purchase_price: '70' }));
    const c = await svc().getCostCalculation('tc-1', 'ent');
    const q = queries.find((x) => /FROM tech_card_ingredients/.test(x.sql))!;
    expect(q.sql).toMatch(/b\.warehouse_id = \$2::uuid/);
    expect(q.params).toEqual(['tc-1', 'wh-main']);
    expect(c.ingredients[0].unitPrice).toBe(55);
    expect(c.ingredients[0].priceSource).toBe('stock_avg');
    expect(c).toMatchObject({ warehouseId: 'wh-main', warehouseName: 'Кухня', priceScope: 'warehouse' });
  });

  it('на складе партий нет — цена последнего прихода, а не средняя чужих складов', async () => {
    // cost_price здесь = item_effective_cost = средняя по ВСЕМ складам (40)
    setup(ING({ avg_cost_price: null, last_purchase_price: '70', cost_price: '40' }));
    const c = await svc().getCostCalculation('tc-1', 'ent');
    expect(c.ingredients[0].unitPrice).toBe(70);
    expect(c.ingredients[0].priceSource).toBe('last_purchase');
    expect(c.totalCost).toBeCloseTo(14);
  });

  it('склад не определить — как раньше, по всему предприятию', async () => {
    rows = (sql) => {
      if (/FROM tech_card_ingredients/.test(sql)) return [ING({ avg_cost_price: null, last_purchase_price: '70', cost_price: '40' })];
      if (/FROM tech_cards tc/.test(sql) && !/JOIN menu_items mi ON mi\.id/.test(sql)) return [CARD];
      return [];
    };
    const c = await svc().getCostCalculation('tc-1', 'ent');
    const q = queries.find((x) => /FROM tech_card_ingredients/.test(x.sql))!;
    expect(q.params).toEqual(['tc-1', null]);
    expect(c.ingredients[0].unitPrice).toBe(40);
    expect(c.priceScope).toBe('enterprise');
  });
});
