/**
 * Цена модификатора в заказе (POST /api/orders) — из меню, а не из запроса:
 * «На Эфиопии +50 ₽» нельзя пробить за 0 ₽, подменив priceAdjustment.
 */
import { OrderService, OrderError } from '../order.service';

const REST = 'rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr';
const ESP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const LATTE = 'llllllll-llll-4lll-8lll-llllllllllll';
const ETH = '99999999-9999-4999-8999-999999999999';

function makeSvc(mods: any[]) {
  const svc = new OrderService('postgres://unused', {} as any);
  const queries: { sql: string; params: any[] }[] = [];
  const client = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      if (/FROM menu_items WHERE id = ANY/.test(sql)) return { rows: [
        { id: ESP, name: 'Эспрессо', price: '120', restaurant_id: REST, category_id: null },
        { id: LATTE, name: 'Латте', price: '200', restaurant_id: 'other-rest', category_id: null }] };
      if (/FROM menu_item_modifiers/.test(sql)) {
        // мок уважает фильтр доступности из SQL
        const rows = mods.filter(m => params[0].includes(m.id) && (!/is_available = true/.test(sql) || m.is_available));
        return { rows };
      }
      if (/FROM restaurants r/.test(sql)) return { rows: [{ name: 'Кофейня', delivery_fee: '0' }] };
      if (/INSERT INTO orders/.test(sql)) return { rows: [{ id: 'ord', order_number: 'N' }] };
      if (/INSERT INTO order_items/.test(sql)) return { rows: [{ id: 'oi' }] };
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn()
  };
  (svc as any).pool = { connect: async () => client, query: client.query };
  return { svc, queries };
}
const MOD = { id: ETH, menu_item_id: ESP, name: 'На Эфиопии', price_adjustment: '50.00', is_available: true };
const order = (items: any[]) => ({ restaurantId: REST, orderType: 'pickup', items } as any);

it('доплата и название — из меню, подмена priceAdjustment не проходит', async () => {
  const { svc, queries } = makeSvc([MOD]);
  await svc.create(order([{ menuItemId: ESP, quantity: 2, modifiers: [{ modifierId: ETH, name: 'взлом', priceAdjustment: -120 }] }]));
  const oi = queries.find(q => /INSERT INTO order_items/.test(q.sql))!;
  expect(oi.params.slice(3, 5)).toEqual([170, 340]);
  const om = queries.find(q => /INSERT INTO order_item_modifiers/.test(q.sql))!;
  expect(om.params.slice(2)).toEqual(['На Эфиопии', 50]);
});

it('модификатор чужого блюда или выключенный — 400', async () => {
  for (const m of [{ ...MOD, menu_item_id: LATTE }, { ...MOD, is_available: false }]) {
    const { svc } = makeSvc([m]);
    const p = svc.create(order([{ menuItemId: ESP, quantity: 1, modifiers: [{ modifierId: ETH, name: 'x', priceAdjustment: 50 }] }]));
    await expect(p).rejects.toBeInstanceOf(OrderError);
    await expect(p).rejects.toMatchObject({ statusCode: 400 });
  }
});

it('блюдо другого заведения — 400', async () => {
  const { svc } = makeSvc([]);
  await expect(svc.create(order([{ menuItemId: LATTE, quantity: 1 }]))).rejects.toMatchObject({ statusCode: 400, message: 'Блюдо не из меню этого заведения' });
});
