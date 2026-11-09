/**
 * Подписи типов заказа и каналы продаж по типу заведения.
 *
 * Зачем. В «Аналитике» у кофейни каналы были «Доставка / Зал / Самовывоз»:
 * список был зашит в странице. У кофейни доставки нет, а «Самовывоз» там
 * называется «На вынос». Правило теперь живёт в auth.js (AUTH.orderTypeLabel,
 * AUTH.salesChannels), и тест грузит НАСТОЯЩИЙ auth.js, а не копию правил —
 * копия могла бы разойтись с кодом и оставаться зелёной.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'auth.js'), 'utf8');

function loadAuth(businessType) {
  const store = {};
  if (businessType) store.ff_business_type = businessType;
  const ctx = {
    console,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    document: {
      readyState: 'complete',
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      addEventListener: () => {}
    },
    window: { location: { href: '', pathname: '/admin-panel/analytics.html', hostname: 'localhost' } },
    location: { href: '', pathname: '/admin-panel/analytics.html', hostname: 'localhost' },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    setTimeout, clearTimeout
  };
  vm.createContext(ctx);
  // const AUTH в контекст не попадает — достаём его явно
  vm.runInContext(SRC + '\n;this.__AUTH = AUTH;', ctx);
  return ctx.__AUTH;
}

describe('каналы продаж и подписи типов заказа', () => {
  it('кофейня: «Зал» и «На вынос», без доставки', () => {
    const A = loadAuth('coffee_shop');
    expect(A.salesChannels(false)).toEqual(['dine_in', 'pickup']);
    expect(A.salesChannels(false).map((k) => A.orderTypeLabel(k))).toEqual(['Зал', 'На вынос']);
  });

  it('кафе тоже без доставки — «На вынос»', () => {
    const A = loadAuth('cafe');
    expect(A.orderTypeLabel('pickup')).toBe('На вынос');
    expect(A.salesChannels(false)).not.toContain('delivery');
  });

  it('ресторан: «Доставка / Зал / Самовывоз»', () => {
    const A = loadAuth('restaurant');
    expect(A.salesChannels(false).map((k) => A.orderTypeLabel(k))).toEqual(['Доставка', 'Зал', 'Самовывоз']);
  });

  it('у кофейни с заказами доставки (агрегатор) канал доставки не теряется', () => {
    const A = loadAuth('coffee_shop');
    expect(A.salesChannels(true)).toEqual(['delivery', 'dine_in', 'pickup']);
  });

  it('тип заведения не выбран — полный набор, как раньше', () => {
    const A = loadAuth(null);
    expect(A.salesChannels(false)).toEqual(['delivery', 'dine_in', 'pickup']);
    expect(A.orderTypeLabel('pickup')).toBe('Самовывоз');
  });

  it('зал узнаётся во всех написаниях', () => {
    const A = loadAuth('coffee_shop');
    for (const t of ['dine_in', 'dine-in', 'dinein']) expect(A.orderTypeLabel(t)).toBe('Зал');
  });
});
