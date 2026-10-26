/**
 * Цена ингредиента во ВСЕХ путях, которыми её получает фронт.
 *
 * Цена заготовки без выпуска чинилась трижды, потому что путей три и
 * каждый считал по-своему: представление, getCostCalculation, и сами
 * строки состава (list + getById). Тест закрывает все запросы разом.
 */
import { TechCardService } from '../techcard.service';

const queries: { sql: string; params: any[] }[] = [];

jest.mock('pg', () => {
  class Pool {
    async query(sql: string, params: any[] = []) {
      queries.push({ sql, params });
      if (/FROM tech_card_ingredients/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [{ id: 'tc-1', output_quantity: '1' }], rowCount: 1 };
    }
    async connect() { return { query: this.query.bind(this), release() {} }; }
  }
  return { Pool, default: { Pool } };
});

function svc() { return new TechCardService('postgresql://test'); }
beforeEach(() => { queries.length = 0; });

/** Запросы, которые тянут состав техкарты для показа. */
function ingredientQueries() {
  return queries.filter(q => /tech_card_ingredients/.test(q.sql));
}

describe('Цена ингредиента берётся функцией БД во всех путях', () => {
  it('карточка одной техкарты (getById)', async () => {
    await svc().getById('tc-1');
    const q = ingredientQueries();
    expect(q.length).toBeGreaterThan(0);
    // Сырой ii.cost_price даёт 0 у заготовки, которую ещё не производили
    expect(q.every(x => /item_effective_cost/.test(x.sql))).toBe(true);
  });

  it('список техкарт (list)', async () => {
    await svc().list({ enterpriseId: 'ent-1' } as any);
    const withIngredients = queries.filter(q => /tech_card_ingredients/.test(q.sql));
    expect(withIngredients.length).toBeGreaterThan(0);
    expect(withIngredients.every(x => /item_effective_cost/.test(x.sql))).toBe(true);
  });

  it('расчёт себестоимости (getCostCalculation)', async () => {
    await svc().getCostCalculation('tc-1');
    const q = ingredientQueries();
    expect(q.length).toBeGreaterThan(0);
    // Именно поле расчёта, а не любое упоминание функции: getCostCalculation
    // зовёт getById, и его запрос дал бы ложное совпадение.
    expect(q.some(x => /item_effective_cost\([^)]*\)\s+AS\s+effective_cost_price/i.test(x.sql))).toBe(true);
  });

  it('ни один путь не отдаёт сырой ii.cost_price как цену ингредиента', async () => {
    const s = svc();
    await s.getById('tc-1');
    await s.list({ enterpriseId: 'ent-1' } as any);
    await s.getCostCalculation('tc-1');
    for (const q of ingredientQueries()) {
      // 'costPrice', ii.cost_price  или  ii.cost_price AS cost_price
      expect(q.sql).not.toMatch(/'costPrice',\s*ii\.cost_price/);
      expect(q.sql).not.toMatch(/ii\.cost_price\s+AS\s+cost_price/i);
    }
  });
});
