/**
 * Фильтрация пунктов меню: тип заведения и права роли.
 *
 * Зачем этот тест. applyBusinessType скрывала пункты только по business_type,
 * а экраны «Организации» и «Супер-админ» работают исключительно у super_admin.
 * Владелец видел их в меню, открывал и получал пустой экран с «Ошибка
 * загрузки: HTTP 403» — эндпоинты под requireSuperAdmin ему недоступны по
 * праву, но меню об этом не знало. Мёртвый пункт в меню выглядит как
 * поломка системы.
 *
 * auth.js тянет за собой localStorage, fetch и DOM, поэтому здесь
 * тестируется выделенная логика решения «показывать ли пункт» — ровно те же
 * правила, что и в самой функции. При правке auth.js правила надо менять в
 * обоих местах; расхождение ловится последним тестом, который сверяет список
 * страниц super_admin с исходником.
 */
const fs = require('fs');
const path = require('path');

const AUTH_JS = path.join(__dirname, '..', 'auth.js');

/** Копия правил из AUTH.applyBusinessType: роль важнее типа заведения. */
const MODULE_ACCESS = {
  'pos.html': ['restaurant', 'cafe', 'coffee_shop'],
  'orders.html': ['restaurant', 'cafe', 'coffee_shop', 'delivery'],
  'tables.html': ['restaurant', 'cafe'],
  'hall-designer.html': ['restaurant'],
  'kds.html': ['restaurant', 'cafe', 'coffee_shop', 'delivery'],
  'loyalty.html': ['restaurant', 'cafe', 'coffee_shop', 'delivery'],
  'calls.html': ['restaurant', 'cafe', 'delivery'],
  'wholesale.html': ['production', 'restaurant']
};
const SUPER_ADMIN_PAGES = ['enterprises.html', 'super-admin.html'];
const FEATURE_PAGES = {
  'tables.html': 'tables',
  'hall-designer.html': 'tables',
  'kds.html': 'kds',
  'menu.html': 'menu',
  'inventory.html': 'inventory',
  'staff.html': 'staff',
  'loyalty.html': 'loyalty',
  'analytics.html': 'analytics',
  'calls.html': 'telephony'
};

function isVisible(page, { role, businessType, features = {} }) {
  if (SUPER_ADMIN_PAGES.includes(page) && role !== 'super_admin') return false;
  if (FEATURE_PAGES[page] && features[FEATURE_PAGES[page]] === false) return false;
  const allowed = MODULE_ACCESS[page];
  if (!allowed || !businessType) return true;
  return allowed.includes(businessType);
}

describe('экраны super_admin', () => {
  it.each(SUPER_ADMIN_PAGES)('%s скрыт у владельца предприятия', (page) => {
    expect(isVisible(page, { role: 'restaurant_owner', businessType: 'restaurant' })).toBe(false);
  });

  it.each(SUPER_ADMIN_PAGES)('%s скрыт у админа предприятия', (page) => {
    expect(isVisible(page, { role: 'admin', businessType: 'cafe' })).toBe(false);
  });

  it.each(SUPER_ADMIN_PAGES)('%s виден супер-администратору', (page) => {
    expect(isVisible(page, { role: 'super_admin', businessType: 'restaurant' })).toBe(true);
  });

  it('скрытие не зависит от типа заведения: роль решает первой', () => {
    for (const t of ['restaurant', 'cafe', 'coffee_shop', 'production', null]) {
      expect(isVisible('enterprises.html', { role: 'restaurant_owner', businessType: t })).toBe(false);
      expect(isVisible('enterprises.html', { role: 'super_admin', businessType: t })).toBe(true);
    }
  });

  it('без роли (сессия не загрузилась) пункт тоже скрыт, а не показан', () => {
    expect(isVisible('enterprises.html', { role: null, businessType: 'restaurant' })).toBe(false);
  });
});

describe('фильтрация по типу заведения не сломана', () => {
  it('кофейня не видит залы и дизайнер зала', () => {
    expect(isVisible('tables.html', { role: 'restaurant_owner', businessType: 'coffee_shop' })).toBe(false);
    expect(isVisible('hall-designer.html', { role: 'restaurant_owner', businessType: 'coffee_shop' })).toBe(false);
  });

  it('кофейня видит кассу, очередь и лояльность', () => {
    for (const p of ['pos.html', 'kds.html', 'loyalty.html']) {
      expect(isVisible(p, { role: 'restaurant_owner', businessType: 'coffee_shop' })).toBe(true);
    }
  });

  it('производство видит опт, ресторан тоже', () => {
    expect(isVisible('wholesale.html', { role: 'restaurant_owner', businessType: 'production' })).toBe(true);
    expect(isVisible('wholesale.html', { role: 'restaurant_owner', businessType: 'restaurant' })).toBe(true);
  });

  it('производство не видит залы', () => {
    expect(isVisible('tables.html', { role: 'restaurant_owner', businessType: 'production' })).toBe(false);
  });

  it('страница без правил видна всем', () => {
    expect(isVisible('inventory.html', { role: 'restaurant_owner', businessType: 'production' })).toBe(true);
  });

  it('тип не выбран — показываем всё, кроме экранов super_admin', () => {
    expect(isVisible('tables.html', { role: 'restaurant_owner', businessType: null })).toBe(true);
    expect(isVisible('enterprises.html', { role: 'restaurant_owner', businessType: null })).toBe(false);
  });
});

// «Кофейня 104» выключила «Кухню» в Настройки → Функционал, флаг kds:false
// лёг в enterprises.features, а пункт меню оставался: меню флаги не читало.
describe('переключатели «Функционал» прячут разделы', () => {
  const coffee104 = { kds: false, menu: true, staff: true, orders: true, tables: true,
    loyalty: true, printers: true, analytics: true, inventory: true, telephony: false };

  it('выключенная кухня скрыта у кофейни', () => {
    expect(isVisible('kds.html', { role: 'restaurant_owner', businessType: 'coffee_shop', features: coffee104 })).toBe(false);
  });

  it('включённые разделы кофейни остаются', () => {
    for (const p of ['pos.html', 'menu.html', 'inventory.html', 'loyalty.html', 'staff.html']) {
      expect(isVisible(p, { role: 'restaurant_owner', businessType: 'coffee_shop', features: coffee104 })).toBe(true);
    }
  });

  it('флаг не включает то, что закрыто типом заведения', () => {
    // tables:true у кофейни не возвращает столы
    expect(isVisible('tables.html', { role: 'restaurant_owner', businessType: 'coffee_shop', features: coffee104 })).toBe(false);
  });

  it('отсутствующий ключ раздел не прячет (старые организации без полного набора)', () => {
    const legacy = { pos: true, delivery: true, analytics: true, inventory: true };
    for (const p of ['kds.html', 'staff.html', 'menu.html', 'calls.html']) {
      expect(isVisible(p, { role: 'restaurant_owner', businessType: 'restaurant', features: legacy })).toBe(true);
    }
  });

  it('выключенные столы прячут и дизайнер зала', () => {
    expect(isVisible('hall-designer.html', { role: 'restaurant_owner', businessType: 'restaurant', features: { tables: false } })).toBe(false);
  });
});

describe('правила в тесте не разошлись с auth.js', () => {
  const src = fs.readFileSync(AUTH_JS, 'utf8');

  it('список страниц super_admin совпадает с исходником', () => {
    const m = /const SUPER_ADMIN_PAGES\s*=\s*\[([^\]]*)\]/.exec(src);
    expect(m).not.toBeNull();
    const fromSrc = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
    expect(fromSrc.sort()).toEqual([...SUPER_ADMIN_PAGES].sort());
  });

  it('проверка роли стоит ДО отбора по типу заведения', () => {
    const body = /AUTH\.applyBusinessType\s*=\s*function[\s\S]*?\n};/.exec(src);
    expect(body).not.toBeNull();
    const roleAt = body[0].indexOf('SUPER_ADMIN_PAGES.includes');
    const typeAt = body[0].indexOf('MODULE_ACCESS[page]');
    expect(roleAt).toBeGreaterThan(-1);
    // Если отбор по типу окажется раньше, пункт super_admin успеет
    // «разблокироваться» через removeProperty и снова станет видимым
    expect(roleAt).toBeLessThan(typeAt);
  });

  it('карта FEATURE_PAGES совпадает с исходником', () => {
    const m = /const FEATURE_PAGES\s*=\s*\{([\s\S]*?)\n\};/.exec(src);
    expect(m).not.toBeNull();
    const fromSrc = Object.fromEntries([...m[1].matchAll(/'([a-z0-9-]+\.html)'\s*:\s*'([a-z]+)'/g)].map((x) => [x[1], x[2]]));
    expect(fromSrc).toEqual(FEATURE_PAGES);
  });

  it('applyBusinessType проверяет флаг строго на false', () => {
    const body = /AUTH\.applyBusinessType\s*=\s*function[\s\S]*?\n};/.exec(src)[0];
    expect(body).toMatch(/features\[FEATURE_PAGES\[page\]\]\s*===\s*false/);
    expect(body).toMatch(/if \(!featureOff &&/);
  });

  it('hydrateEnterprise обновляет кэш, а не выходит при заполненном', () => {
    const body = /AUTH\.hydrateEnterprise\s*=\s*async function[\s\S]*?\n};/.exec(src)[0];
    expect(body).not.toMatch(/if \(localStorage\.getItem\('ff_enterprise'\)\) return/);
  });

  it('у страниц MODULE_ACCESS в auth.js те же ключи, что в тесте', () => {
    const m = /const MODULE_ACCESS\s*=\s*\{([\s\S]*?)\n\};/.exec(src);
    expect(m).not.toBeNull();
    const keys = [...m[1].matchAll(/'([a-z0-9-]+\.html)'\s*:/g)].map((x) => x[1]);
    expect(keys.sort()).toEqual(Object.keys(MODULE_ACCESS).sort());
  });
});
