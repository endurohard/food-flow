// ── Дашборд под тип заведения ────────────────────────────────────────────
// Над общими KPI показывает блок, важный именно этому типу:
//   кофейня      — чеки по часам и очередь у стойки;
//   доставка     — ждут курьера, в пути, время доставки, опоздания;
//   производство — выпуски за сегодня и позиции ниже минимума.
// Ресторан и кафе обходятся общим дашбордом — для них блок скрыт.
(function () {
  const DELIVERY_TARGET_MIN = 45; // обещанное гостю время, для «опозданий»

  const SUBTITLES = {
    restaurant:  'Обзор ресторана за сегодня',
    cafe:        'Обзор кафе за сегодня',
    coffee_shop: 'Обзор кофейни за сегодня',
    delivery:    'Обзор доставки за сегодня',
    production:  'Обзор производства за сегодня'
  };

  const CSS = `
    .bf { display: flex; flex-wrap: wrap; gap: 20px; margin-bottom: 28px; }
    .bf[hidden] { display: none; }
    .bf-card { flex: 1 1 320px; min-width: 0; background: var(--admin-card-bg); border-radius: var(--radius-lg);
      box-shadow: var(--shadow-card); padding: 20px; display: flex; flex-direction: column; gap: 14px; }
    .bf-card.wide { flex: 2 1 460px; }
    .bf-head { display: flex; align-items: baseline; gap: 12px; }
    .bf-title { margin: 0; font-family: var(--font-family-heading); font-size: 18px; font-weight: 700; color: var(--color-text-primary); }
    .bf-note { margin-left: auto; font-size: 13px; color: var(--color-text-secondary); }
    .bf-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
    .bf-kpi { display: flex; flex-direction: column; gap: 4px; }
    .bf-kpi-label { font-size: 12px; font-weight: 700; letter-spacing: .06em; color: var(--color-text-secondary); text-transform: uppercase; }
    .bf-kpi-value { font-family: var(--font-family-heading); font-size: 28px; font-weight: 700; color: var(--color-text-primary); }
    .bf-kpi-value.bad { color: var(--color-accent-hover); }
    .bf-bars { display: flex; align-items: flex-end; gap: 6px; height: 160px; border-bottom: 1px solid var(--admin-border); }
    .bf-bar { flex: 1; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 4px; }
    .bf-bar span { font-size: 11px; font-weight: 700; color: var(--color-text-secondary); }
    .bf-bar i { display: block; width: 100%; border-radius: 5px 5px 0 0; background: var(--color-primary-light); }
    .bf-bar.peak i { background: var(--color-primary); }
    .bf-hours { display: flex; gap: 6px; margin-top: -8px; }
    .bf-hours span { flex: 1; text-align: center; font-size: 11px; color: var(--color-text-secondary); }
    .bf-list { display: flex; flex-direction: column; }
    .bf-row { display: flex; align-items: center; gap: 10px; min-height: 48px; border-bottom: 1px solid var(--admin-border);
      font-size: 14px; color: var(--color-text-primary); text-decoration: none; }
    .bf-row:last-child { border-bottom: 0; }
    .bf-row b { min-width: 56px; }
    .bf-row .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bf-pill { padding: 3px 8px; border-radius: 6px; font-size: 12px; font-weight: 700; white-space: nowrap; }
    .bf-pill.green { background: var(--color-success-light); color: #1F6B40; }
    .bf-pill.yellow { background: var(--color-warning-light); color: #7A6118; }
    .bf-pill.red { background: var(--color-danger-light); color: #B23F26; }
    .bf-empty { padding: 18px 0; text-align: center; font-size: 14px; color: var(--color-text-secondary); }
    .bf-link { font-size: 14px; font-weight: 700; color: var(--color-primary); text-decoration: none; }
  `;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function minutesSince(iso) { return iso ? Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)) : 0; }
  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }
  function guest(o) { return [o.first_name, o.last_name].filter(Boolean).join(' ') || 'Гость'; }
  function money(n) { return (Math.round(Number(n) || 0)).toLocaleString('ru-RU') + ' ₽'; }
  function hhmm(iso) { return iso ? new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—'; }

  async function getJSON(url) {
    try {
      const res = await AUTH.fetch(url);
      return res.ok ? await res.json() : null;
    } catch (e) { return null; }
  }
  async function todayOrders(extra) {
    const data = await getJSON('/api/orders?dateFrom=' + today() + '&limit=500' + (extra || ''));
    return data && Array.isArray(data.orders) ? data.orders : null;
  }

  function kpi(label, value, bad) {
    return `<div class="bf-kpi"><span class="bf-kpi-label">${label}</span><span class="bf-kpi-value${bad ? ' bad' : ''}">${value}</span></div>`;
  }
  const NO_DATA = '<div class="bf-empty">Нет данных — проверьте подключение к серверу</div>';

  // ── Кофейня ──
  async function renderCoffee(root) {
    const orders = await todayOrders();
    if (!orders) { root.innerHTML = `<div class="bf-card">${NO_DATA}</div>`; return; }
    const hours = [];
    for (let h = 7; h <= 22; h++) hours.push({ h, n: 0 });
    orders.forEach((o) => {
      const h = new Date(o.created_at).getHours();
      const slot = hours.find((x) => x.h === h);
      if (slot) slot.n++;
    });
    const max = Math.max(1, ...hours.map((x) => x.n));
    const peak = hours.reduce((a, b) => (b.n > a.n ? b : a), hours[0]);
    const queue = orders.filter((o) => ['confirmed', 'preparing', 'ready'].includes(o.status))
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).slice(0, 6);

    root.innerHTML = `
      <section class="bf-card wide" aria-label="Чеки по часам">
        <div class="bf-head"><h2 class="bf-title">Чеки по часам</h2>
          <span class="bf-note">${peak.n ? 'пик — ' + peak.h + ':00, ' + peak.n + ' ' + plural(peak.n, 'чек', 'чека', 'чеков') : 'чеков пока нет'}</span></div>
        <div class="bf-bars">${hours.map((x) => `<div class="bf-bar${x.n === peak.n && x.n ? ' peak' : ''}"><span>${x.n || ''}</span><i style="height:${Math.round((x.n / max) * 120)}px"></i></div>`).join('')}</div>
        <div class="bf-hours">${hours.map((x) => `<span>${x.h}</span>`).join('')}</div>
      </section>
      <section class="bf-card" aria-label="У стойки сейчас">
        <div class="bf-head"><h2 class="bf-title">У стойки сейчас</h2><a class="bf-note bf-link" href="/admin-panel/kds.html">Очередь</a></div>
        <div class="bf-list">${queue.length ? queue.map((o) => `
          <div class="bf-row"><b>#${esc(o.order_number || o.id)}</b><span class="grow">${esc(guest(o))} · ${money(o.total)}</span>
            ${o.status === 'ready' ? '<span class="bf-pill green">выдать</span>' : '<span class="bf-pill yellow">готовится · ' + minutesSince(o.created_at) + ' мин</span>'}</div>`).join('')
          : '<div class="bf-empty">Очереди нет</div>'}</div>
      </section>`;
  }

  // ── Доставка ──
  async function renderDelivery(root) {
    const orders = await todayOrders('&orderType=delivery');
    if (!orders) { root.innerHTML = `<div class="bf-card">${NO_DATA}</div>`; return; }
    const waiting = orders.filter((o) => o.status === 'ready')
      .map((o) => ({ o, wait: minutesSince(o.updated_at || o.created_at) }))
      .sort((a, b) => b.wait - a.wait);
    const onTheWay = orders.filter((o) => o.status === 'out_for_delivery');
    const delivered = orders.filter((o) => o.delivered_at && o.created_at);
    const durations = delivered.map((o) => (new Date(o.delivered_at) - new Date(o.created_at)) / 60000);
    const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
    const late = durations.filter((m) => m > DELIVERY_TARGET_MIN).length;
    const latePct = durations.length ? Math.round((late / durations.length) * 100) : 0;

    root.innerHTML = `
      <section class="bf-card wide" aria-label="Доставка сегодня">
        <div class="bf-head"><h2 class="bf-title">Доставка сегодня</h2><span class="bf-note">обещаем гостю до ${DELIVERY_TARGET_MIN} мин</span></div>
        <div class="bf-kpis">
          ${kpi('Ждут курьера', waiting.length, waiting.some((w) => w.wait > 10))}
          ${kpi('В пути', onTheWay.length)}
          ${kpi('Среднее время', avg === null ? '—' : avg + ' мин', avg !== null && avg > DELIVERY_TARGET_MIN)}
          ${kpi('Опоздали', durations.length ? late + ' · ' + latePct + '%' : '—', latePct > 5)}
        </div>
      </section>
      <section class="bf-card" aria-label="Готовы и ждут курьера">
        <div class="bf-head"><h2 class="bf-title">Готовы, ждут курьера</h2><a class="bf-note bf-link" href="/admin-panel/orders.html">Все заказы</a></div>
        <div class="bf-list">${waiting.length ? waiting.slice(0, 5).map(({ o, wait }) => `
          <div class="bf-row"><b>#${esc(o.order_number || o.id)}</b><span class="grow">${esc(guest(o))} · ${money(o.total)}</span>
            <span class="bf-pill ${wait > 10 ? 'red' : 'yellow'}">ждёт ${wait} мин</span></div>`).join('')
          : '<div class="bf-empty">Все готовые заказы уже у курьеров</div>'}</div>
      </section>`;
  }

  // ── Производство ──
  async function renderProduction(root) {
    const [runsData, lowData] = await Promise.all([
      getJSON('/api/inventory/production?from=' + today() + '&limit=50'),
      getJSON('/api/inventory/items?lowStock=true')
    ]);
    const runs = runsData && Array.isArray(runsData.productionRuns)
      ? runsData.productionRuns.filter((r) => r.status !== 'cancelled') : null;
    const low = lowData && Array.isArray(lowData.items) ? lowData.items : null;
    const cost = runs ? runs.reduce((a, r) => a + (Number(r.total_cost) || 0), 0) : 0;

    root.innerHTML = `
      <section class="bf-card wide" aria-label="Выпуск за сегодня">
        <div class="bf-head"><h2 class="bf-title">Выпуск за сегодня</h2><a class="bf-note bf-link" href="/admin-panel/inventory.html">Производство</a></div>
        ${runs ? `
        <div class="bf-kpis">${kpi('Партий', runs.length)}${kpi('Себестоимость', money(cost))}${kpi('Позиций ниже минимума', low ? low.length : '—', low && low.length > 0)}</div>
        <div class="bf-list">${runs.length ? runs.slice(0, 5).map((r) => `
          <div class="bf-row"><b>${hhmm(r.produced_at)}</b><span class="grow">${esc(r.output_name)} · ${Number(r.quantity).toLocaleString('ru-RU')} ${esc(r.output_unit || '')}</span>
            <span class="bf-pill green">${r.unit_cost ? money(r.unit_cost) + ' / ед.' : 'выпущено'}</span></div>`).join('')
          : '<div class="bf-empty">Сегодня ещё ничего не выпускали</div>'}</div>` : NO_DATA}
      </section>
      <section class="bf-card" aria-label="Ниже минимума">
        <div class="bf-head"><h2 class="bf-title">Ниже минимума</h2><a class="bf-note bf-link" href="/admin-panel/inventory.html">Склад</a></div>
        <div class="bf-list">${low ? (low.length ? low.slice(0, 6).map((i) => `
          <div class="bf-row"><span class="grow"><b style="min-width:0">${esc(i.name)}</b></span>
            <span class="bf-pill ${Number(i.total_stock) <= 0 ? 'red' : 'yellow'}">${Number(i.total_stock).toLocaleString('ru-RU')} из ${Number(i.min_stock).toLocaleString('ru-RU')} ${esc(i.unit || '')}</span></div>`).join('')
          : '<div class="bf-empty">Все позиции в норме</div>') : NO_DATA}</div>
      </section>`;
  }

  const RENDERERS = { coffee_shop: renderCoffee, delivery: renderDelivery, production: renderProduction };

  async function init() {
    const type = typeof AUTH !== 'undefined' && AUTH.getBusinessType ? AUTH.getBusinessType() : null;
    const sub = document.querySelector('.page-heading .page-subtitle');
    if (sub && SUBTITLES[type]) sub.textContent = SUBTITLES[type];

    const root = document.getElementById('businessFocus');
    if (!root) return;
    const render = RENDERERS[type];
    if (!render) { root.hidden = true; return; }
    if (!document.getElementById('bf-style')) {
      const st = document.createElement('style');
      st.id = 'bf-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    if (root.hidden || !root.innerHTML) {
      root.innerHTML = '<div class="bf-card"><div class="bf-empty">Загрузка…</div></div>';
    }
    root.hidden = false;
    await render(root);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  // Обновляем вместе с остальным дашбордом — раз в минуту
  setInterval(init, 60000);
})();
