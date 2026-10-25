/**
 * FoodFlow Shared Auth Module — admin-panel copy
 * This file is identical in behaviour to /frontend/js/auth.js.
 * Exposed as window.AUTH for use in plain HTML pages (no bundler).
 *
 * Token storage keys:
 *   ff_token         — JWT access token
 *   ff_refresh_token — JWT refresh token
 *   ff_user          — JSON-serialised user object from /api/auth/login
 *
 * User object shape:
 *   { userId, email, role, enterpriseId, enterpriseRole, first_name?, last_name? }
 *
 * role          — global role: customer | restaurant_owner | delivery_driver | admin
 * enterpriseRole — enterprise role: owner | admin | manager | operator | chef | waiter | cashier | employee | viewer
 */

const AUTH = {
  // Фронт и API отдаются одним Kong — базовый URL берём из адресной строки,
  // чтобы работало и с localhost, и с телефона по IP в локальной сети
  API_BASE: window.location.origin,

  // ── Token & user accessors ────────────────────────────────────────────────

  getToken() {
    return localStorage.getItem('ff_token');
  },

  getUser() {
    const raw = localStorage.getItem('ff_user');
    return raw ? JSON.parse(raw) : null;
  },

  /**
   * Returns the effective role for UI decisions.
   * Uses enterpriseRole when present (staff member in an enterprise),
   * otherwise falls back to the global role.
   */
  getRole() {
    const user = this.getUser();
    if (!user) return null;
    return user.enterpriseRole || user.role || null;
  },

  isLoggedIn() {
    return !!this.getToken();
  },

  // ── Role helpers ──────────────────────────────────────────────────────────

  /**
   * Check whether the current user has at least one of the given roles.
   * Accepts a spread of strings or arrays.
   *
   * Global admin and restaurant_owner are always permitted.
   */
  hasRole(...roles) {
    const r = this.getRole();
    if (!r) return false;
    if (r === 'admin') return true;
    if (r === 'restaurant_owner') return true;
    return roles.flat().includes(r);
  },

  // ── Session management ────────────────────────────────────────────────────

  logout() {
    const refreshToken = localStorage.getItem('ff_refresh_token');

    // Fire-and-forget server-side invalidation; never block navigation on it
    if (refreshToken) {
      fetch(this.API_BASE + '/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken })
      }).catch(() => {});
    }

    localStorage.removeItem('ff_token');
    localStorage.removeItem('ff_refresh_token');
    localStorage.removeItem('ff_user');
    // Чистим тип заведения — иначе следующий вход на этом браузере
    // унаследует фильтрацию разделов от предыдущего предприятия
    localStorage.removeItem('ff_business_type');
    localStorage.removeItem('ff_enterprise');
    window.location.href = '/admin-panel/login.html';
  },

  /**
   * Call at the top of every protected page.
   * Redirects to login immediately if no access token is found.
   */
  requireAuth() {
    if (!this.isLoggedIn()) {
      window.location.href = '/admin-panel/login.html';
    }
  },

  // ── Authenticated fetch ───────────────────────────────────────────────────

  /**
   * Drop-in replacement for fetch() that:
   *   - Prepends API_BASE to relative URLs
   *   - Adds Authorization: Bearer <token> header
   *   - Attempts a silent token refresh on HTTP 401 and retries once
   *   - Redirects to login if the refresh also fails
   */
  async fetch(url, options = {}) {
    const fullUrl = url.startsWith('http') ? url : this.API_BASE + url;
    const token = this.getToken();

    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    let res = await window.fetch(fullUrl, { ...options, headers });

    if (res.status === 401) {
      try {
        const newToken = await this._refresh();
        headers['Authorization'] = 'Bearer ' + newToken;
        res = await window.fetch(fullUrl, { ...options, headers });
      } catch (_) {
        this.logout();
        throw new Error('Session expired');
      }
    }

    return res;
  },

  // ── Internal: token refresh ───────────────────────────────────────────────

  async _refresh() {
    const refreshToken = localStorage.getItem('ff_refresh_token');
    if (!refreshToken) throw new Error('No refresh token');

    const res = await window.fetch(this.API_BASE + '/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken })
    });

    if (!res.ok) {
      localStorage.removeItem('ff_token');
      localStorage.removeItem('ff_refresh_token');
      localStorage.removeItem('ff_user');
      throw new Error('Refresh failed');
    }

    const data = await res.json();
    // Accept both flat and nested token shapes
    const accessToken  = data.accessToken  || (data.tokens && data.tokens.accessToken);
    const newRefresh   = data.refreshToken || (data.tokens && data.tokens.refreshToken);
    if (accessToken)  localStorage.setItem('ff_token', accessToken);
    if (newRefresh)   localStorage.setItem('ff_refresh_token', newRefresh);
    return accessToken;
  }
};

// ── Тип заведения: какие разделы доступны ────────────────────────────────
// ресторан / кафе / кофейня / производство. Разделы, не указанные в карте,
// доступны всем типам.
const BUSINESS_TYPES = {
  // icon — содержимое <svg viewBox="0 0 24 24">, рисуется обводкой currentColor
  restaurant:  { label: 'Ресторан', tone: 'green',
                 icon: '<path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10"/><path d="M17 21V3c-2 1-3 4-3 8h3"/>' },
  cafe:        { label: 'Кафе', tone: 'green',
                 icon: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M6 12v8M18 12v8M9 4h6"/>' },
  coffee_shop: { label: 'Кофейня', tone: 'cream',
                 icon: '<path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 11h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 3v3M12 3v3"/>' },
  delivery:    { label: 'Доставка', tone: 'tomato',
                 icon: '<circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="M6 17l4-8h5l3 8M9 6h3"/>' },
  production:  { label: 'Производство', tone: 'yellow',
                 icon: '<path d="M3 21V10l5 3V10l5 3V10l5 3V4h3v17z"/><path d="M7 17h2M12 17h2"/>' }
};

// Цвета плашек — пары фон/текст с контрастом ≥4.5:1 на светлой теме
const BUSINESS_TONES = {
  green:  ['#E7F1E9', '#1F6B40'],
  cream:  ['#EFE8D6', '#4F4838'],
  tomato: ['#FBE9E3', '#B23F26'],
  yellow: ['#FBF3D6', '#7A6118']
};

const MODULE_ACCESS = {
  'pos.html':           ['restaurant', 'cafe', 'coffee_shop'],
  'orders.html':        ['restaurant', 'cafe', 'coffee_shop', 'delivery'],
  'tables.html':        ['restaurant', 'cafe'],
  'hall-designer.html': ['restaurant'],
  // Кофейне экран очереди нужен не меньше кухни: бариста готовит напитки
  // по очереди и отмечает готовность. Бэкенд (kitchen-service) заказы
  // кофейни обрабатывает и так — закрыт был только экран.
  'kds.html':           ['restaurant', 'cafe', 'coffee_shop', 'delivery'],
  'loyalty.html':       ['restaurant', 'cafe', 'coffee_shop', 'delivery'],
  'calls.html':         ['restaurant', 'cafe', 'delivery'],
  'wholesale.html':     ['production', 'restaurant']
};

AUTH.getBusinessType = function () {
  // Локальный выбор (демо/оверрайд) приоритетнее данных предприятия
  const local = localStorage.getItem('ff_business_type');
  if (local && BUSINESS_TYPES[local]) return local;
  try {
    const ent = JSON.parse(localStorage.getItem('ff_enterprise') || 'null');
    if (ent && BUSINESS_TYPES[ent.business_type]) return ent.business_type;
  } catch (e) { /* ignore */ }
  return null; // тип не выбран — показываем всё
};

AUTH.setBusinessType = async function (type) {
  if (!BUSINESS_TYPES[type]) throw new Error('Unknown business type: ' + type);
  localStorage.setItem('ff_business_type', type);
  const user = this.getUser();
  if (user && user.enterpriseId) {
    try {
      const res = await this.fetch('/api/enterprises/' + user.enterpriseId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_type: type })
      });
      const data = await res.json();
      if (data && data.enterprise) {
        localStorage.setItem('ff_enterprise', JSON.stringify(data.enterprise));
      }
    } catch (e) { console.warn('Failed to persist business type on enterprise', e); }
  }
  this.applyBusinessType();
};

// Best-effort: подтягивает предприятие в ff_enterprise, если его ещё нет.
// Нужен, чтобы свежий вход на другом устройстве подхватил серверный тип
// без локального ff_business_type. Тихо игнорирует ошибки сети/прав.
AUTH.hydrateEnterprise = async function () {
  if (localStorage.getItem('ff_enterprise')) return;
  const user = this.getUser();
  if (!user || !user.enterpriseId) return;
  try {
    const res = await this.fetch('/api/enterprises/' + user.enterpriseId);
    const data = await res.json();
    if (data && data.enterprise) {
      localStorage.setItem('ff_enterprise', JSON.stringify(data.enterprise));
      this.applyBusinessType();
    }
  } catch (e) { /* ignore — фильтрация всё равно работает по ff_business_type */ }
};

AUTH.applyBusinessType = function () {
  const type = this.getBusinessType();
  document.querySelectorAll('a.nav-item[href]').forEach((a) => {
    const page = (a.getAttribute('href') || '').split('/').pop();
    const allowed = MODULE_ACCESS[page];
    // Скрываем с !important — страничные стили задают display на .nav-item с !important
    if (!allowed || !type || allowed.includes(type)) {
      a.style.removeProperty('display');
    } else {
      a.style.setProperty('display', 'none', 'important');
    }
  });
  this.renderBusinessBadge(type);
};

// Плашка с типом заведения под логотипом: видно, под какой режим
// отфильтровано меню, и по клику можно сменить тип в настройках
AUTH.renderBusinessBadge = function (type) {
  const brand = document.querySelector('.sidebar .sidebar-brand');
  if (!brand) return;
  let badge = document.getElementById('sidebarBusinessType');
  const bt = type && BUSINESS_TYPES[type];
  if (!bt) { if (badge) badge.remove(); return; }
  if (!badge) {
    badge = document.createElement('a');
    badge.id = 'sidebarBusinessType';
    badge.href = '/admin-panel/settings.html#features';
    badge.title = 'Тип заведения — сменить в настройках';
    badge.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin:10px 24px 0;' +
      'padding:4px 10px;border-radius:8px;font-size:12px;font-weight:700;text-decoration:none;align-self:flex-start;';
    brand.insertAdjacentElement('afterend', badge);
  }
  const tone = BUSINESS_TONES[bt.tone] || BUSINESS_TONES.green;
  badge.style.background = tone[0];
  badge.style.color = tone[1];
  badge.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + bt.icon + '</svg>' +
    '<span>' + bt.label + '</span>';
};

// Прячем недоступные разделы сразу после отрисовки сайдбара,
// затем в фоне подтягиваем тип с сервера (для входа без локального override)
function initBusinessType() {
  AUTH.applyBusinessType();
  AUTH.hydrateEnterprise();
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initBusinessType);
} else {
  initBusinessType();
}
