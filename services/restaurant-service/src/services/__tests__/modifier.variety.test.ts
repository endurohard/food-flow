/**
 * Модификатор «выбор сорта» (миграция 064): ингредиент техкарты + сорт.
 * Задаются только парой — половинка пары в базу не попадает, иначе CHECK
 * отверг бы запрос ошибкой, а не понятным «выбор снят».
 */
import { MenuService } from '../menu.service';
import { modifierSchema } from '../../routes/menu.routes';

jest.mock('pg', () => {
  const Pool = jest.fn().mockImplementation(() => ({ query: jest.fn(), connect: jest.fn(), end: jest.fn() }));
  return { __esModule: true, default: { Pool }, Pool };
});

const BEANS = '11111111-1111-4111-8111-111111111111';
function svc() {
  const s = new MenuService('postgresql://test');
  const calls: { sql: string; params: any[] }[] = [];
  (s as any).pool = { query: jest.fn(async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows: [{}], rowCount: 1 }; }) };
  return { s, calls };
}
const colVal = (sql: string, params: any[], col: string) => {
  const cols = /menu_item_modifiers \(([^)]*)\)/.exec(sql)![1].split(',').map((x) => x.trim());
  return params[cols.indexOf(col)];
};

describe('создание', () => {
  it('пара ингредиент+сорт пишется как есть, сорт без пробелов', async () => {
    const { s, calls } = svc();
    await s.createModifier('esp', { name: 'На Эфиопии', varietyItemId: BEANS, variety: ' Эфиопия ' }, 'e');
    expect(colVal(calls[0].sql, calls[0].params, 'variety_item_id')).toBe(BEANS);
    expect(colVal(calls[0].sql, calls[0].params, 'variety')).toBe('Эфиопия');
  });
  it('половинка пары — обе колонки NULL', async () => {
    for (const d of [{ varietyItemId: BEANS, variety: '  ' }, { variety: 'Эфиопия' }]) {
      const { s, calls } = svc();
      await s.createModifier('esp', { name: 'x', ...d }, 'e');
      expect(colVal(calls[0].sql, calls[0].params, 'variety_item_id')).toBeNull();
      expect(colVal(calls[0].sql, calls[0].params, 'variety')).toBeNull();
    }
  });
});

describe('изменение', () => {
  it('пустой сорт снимает выбор целиком', async () => {
    const { s, calls } = svc();
    await s.updateModifier('m', { varietyItemId: BEANS, variety: '' }, 'e');
    expect(calls[0].sql).toMatch(/variety_item_id = \$1, variety = \$2/);
    expect(calls[0].params.slice(0, 2)).toEqual([null, null]);
  });
  it('новая пара сохраняется', async () => {
    const { s, calls } = svc();
    await s.updateModifier('m', { varietyItemId: BEANS, variety: 'Колумбия' }, 'e');
    expect(calls[0].params.slice(0, 2)).toEqual([BEANS, 'Колумбия']);
  });
  it('без полей сорта — сорт не трогается', async () => {
    const { s, calls } = svc();
    await s.updateModifier('m', { name: 'Эспрессо' }, 'e');
    expect(calls[0].sql).not.toMatch(/variety/);
  });
});

it('ингредиент сорта — только своей организации', async () => {
  const s = new MenuService('postgresql://test');
  const q = jest.fn(async () => ({ rows: [], rowCount: 0 }));
  (s as any).pool = { query: q };
  const r = await s.modifierSourceBelongsTo({ varietyItemId: BEANS }, 'e');
  expect(r).toEqual({ ok: false, reason: 'Ингредиент для выбора сорта не найден в этом предприятии' });
  expect((q.mock.calls[0] as any[])[1]).toEqual([BEANS, 'e']);
});

it('схема принимает пару и отвергает кривой id и длинный сорт', () => {
  expect(modifierSchema.validate({ name: 'На Эфиопии', varietyItemId: BEANS, variety: 'Эфиопия' }).error).toBeUndefined();
  expect(modifierSchema.validate({ name: 'x', varietyItemId: 'bad', variety: 'Эфиопия' }).error).toBeDefined();
  expect(modifierSchema.validate({ name: 'x', varietyItemId: BEANS, variety: 'я'.repeat(101) }).error).toBeDefined();
});

describe('разрешения скидок у блюда', () => {
  const col = (c: any, name: string) => {
    const cols = /\(\s*([\s\S]*?)\s*\) VALUES/.exec(c.sql)![1].split(',').map((x: string) => x.trim());
    return c.params[cols.indexOf(name)];
  };
  it('создание: по умолчанию обе разрешены; поля задают каждую отдельно', async () => {
    for (const [given, loyalty, promo] of [
      [{}, true, true],
      [{ loyaltyDiscountAllowed: false }, false, true],
      [{ promoDiscountAllowed: false }, true, false],
      [{ noDiscount: true }, false, false],
      [{ noDiscount: true, loyaltyDiscountAllowed: true }, true, false],
      [{ loyaltyDiscountAllowed: 'false' }, true, true]
    ] as any[]) {
      const { s, calls } = svc();
      await s.createItem('r', { name: 'Табак', price: 100, ...given } as any, 'e');
      expect([col(calls[0], 'loyalty_discount_allowed'), col(calls[0], 'promo_discount_allowed')]).toEqual([loyalty, promo]);
    }
  });
  it('изменение пишет только переданные разрешения', async () => {
    const { s, calls } = svc();
    await s.updateItem('i', { promoDiscountAllowed: false } as any, 'e');
    expect(calls[0].sql).toMatch(/promo_discount_allowed = \$1/);
    expect(calls[0].sql).not.toMatch(/loyalty_discount_allowed/);
    expect(calls[0].params[0]).toBe(false);
    const b = svc();
    await b.s.updateItem('i', { loyaltyDiscountAllowed: true, promoDiscountAllowed: true } as any, 'e');
    expect(b.calls[0].sql).toMatch(/loyalty_discount_allowed = \$1, promo_discount_allowed = \$2/);
  });
});
