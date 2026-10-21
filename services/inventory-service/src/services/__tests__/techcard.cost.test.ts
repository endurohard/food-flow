import { TechCardService } from '../techcard.service';

jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

jest.mock('pg', () => {
  const Pool = jest.fn().mockImplementation(() => ({
    connect: jest.fn(),
    query: jest.fn(),
    end: jest.fn()
  }));
  return { __esModule: true, default: { Pool }, Pool };
});

/**
 * Пул, отвечающий на два запроса getById: карточка и её ингредиенты.
 * avg_cost_price — средневзвешенная по остатку партий (считает SQL),
 * cost_price — цена последнего прихода из справочника.
 */
function makeService(card: any, ingredients: any[]) {
  const svc = new TechCardService('postgresql://test');
  (svc as any).pool = {
    query: jest.fn(async (sql: string) => {
      if (/FROM tech_card_ingredients/.test(sql)) {
        return { rows: ingredients, rowCount: ingredients.length };
      }
      return { rows: [card], rowCount: 1 };
    })
  };
  return svc;
}

const card = {
  id: 'tc-1',
  name: 'Сэндвич',
  menu_item_price: '125.00',
  output_quantity: '1'
};

describe('Себестоимость техкарты — источник цены', () => {
  it('берёт средневзвешенную по остатку, а не цену последней накладной', async () => {
    // Главная регрессия: на складе 10 кг по 100 и 10 кг по 300.
    // Последняя накладная — 300, но списываться будет по 100 (FIFO),
    // поэтому карточка обязана показать среднюю 200, а не 300.
    const svc = makeService(card, [
      { inventory_item_id: 'i-1', item_name: 'Тесто', quantity: '1',
        cold_loss_percent: '0', hot_loss_percent: '0', cost_price: '300', avg_cost_price: '200' }
    ]);

    const res = await svc.getCostCalculation('tc-1');

    expect(res.totalCost).toBe(200);
    expect(res.ingredients[0].unitPrice).toBe(200);
    expect(res.ingredients[0].priceSource).toBe('stock_avg');
  });

  it('без остатка на складе откатывается на справочную цену', async () => {
    // Иначе карточка нового блюда показала бы нулевую себестоимость
    // и фуд-кост 100% — хуже, чем приблизительная цифра.
    const svc = makeService(card, [
      { inventory_item_id: 'i-1', item_name: 'Тесто', quantity: '2',
        cold_loss_percent: '0', hot_loss_percent: '0', cost_price: '150', avg_cost_price: null }
    ]);

    const res = await svc.getCostCalculation('tc-1');

    expect(res.totalCost).toBe(300);
    expect(res.ingredients[0].priceSource).toBe('last_purchase');
  });

  it('нулевая средняя цена не считается отсутствием остатка', async () => {
    // Бесплатное сырьё (списание в ноль, подарок поставщика) — валидный
    // случай: 0 должен остаться 0, а не подменяться справочной ценой.
    const svc = makeService(card, [
      { inventory_item_id: 'i-1', item_name: 'Тесто', quantity: '1',
        cold_loss_percent: '0', hot_loss_percent: '0', cost_price: '999', avg_cost_price: '0' }
    ]);

    const res = await svc.getCostCalculation('tc-1');

    expect(res.totalCost).toBe(0);
    expect(res.ingredients[0].priceSource).toBe('stock_avg');
  });
});

describe('Себестоимость техкарты — расчёт', () => {
  it('потери не влияют на себестоимость: платим за брутто', async () => {
    // Ключевое изменение модели: quantity — это брутто, то, что взяли
    // со склада. Очистки и ужарка уже оплачены, они уменьшают только выход.
    const svc = makeService(card, [
      { inventory_item_id: 'i-1', item_name: 'Картофель', quantity: '1',
        cold_loss_percent: '20', hot_loss_percent: '0', cost_price: '0', avg_cost_price: '100' }
    ]);

    const res = await svc.getCostCalculation('tc-1');

    expect(res.totalCost).toBeCloseTo(100, 6);
  });

  it('холодные потери уменьшают нетто', async () => {
    // 1 кг картофеля, чистка 25% → нетто 0.75 кг
    const svc = makeService(card, [
      { inventory_item_id: 'i-1', item_name: 'Картофель', quantity: '1',
        cold_loss_percent: '25', hot_loss_percent: '0', cost_price: '0', avg_cost_price: '100' }
    ]);

    const res = await svc.getCostCalculation('tc-1');

    expect(res.ingredients[0].netQuantity).toBeCloseTo(0.75, 3);
    expect(res.ingredients[0].yieldQuantity).toBeCloseTo(0.75, 3);
  });

  it('горячие потери считаются от нетто, а не от брутто', async () => {
    // 1 кг → чистка 25% → нетто 0.75 → варка 10% → выход 0.675.
    // Если бы горячие считались от брутто, вышло бы 0.65 — это ошибка.
    const svc = makeService(card, [
      { inventory_item_id: 'i-1', item_name: 'Картофель', quantity: '1',
        cold_loss_percent: '25', hot_loss_percent: '10', cost_price: '0', avg_cost_price: '100' }
    ]);

    const res = await svc.getCostCalculation('tc-1');

    expect(res.ingredients[0].netQuantity).toBeCloseTo(0.75, 3);
    expect(res.ingredients[0].yieldQuantity).toBeCloseTo(0.675, 3);
  });

  it('без потерь брутто, нетто и выход совпадают', async () => {
    const svc = makeService(card, [
      { inventory_item_id: 'i-1', item_name: 'Сахар', quantity: '0.5',
        cold_loss_percent: '0', hot_loss_percent: '0', cost_price: '0', avg_cost_price: '80' }
    ]);

    const res = await svc.getCostCalculation('tc-1');
    const ing = res.ingredients[0];

    expect(ing.grossQuantity).toBe(0.5);
    expect(ing.netQuantity).toBe(0.5);
    expect(ing.yieldQuantity).toBe(0.5);
  });

  it('итоги по массе суммируются по всем ингредиентам', async () => {
    const svc = makeService(card, [
      { inventory_item_id: 'i-1', item_name: 'Мясо', quantity: '1',
        cold_loss_percent: '10', hot_loss_percent: '20', cost_price: '0', avg_cost_price: '500' },
      { inventory_item_id: 'i-2', item_name: 'Лук', quantity: '0.2',
        cold_loss_percent: '15', hot_loss_percent: '0', cost_price: '0', avg_cost_price: '50' }
    ]);

    const res = await svc.getCostCalculation('tc-1');

    // брутто 1.2; нетто 0.9 + 0.17 = 1.07; выход 0.72 + 0.17 = 0.89
    expect(res.totalGross).toBeCloseTo(1.2, 3);
    expect(res.totalNet).toBeCloseTo(1.07, 3);
    expect(res.totalYield).toBeCloseTo(0.89, 3);
  });

  it('складывает все ингредиенты', async () => {
    const svc = makeService(card, [
      { inventory_item_id: 'i-1', item_name: 'Тесто', quantity: '0.3',
        cold_loss_percent: '0', hot_loss_percent: '0', cost_price: '0', avg_cost_price: '100' },
      { inventory_item_id: 'i-2', item_name: 'Сыр', quantity: '0.15',
        cold_loss_percent: '0', hot_loss_percent: '0', cost_price: '0', avg_cost_price: '600' },
      { inventory_item_id: 'i-3', item_name: 'Соус', quantity: '0.1',
        cold_loss_percent: '0', hot_loss_percent: '0', cost_price: '0', avg_cost_price: '200' }
    ]);

    const res = await svc.getCostCalculation('tc-1');

    // 30 + 90 + 20
    expect(res.totalCost).toBeCloseTo(140, 6);
  });

  it('себестоимость единицы делится на объём выпуска (чаша соуса)', async () => {
    // Варим 3 литра за цикл: себестоимость литра — треть от стоимости сырья
    const svc = makeService(
      { ...card, menu_item_price: null, output_quantity: '3' },
      [{ inventory_item_id: 'i-1', item_name: 'Томаты', quantity: '6',
         cold_loss_percent: '0', hot_loss_percent: '0', cost_price: '0', avg_cost_price: '60' }]
    );

    const res = await svc.getCostCalculation('tc-1');

    expect(res.totalCost).toBeCloseTo(360, 6);
    expect(res.unitCost).toBe(120);
  });

  it('маржа считается от цены продажи', async () => {
    const svc = makeService(
      { ...card, menu_item_price: '200' },
      [{ inventory_item_id: 'i-1', item_name: 'Сырьё', quantity: '1',
         cold_loss_percent: '0', hot_loss_percent: '0', cost_price: '0', avg_cost_price: '50' }]
    );

    const res = await svc.getCostCalculation('tc-1');

    // (200 - 50) / 200 = 75%
    expect(res.margin).toBe(75);
  });

  it('без цены продажи маржа не выдумывается', async () => {
    const svc = makeService(
      { ...card, menu_item_price: null },
      [{ inventory_item_id: 'i-1', item_name: 'Сырьё', quantity: '1',
         cold_loss_percent: '0', hot_loss_percent: '0', cost_price: '0', avg_cost_price: '50' }]
    );

    const res = await svc.getCostCalculation('tc-1');

    expect(res.margin).toBe(0);
    expect(res.menuPrice).toBe(0);
  });

  it('техкарта без ингредиентов даёт нулевую себестоимость, а не падает', async () => {
    const svc = makeService(card, []);

    const res = await svc.getCostCalculation('tc-1');

    expect(res.totalCost).toBe(0);
    expect(res.ingredients).toEqual([]);
  });
});
