import { posSaleSchema } from '../pos';

const valid = {
  saleId: '55555555-5555-4555-8555-555555555555',
  restaurantId: '22222222-2222-4222-8222-222222222222',
  registerId: '33333333-3333-4333-8333-333333333333',
  orderType: 'pickup',
  paymentMethod: 'cash',
  items: [
    {
      menuItemId: '77777777-7777-4777-8777-777777777777',
      quantity: 1,
      modifiers: [{ modifierId: '88888888-8888-4888-8888-888888888888' }],
    },
  ],
};

describe('схема POST /api/pos/sales', () => {
  it('принимает минимальную наличную продажу', () => {
    expect(posSaleSchema.validate(valid).error).toBeUndefined();
  });

  it('не принимает клиентские цены и названия модификаторов', () => {
    const body = structuredClone(valid);
    Object.assign(body.items[0].modifiers[0], { name: 'Подмена', priceAdjustment: -500 });
    expect(posSaleSchema.validate(body).error).toBeDefined();
  });

  it('для наличной оплаты требует registerId', () => {
    const body = structuredClone(valid);
    delete (body as Partial<typeof valid>).registerId;
    expect(posSaleSchema.validate(body).error).toBeDefined();
  });

  it('для карты разрешает продажу без денежной кассы', () => {
    const body = structuredClone(valid);
    delete (body as Partial<typeof valid>).registerId;
    expect(posSaleSchema.validate({ ...body, paymentMethod: 'card' }).error).toBeUndefined();
  });

  it('отклоняет пустой чек и дробное количество', () => {
    expect(posSaleSchema.validate({ ...valid, items: [] }).error).toBeDefined();
    const fractional = structuredClone(valid);
    fractional.items[0].quantity = 1.5;
    expect(posSaleSchema.validate(fractional).error).toBeDefined();
  });
});
