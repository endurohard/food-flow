// ── Внешний вид блюда: фото или значок на цветной плашке ─────────────────
// Пока у блюда нет фото, вместо пустой картинки показываем значок.
// Набор значков и цветов совпадает с проверкой в restaurant-service
// (MENU_ITEM_ICONS / MENU_ITEM_ICON_COLORS в menu.routes.ts).
(function () {
  const ICONS = {
    pizza:  { label: 'Пицца',   svg: '<path d="M4 5c5-3 11-3 16 0L12 21z"/><path d="M5.6 8c4-2 8.8-2 12.8 0"/><circle cx="10" cy="11" r="1"/><circle cx="14" cy="13.5" r="1"/>' },
    burger: { label: 'Бургер',  svg: '<path d="M4 11a8 6 0 0 1 16 0z"/><path d="M3 14h18"/><path d="M4 17h16v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>' },
    roll:   { label: 'Роллы',   svg: '<ellipse cx="12" cy="9" rx="8" ry="3.5"/><path d="M4 9v6c0 2 3.6 3.5 8 3.5s8-1.5 8-3.5V9"/><ellipse cx="12" cy="9" rx="3" ry="1.3"/>' },
    soup:   { label: 'Суп',     svg: '<path d="M3 11h18a9 7 0 0 1-18 0z"/><path d="M9 4c-1 1 1 2 0 4M14 4c-1 1 1 2 0 4"/>' },
    salad:  { label: 'Салат',   svg: '<path d="M3 12h18a9 8 0 0 1-18 0z"/><path d="M8 12c0-3 2-5 4-6M12 12c1-3 4-4 6-4M7 9c-1-1-1-3 0-4"/>' },
    coffee: { label: 'Кофе',    svg: '<path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 11h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 3v3M12 3v3"/>' },
    cake:   { label: 'Десерт',  svg: '<path d="M4 20h16v-8H4z"/><path d="M4 15c2 1 4 1 5.3 0s3.4-1 5.4 0 3.3 1 5.3 0"/><path d="M12 12V8"/><path d="M12 5.5c-.8-.8 0-2 0-2s.8 1.2 0 2z"/>' },
    drink:  { label: 'Напиток', svg: '<path d="M7 4h10l-1.5 16h-7z"/><path d="M7.5 9h9"/><path d="M13 4l2-2"/>' }
  };
  // Блюдо без значка: тарелка с приборами
  const DEFAULT_SVG = '<circle cx="12" cy="12" r="6"/><path d="M3 4v6M3 7h0M21 4v16M19 4c-1 2-1 5 2 6"/>';

  // Пары фон/цвет значка, контраст ≥4.5:1
  const COLORS = {
    green:  { label: 'Зелёная',  bg: '#E7F1E9', fg: '#1F6B40' },
    tomato: { label: 'Томатная', bg: '#FBE9E3', fg: '#B23F26' },
    yellow: { label: 'Жёлтая',   bg: '#FBF3D6', fg: '#7A6118' },
    cream:  { label: 'Кремовая', bg: '#EFE8D6', fg: '#4F4838' }
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function iconSvg(key, size) {
    const svg = (ICONS[key] && ICONS[key].svg) || DEFAULT_SVG;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + svg + '</svg>';
  }

  // Заполняет контейнер целиком: фото с object-fit или значок по центру
  function visual(dish, opts) {
    const o = Object.assign({ iconSize: 56, radius: 0 }, opts || {});
    const r = o.radius ? 'border-radius:' + o.radius + 'px;' : '';
    if (dish.image) {
      return '<img src="' + esc(dish.image) + '" alt="' + esc(dish.name || '') + '" loading="lazy" ' +
        'style="width:100%;height:100%;object-fit:cover;display:block;' + r + '">';
    }
    const c = COLORS[dish.iconColor] || COLORS.green;
    return '<span style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;' +
      'background:' + c.bg + ';color:' + c.fg + ';' + r + '">' + iconSvg(dish.icon, o.iconSize) + '</span>';
  }

  window.FFDish = { ICONS, COLORS, iconSvg, visual };
})();
