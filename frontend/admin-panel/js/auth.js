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
 * enterpriseRole — enterprise role: owner | admin | manager | operator | chef | waiter | employee | viewer
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
  restaurant:  { label: 'Ресторан',     emoji: '🍽' },
  cafe:        { label: 'Кафе',         emoji: '🥐' },
  coffee_shop: { label: 'Кофейня',      emoji: '☕' },
  production:  { label: 'Производство', emoji: '🏭' }
};

const MODULE_ACCESS = {
  'orders.html':        ['restaurant', 'cafe', 'coffee_shop'],
  'tables.html':        ['restaurant', 'cafe'],
  'hall-designer.html': ['restaurant'],
  'kds.html':           ['restaurant', 'cafe'],
  'loyalty.html':       ['restaurant', 'cafe', 'coffee_shop'],
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
