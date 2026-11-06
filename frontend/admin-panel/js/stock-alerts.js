/**
 * Колокольчик «Пора заказать» в шапке админки.
 *
 * Показывает позиции, у которых остаток на складе дошёл до минимального
 * (GET /api/inventory/stock-alerts). Занимает красную кнопку «Предупреждения»
 * в шапке, а где её нет — добавляет свою в .topbar-right. Предупреждение
 * исчезает само, когда остаток пополнят выше минимума.
 */
(function () {
  // auth.js объявляет `const AUTH` — это глобальная привязка, но НЕ window.AUTH
  if (typeof AUTH === 'undefined' || !AUTH.isLoggedIn()) return;

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => {
    const n = Number(v);
    return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, '');
  };

  const ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M10 2a5 5 0 00-5 5v3l-1.5 3h13L15 10V7a5 5 0 00-5-5z"/><path d="M8 16a2 2 0 004 0"/></svg>';

  let btn, badge, panel, alerts = [];

  function mount() {
    const right = document.querySelector('.topbar-right');
    if (!right) return false;
    btn = right.querySelector('.notif-btn.red');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'notif-btn red';
      btn.style.cssText = 'position:relative;width:40px;height:40px;border-radius:10px;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;background:var(--color-danger-light,#fde8e8);color:var(--color-danger,#e53e3e);';
      right.insertBefore(btn, right.firstChild);
    }
    btn.type = 'button';
    btn.title = 'Пора заказать';
    btn.innerHTML = ICON + '<span class="notif-count red" style="display:none;"></span>';
    const svg = btn.querySelector('svg');
    svg.style.width = '20px'; svg.style.height = '20px';
    badge = btn.querySelector('.notif-count');
    if (getComputedStyle(badge).position === 'static') {
      badge.style.cssText += 'position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;padding:0 4px;border-radius:9px;font-size:11px;line-height:18px;color:#fff;background:var(--color-danger,#e53e3e);';
    }
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    document.addEventListener('click', (e) => { if (panel && !panel.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    return true;
  }

  function render() {
    badge.textContent = alerts.length > 99 ? '99+' : String(alerts.length);
    badge.style.display = alerts.length ? '' : 'none';
    btn.title = alerts.length ? 'Пора заказать: ' + alerts.length : 'Склад: всё в норме';
    if (panel) fill();
  }

  function fill() {
    const list = alerts.length
      ? alerts.map((a) => `
          <a href="/admin-panel/inventory.html" style="display:block;padding:10px 14px;border-top:1px solid var(--admin-border,#eee);color:inherit;text-decoration:none;">
            <div style="font-weight:600;">${esc(a.name)}</div>
            <div style="font-size:13px;color:var(--color-text-secondary,#666);">
              осталось <b style="color:var(--color-danger,#e53e3e);">${num(a.quantity != null ? a.quantity : a.alert_quantity)} ${esc(a.unit || '')}</b>
              · минимум ${num(a.min_stock)} · ${esc(a.warehouse)}
            </div>
          </a>`).join('')
      : '<div style="padding:16px 14px;color:var(--color-text-secondary,#666);">Всё в норме: ни одна позиция не дошла до минимального остатка.</div>';
    panel.innerHTML = `
      <div style="padding:12px 14px;font-weight:700;">Пора заказать</div>
      <div style="max-height:360px;overflow:auto;">${list}</div>
      <div style="padding:10px 14px;border-top:1px solid var(--admin-border,#eee);font-size:12px;color:var(--color-text-secondary,#666);">
        Минимум задаётся в карточке позиции склада. Уведомления в Telegram —
        <a href="/admin-panel/settings.html#integration">Настройки → Интеграции</a>.
      </div>`;
  }

  function toggle() {
    if (panel) return close();
    panel = document.createElement('div');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Пора заказать');
    const r = btn.getBoundingClientRect();
    panel.style.cssText = 'position:fixed;z-index:10000;width:340px;max-width:calc(100vw - 16px);border-radius:12px;'
      + 'background:var(--admin-card-bg,#fff);color:var(--color-text,#222);box-shadow:0 10px 30px rgba(0,0,0,.18);'
      + 'top:' + (r.bottom + 8) + 'px;right:' + Math.max(8, window.innerWidth - r.right) + 'px;';
    panel.addEventListener('click', (e) => e.stopPropagation());
    fill();
    document.body.appendChild(panel);
    load();
  }

  function close() {
    if (panel) { panel.remove(); panel = null; }
  }

  async function load() {
    try {
      const res = await AUTH.fetch('/api/inventory/stock-alerts');
      if (res.status === 401 || res.status === 403) { btn.style.display = 'none'; return false; }
      if (!res.ok) return true;
      const data = await res.json();
      alerts = data.alerts || [];
      render();
    } catch (e) { /* сеть моргнула — покажем при следующем опросе */ }
    return true;
  }

  function start() {
    if (!mount()) return;
    load().then((ok) => { if (ok) setInterval(load, 60_000); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
