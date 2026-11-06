import { PosSaleError, PosSaleService } from '../pos-sale.service';

const IDS = {
  enterprise: '11111111-1111-4111-8111-111111111111',
  restaurant: '22222222-2222-4222-8222-222222222222',
  register: '33333333-3333-4333-8333-333333333333',
  user: '44444444-4444-4444-8444-444444444444',
  sale: '55555555-5555-4555-8555-555555555555',
  order: '66666666-6666-4666-8666-666666666666',
  item: '77777777-7777-4777-8777-777777777777',
  modifier: '88888888-8888-4888-8888-888888888888',
  orderItem: '99999999-9999-4999-8999-999999999999',
  payment: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  cashOperation: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};

const request = {
  saleId: IDS.sale,
  restaurantId: IDS.restaurant,
  registerId: IDS.register,
  orderType: 'pickup' as const,
  paymentMethod: 'cash' as const,
  items: [
    {
      menuItemId: IDS.item,
      quantity: 2,
      modifiers: [{ modifierId: IDS.modifier }],
    },
  ],
};

function makeClient(
  options: {
    claimed?: boolean;
    existing?: any;
    itemAvailable?: boolean;
    modifierAvailable?: boolean;
    checkOpen?: boolean;
  } = {}
) {
  const queries: Array<{ sql: string; params: any[] }> = [];
  const claimed = options.claimed !== false;
  return {
    queries,
    release: jest.fn(),
    query: jest.fn(async (sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      if (/INSERT INTO pos_sales/.test(sql)) {
        return { rows: claimed ? [{ sale_id: IDS.sale }] : [], rowCount: claimed ? 1 : 0 };
      }
      if (/FROM pos_sales/.test(sql)) {
        return {
          rows: options.existing ? [options.existing] : [],
          rowCount: options.existing ? 1 : 0,
        };
      }
      if (/UPDATE pos_open_checks/.test(sql)) {
        const ok = options.checkOpen !== false;
        return { rows: ok ? [{ id: 'check-1' }] : [], rowCount: ok ? 1 : 0 };
      }
      if (/FROM restaurants/.test(sql)) {
        return { rows: [{ id: IDS.restaurant, name: 'Точка' }], rowCount: 1 };
      }
      if (/FROM menu_items/.test(sql)) {
        const rows =
          options.itemAvailable === false
            ? []
            : [
                {
                  id: IDS.item,
                  name: 'Плов',
                  price: '450.00',
                  category_id: null,
                },
              ];
        return { rows, rowCount: rows.length };
      }
      if (/FROM menu_item_modifiers/.test(sql)) {
        const rows =
          options.modifierAvailable === false
            ? []
            : [
                {
                  id: IDS.modifier,
                  menu_item_id: IDS.item,
                  name: 'Добавка',
                  price_adjustment: '50.00',
                },
              ];
        return { rows, rowCount: rows.length };
      }
      if (/FROM cash_registers/.test(sql)) {
        return { rows: [{ id: IDS.register }], rowCount: 1 };
      }
      if (/INSERT INTO orders/.test(sql)) {
        return {
          rows: [{ id: IDS.order, order_number: 'POS-1', status: 'completed', total: '1000.00' }],
          rowCount: 1,
        };
      }
      if (/INSERT INTO order_items/.test(sql)) {
        return { rows: [{ id: IDS.orderItem }], rowCount: 1 };
      }
      if (/INSERT INTO payments/.test(sql)) {
        return { rows: [{ id: IDS.payment }], rowCount: 1 };
      }
      if (/INSERT INTO cash_operations/.test(sql)) {
        return { rows: [{ id: IDS.cashOperation }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
}

function makeService(client: any) {
  const pool = { connect: jest.fn(async () => client) };
  const outbox = {
    enqueue: jest.fn(async () => undefined),
    drainOnce: jest.fn(async () => ({ sent: 1, failed: 0 })),
  };
  const afterCommit = jest.fn(async () => undefined);
  return {
    service: new PosSaleService(pool as any, outbox as any, afterCommit),
    outbox,
    afterCommit,
  };
}

describe('PosSaleService — атомарная продажа', () => {
  it('создаёт заказ, платёж и наличную операцию в одной транзакции по серверным ценам', async () => {
    const client = makeClient();
    const { service, outbox, afterCommit } = makeService(client);

    const result = await service.create(request, IDS.enterprise, IDS.user);

    expect(result.replayed).toBe(false);
    expect(result.orderId).toBe(IDS.order);
    expect(result.total).toBe(1000);

    const sql = client.queries.map((q: any) => q.sql).join('\n');
    expect(sql).toMatch(/BEGIN/);
    expect(sql).toMatch(/mi\.restaurant_id = \$2/);
    expect(sql).toMatch(/mi\.enterprise_id = \$3/);
    expect(sql).toMatch(/mi\.is_available = true/);
    expect(sql).toMatch(/stop_until < NOW\(\)/);
    expect(sql).toMatch(/INSERT INTO payments/);
    expect(sql).toMatch(/INSERT INTO cash_operations/);
    expect(sql).toMatch(/UPDATE cash_registers SET current_balance = current_balance \+ \$1/);
    expect(sql).toMatch(/UPDATE pos_sales/);
    expect(client.queries.at(-1)?.sql).toBe('COMMIT');
    expect(outbox.enqueue).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ routingKey: 'order.completed' })
    );
    expect(afterCommit).toHaveBeenCalledWith(expect.objectContaining({ id: IDS.order }));
  });

  it('пишет payment_status из enum payment_status, а не «paid»', async () => {
    // На проде продажа падала 500: invalid input value for enum payment_status: "paid"
    const PAYMENT_STATUS = ['pending', 'processing', 'completed', 'failed', 'refunded'];
    const client = makeClient();
    const { service } = makeService(client);
    await service.create(request, IDS.enterprise, IDS.user);
    const ins = client.queries.find((q: any) => /INSERT INTO orders/.test(q.sql))!.sql;
    const cols = /INSERT INTO orders\s*\(([^)]*)\)/.exec(ins)![1].split(',').map((c: string) => c.trim());
    // Между VALUES и RETURNING; NOW() без запятых, так что split по запятой безопасен
    const valsRaw = ins.slice(ins.indexOf('VALUES') + 6, ins.indexOf('RETURNING')).trim();
    const vals = valsRaw.slice(1, -1).split(',').map((v: string) => v.trim());
    expect(vals).toHaveLength(cols.length);
    const v = vals[cols.indexOf('payment_status')];
    expect(PAYMENT_STATUS).toContain(v.replace(/'/g, ''));
  });

  it('оплата отложенного чека закрывает его в той же транзакции', async () => {
    const client = makeClient();
    const { service } = makeService(client);
    await service.create({ ...request, openCheckId: 'check-1' }, IDS.enterprise, IDS.user);
    const i = client.queries.findIndex((q: any) => /UPDATE pos_open_checks/.test(q.sql));
    const upd = client.queries[i];
    expect(upd.sql).toMatch(/enterprise_id = \$4 AND restaurant_id = \$5 AND status = 'open'/);
    expect(upd.params).toEqual([IDS.sale, IDS.user, 'check-1', IDS.enterprise, IDS.restaurant]);
    const begin = client.queries.findIndex((q: any) => q.sql === 'BEGIN');
    const order = client.queries.findIndex((q: any) => /INSERT INTO orders/.test(q.sql));
    expect(begin).toBeLessThan(i);
    expect(i).toBeLessThan(order);
    expect(client.queries.at(-1)?.sql).toBe('COMMIT');
  });

  it('уже оплаченный/чужой чек — 409 и откат, заказ не создаётся', async () => {
    const client = makeClient({ checkOpen: false });
    const { service } = makeService(client);
    await expect(
      service.create({ ...request, openCheckId: 'check-1' }, IDS.enterprise, IDS.user)
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(client.queries.some((q: any) => /INSERT INTO orders/.test(q.sql))).toBe(false);
    expect(client.queries.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('продажа без чека не трогает pos_open_checks', async () => {
    const client = makeClient();
    const { service } = makeService(client);
    await service.create(request, IDS.enterprise, IDS.user);
    expect(client.queries.some((q: any) => /pos_open_checks/.test(q.sql))).toBe(false);
  });

  it('повтор с тем же saleId возвращает сохранённый результат без новых записей', async () => {
    const response = {
      orderId: IDS.order,
      orderNumber: 'POS-1',
      paymentId: IDS.payment,
      total: 1000,
    };
    const client = makeClient({
      claimed: false,
      existing: { request_hash: 'same-hash', status: 'completed', response_data: response },
    });
    const { service, outbox } = makeService(client);
    jest.spyOn(service as any, 'requestHash').mockReturnValue('same-hash');

    const result = await service.create(request, IDS.enterprise, IDS.user);

    expect(result).toEqual({ ...response, replayed: true });
    expect(client.queries.some((q: any) => /INSERT INTO orders/.test(q.sql))).toBe(false);
    expect(client.queries.at(-1)?.sql).toBe('COMMIT');
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('не позволяет повторно использовать saleId с другим содержимым', async () => {
    const client = makeClient({
      claimed: false,
      existing: { request_hash: 'old-hash', status: 'completed', response_data: {} },
    });
    const { service } = makeService(client);
    jest.spyOn(service as any, 'requestHash').mockReturnValue('new-hash');

    await expect(service.create(request, IDS.enterprise, IDS.user)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(client.queries.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('отклоняет недоступную или чужую позицию до создания заказа', async () => {
    const client = makeClient({ itemAvailable: false });
    const { service } = makeService(client);

    await expect(service.create(request, IDS.enterprise, IDS.user)).rejects.toEqual(
      expect.any(PosSaleError)
    );
    expect(client.queries.some((q: any) => /INSERT INTO orders/.test(q.sql))).toBe(false);
    expect(client.queries.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('отклоняет модификатор, который недоступен или не принадлежит блюду', async () => {
    const client = makeClient({ modifierAvailable: false });
    const { service } = makeService(client);

    await expect(service.create(request, IDS.enterprise, IDS.user)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(client.queries.some((q: any) => /INSERT INTO orders/.test(q.sql))).toBe(false);
  });

  it('для наличной продажи требует открытую кассу своего ресторана', async () => {
    const client = makeClient();
    client.query.mockImplementation(async (sql: string, params: any[] = []) => {
      client.queries.push({ sql, params });
      if (/INSERT INTO pos_sales/.test(sql)) return { rows: [{ sale_id: IDS.sale }], rowCount: 1 };
      if (/FROM restaurants/.test(sql)) return { rows: [{ id: IDS.restaurant }], rowCount: 1 };
      if (/FROM menu_items/.test(sql))
        return {
          rows: [{ id: IDS.item, name: 'Плов', price: '450.00', category_id: null }],
          rowCount: 1,
        };
      if (/FROM menu_item_modifiers/.test(sql))
        return {
          rows: [
            {
              id: IDS.modifier,
              menu_item_id: IDS.item,
              name: 'Добавка',
              price_adjustment: '50.00',
            },
          ],
          rowCount: 1,
        };
      if (/FROM cash_registers/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const { service } = makeService(client);

    await expect(service.create(request, IDS.enterprise, IDS.user)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(client.queries.some((q: any) => /INSERT INTO orders/.test(q.sql))).toBe(false);
  });
});
