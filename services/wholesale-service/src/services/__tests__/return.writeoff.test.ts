/**
 * Возвраты: след в учёте склада.
 *
 * Возврат со списанием раньше не писал ничего в stock_movements — товар
 * утрачен, деньги клиенту вернули, а в движениях склада пусто. Потерю
 * нельзя было увидеть ни в отчёте, ни по себестоимости.
 */
import { WholesaleReturnService } from '../return.service';

const queries: { sql: string; params: any[] }[] = [];
let returnRow: any;
let items: any[] = [];

jest.mock('pg', () => {
  class Pool {
    async connect() {
      return {
        query: async (sql: string, params: any[] = []) => {
          queries.push({ sql, params });
          if (/FROM wholesale_returns/.test(sql)) return { rows: [returnRow], rowCount: 1 };
          if (/FROM wholesale_orders/.test(sql)) {
            return { rows: [{ id: 'o-1', warehouse_id: 'wh-1', invoice_number: 'СЧ-1' }], rowCount: 1 };
          }
          if (/FROM wholesale_return_items/.test(sql)) return { rows: items, rowCount: items.length };
          // контроль лимита возврата — считаем, что прошёл
          if (/UPDATE wholesale_order_items/.test(sql)) return { rows: [{}], rowCount: 1 };
          if (/UPDATE wholesale_returns/.test(sql)) return { rows: [{ id: 'r-1' }], rowCount: 1 };
          if (/doc_number|nextval|sequences/i.test(sql)) return { rows: [{ num: 1 }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        },
        release() {}
      };
    }
    async query(sql: string, params: any[] = []) {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }
  }
  return { Pool, default: { Pool } };
});

function svc() {
  // Сервис принимает готовый pool, а не строку подключения.
  const pool: any = {
    connect: async () => ({
      query: async (sql: string, params: any[] = []) => {
        queries.push({ sql, params });
        if (/FROM wholesale_returns/.test(sql)) return { rows: [returnRow], rowCount: 1 };
        if (/FROM wholesale_orders/.test(sql)) {
          return { rows: [{ id: 'o-1', warehouse_id: 'wh-1', invoice_number: 'СЧ-1' }], rowCount: 1 };
        }
        if (/FROM wholesale_return_items/.test(sql)) return { rows: items, rowCount: items.length };
        if (/UPDATE wholesale_order_items/.test(sql)) return { rows: [{}], rowCount: 1 };
        if (/UPDATE wholesale_returns/.test(sql)) return { rows: [{ id: 'r-1' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release() {}
    }),
    query: async (sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }
  };
  const s = new WholesaleReturnService(pool);
  // getById вызывается в конце confirm — подменяем, он не предмет теста
  (s as any).getById = async () => ({ id: 'r-1' });
  (s as any).nextDocNumber = async () => 'ВЗ-1';
  return s;
}

beforeEach(() => {
  queries.length = 0;
  returnRow = { id: 'r-1', order_id: 'o-1', enterprise_id: 'ent-1',
                counterparty_id: 'cp-1', status: 'draft', total_amount: '240' };
});

function movements() {
  return queries.filter(q => /INSERT INTO stock_movements/.test(q.sql));
}

describe('Возврат со списанием (write_off)', () => {
  it('пишет движение write_off — иначе потеря не видна в учёте', async () => {
    items = [{ id: 'ri-1', order_item_id: 'oi-1', inventory_item_id: 'it-1',
               quantity: '2', disposition: 'write_off',
               shipped_cost_price: '50', item_name: 'товар' }];

    await svc().confirm('r-1', 'u-1', 'ent-1');

    const mv = movements();
    expect(mv).toHaveLength(1);
    expect(mv[0].sql).toMatch(/'write_off'/);
    // себестоимость — та, по которой отгружали (числом, не строкой)
    expect(mv[0].params).toContain(50);
    expect(mv[0].params).toContain(2);
  });

  it('НЕ возвращает списанный товар на склад', async () => {
    items = [{ id: 'ri-1', order_item_id: 'oi-1', inventory_item_id: 'it-1',
               quantity: '2', disposition: 'write_off',
               shipped_cost_price: '50', item_name: 'товар' }];

    await svc().confirm('r-1', 'u-1', 'ent-1');

    // Товар ушёл со склада ещё при отгрузке: приход увёл бы остаток в плюс,
    // а повторное списание — в минус.
    expect(queries.some(q => /INSERT INTO inventory_stock/.test(q.sql))).toBe(false);
    expect(queries.some(q => /INSERT INTO inventory_batches/.test(q.sql))).toBe(false);
  });

  it('причина списания попадает в заметку движения', async () => {
    items = [{ id: 'ri-1', order_item_id: 'oi-1', inventory_item_id: 'it-1',
               quantity: '1', disposition: 'write_off', reason: 'бой при доставке',
               shipped_cost_price: '50', item_name: 'товар' }];

    await svc().confirm('r-1', 'u-1', 'ent-1');

    const note = movements()[0].params.find((p: any) => typeof p === 'string' && /Списание/.test(p));
    expect(note).toMatch(/бой при доставке/);
  });
});

describe('Возврат на склад (restock) не сломан', () => {
  it('пишет движение return и возвращает товар на остаток', async () => {
    items = [{ id: 'ri-1', order_item_id: 'oi-1', inventory_item_id: 'it-1',
               quantity: '3', disposition: 'restock',
               shipped_cost_price: '50', item_name: 'товар' }];

    await svc().confirm('r-1', 'u-1', 'ent-1');

    const mv = movements();
    expect(mv).toHaveLength(1);
    expect(mv[0].sql).toMatch(/'return'/);
    expect(queries.some(q => /INSERT INTO inventory_stock/.test(q.sql))).toBe(true);
    expect(queries.some(q => /INSERT INTO inventory_batches/.test(q.sql))).toBe(true);
  });

  it('смешанный возврат: часть на склад, часть в списание', async () => {
    items = [
      { id: 'ri-1', order_item_id: 'oi-1', inventory_item_id: 'it-1',
        quantity: '3', disposition: 'restock', shipped_cost_price: '50', item_name: 'A' },
      { id: 'ri-2', order_item_id: 'oi-2', inventory_item_id: 'it-2',
        quantity: '2', disposition: 'write_off', shipped_cost_price: '70', item_name: 'B' }
    ];

    await svc().confirm('r-1', 'u-1', 'ent-1');

    const mv = movements();
    expect(mv).toHaveLength(2);
    expect(mv.filter(m => /'return'/.test(m.sql))).toHaveLength(1);
    expect(mv.filter(m => /'write_off'/.test(m.sql))).toHaveLength(1);
    // на склад вернулась только годная часть
    expect(queries.filter(q => /INSERT INTO inventory_stock/.test(q.sql))).toHaveLength(1);
  });
});
