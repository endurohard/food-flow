/**
 * FoodFlow — режим кассы для планшета.
 *
 * Сценарий:
 *   0. Один раз владелец привязывает планшет к кассе (логин владельца → выбор
 *      кассы). Планшет хранит токен устройства, сервер — только его хеш.
 *   1. Кассир входит одним PIN (4 цифры) — без логина и пароля. По PIN сервер
 *      находит кассира организации и сразу открывает сессию кассы.
 *   2. Если смена закрыта — кассир открывает её здесь же.
 *   3. Продажи через POST /api/pos/sales (заказ + платёж + касса атомарно).
 *   4. «Заблокировать / сменить кассира» — продажи закрыты до следующего PIN.
 *
 * Модальных диалогов браузера нет намеренно: во встроенных браузерах и
 * киоск-режимах планшетов alert/confirm заблокированы.
 */
(function () {
  'use strict';

  // const AUTH из /js/auth.js — глобальная лексическая переменная, в window её нет
  var DEVICE_KEY = 'ff_kiosk_device';
  var PIN_LEN = 4;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(v) {
    var n = Math.round((Number(v) || 0) * 100) / 100;
    return n.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' ₽';
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  var state = {
    device: null,          // { token, registerId, registerName, enterpriseId }
    register: null,        // { id, name, restaurant_id, status }
    restaurant: null,      // { id, name }
    user: null,
    sessionId: null,
    categories: [],
    items: [],
    category: 'all',
    cart: [],              // { item, qty }
    method: 'cash',
    pin: '',
    busy: false,
    openCheckId: null,     // отложенный чек, открытый сейчас в корзине
    openCheckLabel: '',
    checks: [],
  };

  function loadDevice() {
    try { return JSON.parse(localStorage.getItem(DEVICE_KEY) || 'null'); } catch (e) { return null; }
  }

  // ── экраны ──
  var SCREENS = ['activate-screen', 'pin-screen', 'setup-screen', 'till-screen'];
  function show(id) {
    SCREENS.forEach(function (s) { $(s).classList.toggle('active', s === id); });
  }

  // ── запросы ──
  // Своя обёртка вместо AUTH.fetch: тот при 401 уводит на вход админки
  async function api(url, options, token) {
    options = options || {};
    var headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    var t = token === undefined ? AUTH.getToken() : token;
    if (t) headers.Authorization = 'Bearer ' + t;
    var res = await window.fetch(url, Object.assign({}, options, { headers: headers }));
    if (res.status === 401 && t && token === undefined && url.indexOf('/api/auth/') !== 0) {
      try {
        headers.Authorization = 'Bearer ' + (await AUTH._refresh());
        res = await window.fetch(url, Object.assign({}, options, { headers: headers }));
      } catch (e) {
        lockScreen('Сессия кассира истекла — введите PIN');
        throw new Error('Сессия истекла');
      }
    }
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      var err = new Error(body.message || body.error || ('Ошибка ' + res.status));
      err.status = res.status;
      err.code = body.error;
      throw err;
    }
    return body;
  }

  // Токены кассира живут только между PIN и блокировкой: на заблокированном
  // планшете не остаётся входа, которым можно было бы воспользоваться
  function dropCashierAuth() {
    localStorage.removeItem('ff_token');
    localStorage.removeItem('ff_refresh_token');
    localStorage.removeItem('ff_user');
    state.user = null;
    state.sessionId = null;
  }

  function lockScreen(msg) {
    dropCashierAuth();
    state.cart = [];
    setOpenCheck(null);
    $('checks-panel').style.display = 'none';
    $('receipts-panel').style.display = 'none';
    // Следующий кассир не должен пробить чек на клиента или стол предыдущего
    setCustomer(null);
    setTable(null);
    $('customer-panel').style.display = 'none';
    $('table-panel').style.display = 'none';
    rc.pending = null;
    openPin();
    if (msg) $('pin-error').textContent = msg;
  }

  // ── 0. привязка планшета ──
  var ownerToken = null;   // только в памяти: на планшете вход владельца не сохраняется

  $('activate-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var btn = $('btn-activate');
    $('act-error').textContent = '';
    $('act-registers').innerHTML = '';
    btn.disabled = true;
    try {
      var data = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: $('act-email').value.trim(), password: $('act-password').value, host: location.hostname }),
      }, null);
      var u = data.user || {};
      var erole = u.enterpriseRole || u.enterprise_role;
      if (!(erole === 'owner' || erole === 'admin' || u.role === 'restaurant_owner' || u.role === 'admin')) {
        throw new Error('Привязать планшет может только владелец или админ организации');
      }
      ownerToken = data.accessToken;
      var enterpriseId = u.enterpriseId || u.enterprise_id;
      $('act-password').value = '';
      var rests = await api('/api/restaurants', {}, ownerToken);
      var names = {};
      (rests.restaurants || rests.data || []).forEach(function (r) { names[r.id] = r.name; });
      var regs = (await api('/api/finance/registers', {}, ownerToken)).registers || [];
      if (!regs.length) {
        throw new Error('В организации нет ни одной кассы. Заведите её в админке: Устройства → Кассы.');
      }
      $('act-registers').innerHTML = '<p class="muted" style="margin:0">Выберите кассу для этого планшета:</p>' +
        regs.map(function (r) {
          return '<button class="choice" data-id="' + esc(r.id) + '">' + esc(r.name) +
            ' <span class="badge closed">' + esc(names[r.restaurant_id] || '') + '</span></button>';
        }).join('');
      $('act-registers').querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function () { bindDevice(enterpriseId, regs.filter(function (r) { return r.id === b.dataset.id; })[0]); });
      });
    } catch (err) {
      $('act-error').textContent = err.status === 401 ? 'Неверный логин или пароль' : err.message;
    } finally {
      btn.disabled = false;
    }
  });

  async function bindDevice(enterpriseId, reg) {
    $('act-error').textContent = '';
    try {
      var d = await api('/api/enterprises/' + enterpriseId + '/cash-devices', {
        method: 'POST',
        body: JSON.stringify({ registerId: reg.id, name: 'Планшет ' + new Date().toLocaleDateString('ru-RU') }),
      }, ownerToken);
      state.device = { token: d.deviceToken, registerId: reg.id, registerName: reg.name, enterpriseId: enterpriseId };
      localStorage.setItem(DEVICE_KEY, JSON.stringify(state.device));
      ownerToken = null;
      $('act-registers').innerHTML = '';
      openPin();
    } catch (err) {
      $('act-error').textContent = 'Планшет не привязан: ' + err.message;
    }
  }

  // ── 1. PIN ──
  function renderPin() {
    var dots = '';
    for (var i = 0; i < PIN_LEN; i++) dots += '<span class="' + (i < state.pin.length ? 'filled' : '') + '"></span>';
    $('pin-dots').innerHTML = dots;
  }
  (function buildKeypad() {
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', 'OK'];
    $('keypad').innerHTML = keys.map(function (k) {
      return '<button data-k="' + k + '"' + (isNaN(k) ? ' class="wide"' : '') + '>' + (k === 'C' ? 'Стереть' : k) + '</button>';
    }).join('');
    $('keypad').querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () { pressKey(b.dataset.k); });
    });
    document.addEventListener('keydown', function (e) {
      if (!$('pin-screen').classList.contains('active')) return;
      if (/^[0-9]$/.test(e.key)) pressKey(e.key);
      else if (e.key === 'Backspace') pressKey('C');
      else if (e.key === 'Enter') pressKey('OK');
    });
  })();

  function openPin() {
    state.pin = '';
    $('pin-error').textContent = '';
    $('pin-title').textContent = 'Введите PIN кассира';
    $('pin-hint').textContent = (state.device ? state.device.registerName + ' · ' : '') + 'PIN из 4 цифр';
    renderPin();
    show('pin-screen');
  }

  async function pressKey(k) {
    if (state.busy) return;
    if (k === 'C') { state.pin = state.pin.slice(0, -1); renderPin(); return; }
    if (k !== 'OK') {
      if (state.pin.length < PIN_LEN) state.pin += k;
      renderPin();
      if (state.pin.length < PIN_LEN) return;
    }
    if (state.pin.length < PIN_LEN) { $('pin-error').textContent = 'PIN — 4 цифры'; return; }
    state.busy = true;
    $('pin-error').textContent = '';
    try {
      var d = await api('/api/auth/cash-register/pin-login', {
        method: 'POST',
        body: JSON.stringify({ deviceToken: state.device.token, pin: state.pin }),
      }, null);
      localStorage.setItem('ff_token', d.accessToken);
      localStorage.setItem('ff_refresh_token', d.refreshToken);
      var u = d.user || {};
      localStorage.setItem('ff_user', JSON.stringify(Object.assign({}, u, {
        enterpriseId: u.enterprise_id || null,
        enterpriseRole: 'cashier',
      })));
      state.user = u;
      state.sessionId = d.registerSessionId;
      state.register = d.register;
      await afterLogin();
    } catch (err) {
      if (err.code === 'DEVICE_UNKNOWN') {
        localStorage.removeItem(DEVICE_KEY);
        state.device = null;
        show('activate-screen');
        $('act-error').textContent = 'Планшет отвязан от кассы — привяжите его заново.';
      } else {
        $('pin-error').textContent = err.message;
      }
    } finally {
      state.pin = '';
      renderPin();
      state.busy = false;
    }
  }

  async function afterLogin() {
    if (!state.restaurant || state.restaurant.id !== state.register.restaurant_id) {
      var r = await api('/api/restaurants');
      var rest = (r.restaurants || r.data || []).filter(function (x) { return x.id === state.register.restaurant_id; })[0];
      state.restaurant = rest || { id: state.register.restaurant_id, name: '' };
      state.items = [];
    }
    if (state.register.status !== 'open') {
      $('setup-title').textContent = state.register.name + ': смена закрыта';
      $('setup-error').textContent = '';
      show('setup-screen');
      return;
    }
    await openTill();
  }

  // ── 2. открытие смены ──
  $('btn-open-shift').addEventListener('click', async function () {
    var btn = this;
    var sum = parseFloat(String($('opening-balance').value).replace(',', '.'));
    if (!(sum >= 0)) { $('setup-error').textContent = 'Укажите сумму (0, если касса пустая)'; return; }
    btn.disabled = true;
    $('setup-error').textContent = '';
    try {
      var d = await api('/api/finance/registers/' + state.register.id + '/open', {
        method: 'POST',
        body: JSON.stringify({ restaurantId: state.register.restaurant_id, openingBalance: sum }),
      });
      state.register.status = d.register.status;
      await openTill();
    } catch (err) {
      $('setup-error').textContent = err.message === 'Register already open for this restaurant'
        ? 'На точке уже открыта смена на другой кассе' : 'Смена не открыта: ' + err.message;
    } finally {
      btn.disabled = false;
    }
  });
  $('btn-setup-back').addEventListener('click', function () { lockScreen(''); });

  // ── 3. продажи ──
  function isStopped(it) {
    if (it.is_available === false) return true;
    if (!it.stopped_at) return false;
    return !(it.stop_until && new Date(it.stop_until) < new Date());
  }

  async function openTill() {
    show('till-screen');
    var u = state.user || {};
    $('till-register').textContent = state.register.name;
    $('till-sub').textContent = (state.restaurant.name ? state.restaurant.name + ' · ' : '') + 'кассир ' +
      (((u.first_name || '') + ' ' + (u.last_name || '')).trim() || u.email || '');
    $('till-error').textContent = '';
    $('till-ok').innerHTML = '';
    if (!state.items.length) {
      try {
        var base = '/api/restaurants/' + state.restaurant.id;
        var res = await Promise.all([api(base + '/menu-categories'), api(base + '/menu-items')]);
        state.categories = res[0].categories || res[0].data || [];
        state.items = (res[1].items || res[1].data || []).filter(function (i) { return !isStopped(i); });
      } catch (err) {
        $('grid').innerHTML = '<p class="error">Меню не загрузилось: ' + esc(err.message) + '</p>';
        return;
      }
    }
    renderCats();
    renderGrid();
    renderCart();
    loadChecks();
  }

  // ── отложенные чеки ──
  // Запросы к чекам идут с той же сессией кассы, что и продажа
  function posApi(url, options) {
    options = options || {};
    options.headers = Object.assign({ 'X-Register-Session': state.sessionId || '' }, options.headers || {});
    return api(url, options);
  }

  function setOpenCheck(check) {
    state.openCheckId = check ? check.id : null;
    state.openCheckLabel = check ? check.label : '';
    $('check-label').value = check ? check.label : '';
    var cur = $('check-current');
    cur.style.display = check ? '' : 'none';
    cur.textContent = check ? 'Открыт отложенный чек: ' + check.label : '';
  }

  function findItem(id) { return state.items.filter(function (i) { return i.id === id; })[0]; }

  function checkSum(c) {
    return (c.items || []).reduce(function (s, r) {
      var it = findItem(r.menuItemId);
      return s + (it ? Number(it.price) * r.quantity : 0);
    }, 0);
  }

  async function loadChecks() {
    try {
      var d = await posApi('/api/pos/checks?restaurantId=' + encodeURIComponent(state.restaurant.id));
      state.checks = d.checks || [];
    } catch (err) {
      state.checks = [];
      $('checks-error').textContent = 'Отложенные чеки не загрузились: ' + err.message;
    }
    $('checks-count').textContent = String(state.checks.length);
    if ($('checks-panel').style.display !== 'none') renderChecks();
  }

  function renderChecks() {
    $('checks-error').textContent = '';
    if (!state.checks.length) {
      $('checks-list').innerHTML = '<p class="muted">Отложенных чеков нет.</p>';
      return;
    }
    $('checks-list').innerHTML = state.checks.map(function (c) {
      var n = (c.items || []).reduce(function (s, r) { return s + r.quantity; }, 0);
      var t = new Date(c.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      return '<div class="check-card"><div class="t">' + esc(c.label) + '</div>' +
        '<div class="m">' + n + ' поз. · ' + money(checkSum(c)) + ' · с ' + t + (c.created_by_name ? ' · ' + esc(c.created_by_name) : '') + '</div>' +
        '<div class="acts"><button class="btn-secondary" data-open="' + esc(c.id) + '">Открыть</button>' +
        '<button class="btn-danger" data-del="' + esc(c.id) + '">Удалить</button></div></div>';
    }).join('');
    $('checks-list').querySelectorAll('[data-open]').forEach(function (b) {
      b.addEventListener('click', function () { openCheck(b.dataset.open); });
    });
    $('checks-list').querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', async function () {
        // Два нажатия вместо confirm()
        if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Точно удалить?'; return; }
        try {
          await posApi('/api/pos/checks/' + encodeURIComponent(b.dataset.del), { method: 'DELETE' });
          if (state.openCheckId === b.dataset.del) { state.cart = []; setOpenCheck(null); renderGrid(); renderCart(); }
          await loadChecks();
        } catch (err) { $('checks-error').textContent = 'Не удалён: ' + err.message; }
      });
    });
  }

  function openCheck(id) {
    var c = state.checks.filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    if (state.cart.length && state.openCheckId !== id) {
      $('checks-error').textContent = 'В корзине другой чек — сначала отложите или оплатите его.';
      return;
    }
    var missing = 0;
    state.cart = [];
    (c.items || []).forEach(function (r) {
      var it = findItem(r.menuItemId);
      if (it) state.cart.push({ item: it, qty: r.quantity }); else missing++;
    });
    setOpenCheck(c);
    pendingSaleId = null;
    $('checks-panel').style.display = 'none';
    renderGrid();
    renderCart();
    $('till-ok').innerHTML = missing
      ? '<p class="error">' + missing + ' поз. из чека сейчас недоступны (стоп-лист) и не попали в корзину</p>' : '';
  }

  $('btn-checks').addEventListener('click', function () {
    $('receipts-panel').style.display = 'none';
    $('checks-panel').style.display = '';
    renderChecks();
    loadChecks();
  });
  $('btn-checks-close').addEventListener('click', function () { $('checks-panel').style.display = 'none'; });

  $('btn-hold').addEventListener('click', async function () {
    if (!state.cart.length || state.busy) { $('till-error').textContent = 'Чек пуст — нечего откладывать'; return; }
    var btn = this;
    state.busy = true;
    btn.disabled = true;
    $('till-error').textContent = '';
    // Отложенный чек на стол подписываем номером стола, если подпись не ввели
    var label = $('check-label').value.trim() || (state.table ? 'Стол ' + state.table.table_number : '');
    var body = {
      label: label,
      items: state.cart.map(function (r) { return { menuItemId: r.item.id, quantity: r.qty }; }),
    };
    try {
      var d;
      if (state.openCheckId) {
        d = await posApi('/api/pos/checks/' + encodeURIComponent(state.openCheckId), { method: 'PUT', body: JSON.stringify(body) });
      } else {
        body.restaurantId = state.restaurant.id;
        d = await posApi('/api/pos/checks', { method: 'POST', body: JSON.stringify(body) });
      }
      state.cart = [];
      setOpenCheck(null);
      setTable(null);
      pendingSaleId = null;
      renderGrid();
      renderCart();
      $('till-ok').innerHTML = '<div class="ok-msg">🧾 Чек «' + esc(d.check.label) + '» отложен</div>';
      await loadChecks();
    } catch (err) {
      if (err.status === 403 && /PIN|сесси/i.test(err.message)) lockScreen(err.message);
      else $('till-error').textContent = '❌ Не отложен: ' + err.message;
    } finally {
      state.busy = false;
      btn.disabled = false;
    }
  });

  function renderCats() {
    var used = {};
    state.items.forEach(function (i) { used[i.category_id] = true; });
    var cats = [{ id: 'all', name: 'Все' }].concat(state.categories.filter(function (c) { return used[c.id]; }));
    $('cats').innerHTML = cats.map(function (c) {
      return '<button data-id="' + esc(c.id) + '" class="' + (state.category === c.id ? 'active' : '') + '">' + esc(c.name) + '</button>';
    }).join('');
    $('cats').querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () { state.category = b.dataset.id; renderCats(); renderGrid(); });
    });
  }

  function qtyOf(id) {
    var row = state.cart.filter(function (r) { return r.item.id === id; })[0];
    return row ? row.qty : 0;
  }

  function renderGrid() {
    var list = state.items.filter(function (i) { return state.category === 'all' || i.category_id === state.category; });
    if (!list.length) { $('grid').innerHTML = '<p class="muted">В меню нет доступных позиций.</p>'; return; }
    $('grid').innerHTML = list.map(function (i) {
      var q = qtyOf(i.id);
      return '<button class="tile" data-id="' + esc(i.id) + '">' + (q ? '<span class="qty-badge">' + q + '</span>' : '') +
        '<span>' + esc(i.name) + '</span><span class="price">' + money(i.price) + '</span></button>';
    }).join('');
    $('grid').querySelectorAll('.tile').forEach(function (b) {
      b.addEventListener('click', function () { changeQty(b.dataset.id, 1); });
    });
  }

  // saleId живёт до успешной продажи: повтор после обрыва сети не пробьёт чек дважды
  var pendingSaleId = null;

  function changeQty(id, delta) {
    var row = state.cart.filter(function (r) { return r.item.id === id; })[0];
    if (!row) {
      var item = state.items.filter(function (i) { return i.id === id; })[0];
      if (!item || delta < 0) return;
      state.cart.push({ item: item, qty: 1 });
    } else {
      row.qty += delta;
      if (row.qty <= 0) state.cart = state.cart.filter(function (r) { return r !== row; });
    }
    // Состав чека изменился — это уже другая продажа
    pendingSaleId = null;
    $('till-ok').innerHTML = '';
    renderGrid();
    renderCart();
  }

  function cartTotal() {
    return state.cart.reduce(function (s, r) { return s + Number(r.item.price) * r.qty; }, 0);
  }

  function renderCart() {
    if (!state.cart.length) {
      $('cart').innerHTML = '<p class="muted">Чек пуст — нажмите на позицию меню.</p>';
    } else {
      $('cart').innerHTML = state.cart.map(function (r) {
        return '<div class="cart-row"><span class="n">' + esc(r.item.name) + '</span>' +
          '<button data-id="' + esc(r.item.id) + '" data-d="-1">−</button><span>' + r.qty + '</span>' +
          '<button data-id="' + esc(r.item.id) + '" data-d="1">+</button>' +
          '<span class="sum">' + money(Number(r.item.price) * r.qty) + '</span></div>';
      }).join('');
      $('cart').querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function () { changeQty(b.dataset.id, Number(b.dataset.d)); });
      });
    }
    $('total').textContent = money(cartTotal());
    $('btn-checkout').disabled = !state.cart.length;
  }

  $('pay').querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function () {
      state.method = b.dataset.method;
      pendingSaleId = null;
      $('pay').querySelectorAll('button').forEach(function (x) { x.classList.toggle('active', x === b); });
    });
  });

  // ── стол чека ──
  // Без стола чек «на вынос», со столом — «в зале» с привязкой к столу.
  // Столы заводят в админке («Столы» или «Схема зала»).
  var HALL_NAMES = { main: 'Основной зал', vip: 'VIP зал', terrace: 'Терраса' };
  var TABLE_STATUS = { free: 'свободен', occupied: 'занят', reserved: 'бронь' };

  function setTable(t) {
    state.table = t || null;
    pendingSaleId = null; // стол входит в тело продажи — это уже другая продажа
    var btn = $('btn-table');
    btn.classList.toggle('set', !!t);
    btn.textContent = t ? '🍽 Стол ' + t.table_number + ' · в зале' : '🍽 Без стола · на вынос';
    $('btn-table-clear').style.display = t ? '' : 'none';
  }

  async function loadTables() {
    $('tbl-error').textContent = '';
    $('tbl-list').innerHTML = '<p class="muted">Загрузка…</p>';
    try {
      var d = await api('/api/tables?restaurantId=' + encodeURIComponent(state.restaurant.id));
      var list = d.tables || [];
      if (!list.length) {
        $('tbl-list').innerHTML = '<p class="muted">В этой точке нет столов. Их заводит владелец в админке: «Столы» или «Схема зала».</p>';
        return;
      }
      var halls = {};
      list.forEach(function (t) { var h = HALL_NAMES[t.section] ? t.section : 'main'; (halls[h] = halls[h] || []).push(t); });
      var html = '';
      Object.keys(HALL_NAMES).forEach(function (h) {
        if (!halls[h]) return;
        halls[h].sort(function (a, b) { return String(a.table_number).localeCompare(String(b.table_number), 'ru', { numeric: true }); });
        html += '<div class="tbl-hall">' + esc(HALL_NAMES[h]) + '</div><div class="tbl-grid">' +
          halls[h].map(function (t) {
            var cur = state.table && state.table.id === t.id;
            return '<button class="tbl-item ' + esc(t.status || 'free') + (cur ? ' cur' : '') + '" data-id="' + esc(t.id) + '">' +
              '<span class="n">' + esc(t.table_number) + '</span>' +
              '<span class="s">' + (t.seats || '') + ' мест · ' + esc(TABLE_STATUS[t.status] || t.status || '') + '</span></button>';
          }).join('') + '</div>';
      });
      $('tbl-list').innerHTML = html;
      $('tbl-list').querySelectorAll('.tbl-item').forEach(function (b) {
        b.addEventListener('click', function () {
          setTable(list.filter(function (t) { return t.id === b.dataset.id; })[0]);
          $('table-panel').style.display = 'none';
        });
      });
    } catch (err) {
      $('tbl-list').innerHTML = '';
      if (err.status === 403 && /PIN|сесси/i.test(err.message)) return lockScreen(err.message);
      $('tbl-error').textContent = 'Столы не загрузились: ' + err.message;
    }
  }

  $('btn-table').addEventListener('click', function () {
    $('checks-panel').style.display = 'none';
    $('receipts-panel').style.display = 'none';
    $('customer-panel').style.display = 'none';
    $('table-panel').style.display = '';
    loadTables();
  });
  $('btn-table-close').addEventListener('click', function () { $('table-panel').style.display = 'none'; });
  $('btn-table-clear').addEventListener('click', function () { setTable(null); });

  // ── клиент чека (лояльность) ──
  // Кассир выбирает клиента из списка предприятия; баллы начисляет сервер
  // (crm-service) по закрытому заказу. Список отдаёт только имя, 4 последние
  // цифры телефона и баллы — полный номер кассе не нужен.
  function setCustomer(c) {
    state.customer = c || null;
    // Клиент входит в тело продажи — это уже другая продажа для идемпотентности
    pendingSaleId = null;
    var btn = $('btn-customer');
    btn.classList.toggle('set', !!c);
    btn.textContent = c
      ? '👤 ' + c.name + (c.phoneTail ? ' · …' + c.phoneTail : '') + ' · ' + c.points + ' б.'
      : '👤 Клиент: без клиента';
    $('btn-customer-clear').style.display = c ? '' : 'none';
  }

  var custTimer = null;
  var custSeq = 0;
  async function loadCustomers() {
    var seq = ++custSeq;
    var q = $('cust-search').value.trim();
    $('cust-error').textContent = '';
    try {
      var d = await api('/api/crm/customers/lookup' + (q ? '?q=' + encodeURIComponent(q) : ''));
      if (seq !== custSeq) return; // пришёл ответ на устаревший ввод
      var list = d.customers || [];
      if (!list.length) {
        $('cust-list').innerHTML = '<p class="muted">' + (q ? 'Никого не нашли.' : 'Клиентов пока нет — их заводят в админке, раздел «Лояльность».') + '</p>';
        return;
      }
      $('cust-list').innerHTML = list.map(function (c, i) {
        return '<button class="cust-item" data-i="' + i + '"><span class="nm">' + esc(c.name) + '</span>' +
          (c.phoneTail ? '<span class="ph">…' + esc(c.phoneTail) + '</span>' : '') +
          '<span class="pt">' + c.points + ' баллов</span></button>';
      }).join('');
      $('cust-list').querySelectorAll('.cust-item').forEach(function (b) {
        b.addEventListener('click', function () {
          setCustomer(list[Number(b.dataset.i)]);
          $('customer-panel').style.display = 'none';
        });
      });
    } catch (err) {
      if (seq !== custSeq) return;
      $('cust-list').innerHTML = '';
      $('cust-error').textContent = 'Список клиентов не загрузился: ' + err.message;
    }
  }

  $('btn-customer').addEventListener('click', function () {
    $('checks-panel').style.display = 'none';
    $('receipts-panel').style.display = 'none';
    $('table-panel').style.display = 'none';
    $('customer-panel').style.display = '';
    $('cust-search').value = '';
    $('cust-list').innerHTML = '<p class="muted">Загрузка…</p>';
    loadCustomers();
    setTimeout(function () { $('cust-search').focus(); }, 50);
  });
  $('btn-customer-close').addEventListener('click', function () { $('customer-panel').style.display = 'none'; });
  $('btn-customer-clear').addEventListener('click', function () { setCustomer(null); });
  $('cust-search').addEventListener('input', function () { clearTimeout(custTimer); custTimer = setTimeout(loadCustomers, 300); });

  $('btn-checkout').addEventListener('click', async function () {
    if (!state.cart.length || state.busy) return;
    var btn = this;
    state.busy = true;
    btn.disabled = true;
    $('till-error').textContent = '';
    pendingSaleId = pendingSaleId || uuid();
    try {
      var d = await api('/api/pos/sales', {
        method: 'POST',
        headers: { 'X-Register-Session': state.sessionId || '' },
        body: JSON.stringify({
          saleId: pendingSaleId,
          restaurantId: state.restaurant.id,
          registerId: state.register.id,
          orderType: state.table ? 'dine_in' : 'pickup',
          tableId: state.table ? state.table.id : null,
          paymentMethod: state.method,
          openCheckId: state.openCheckId,
          customerProfileId: state.customer ? state.customer.id : null,
          items: state.cart.map(function (r) { return { menuItemId: r.item.id, quantity: r.qty }; }),
        }),
      });
      pendingSaleId = null;
      var paidFor = state.customer;
      setCustomer(null);
      setTable(null);
      state.cart = [];
      var paidCheck = state.openCheckId;
      setOpenCheck(null);
      renderGrid();
      renderCart();
      if (paidCheck) loadChecks();
      var sale = d.sale || {};
      $('till-ok').innerHTML = '<div class="ok-msg">✅ Оплачено ' + money(sale.total) +
        (sale.orderNumber ? ' · чек ' + esc(sale.orderNumber) : '') +
        (sale.tableNumber ? ' · стол ' + esc(sale.tableNumber) : '') +
        (paidFor ? '<br>Баллы клиенту ' + esc(paidFor.name) + ' начисляются автоматически' : '') + '</div>';
    } catch (err) {
      if (err.status === 403 && /PIN|сесси/i.test(err.message)) {
        lockScreen(err.message);
      } else {
        $('till-error').textContent = '❌ Не оплачено: ' + err.message;
        // Чек оплатили на другом планшете или удалили — корзину оставляем,
        // но отвязываем её от закрытого чека, чтобы можно было пробить заново
        if (err.status === 409 && state.openCheckId && /Чек/.test(err.message)) {
          setOpenCheck(null);
          pendingSaleId = null;
          loadChecks();
        }
      }
    } finally {
      state.busy = false;
      btn.disabled = !state.cart.length;
    }
  });

  async function serverLock() {
    if (!state.register || !AUTH.getToken()) return;
    try {
      await api('/api/auth/cash-register/lock', {
        method: 'POST',
        body: JSON.stringify({ registerId: state.register.id }),
      });
    } catch (err) {
      // Экран блокируем в любом случае — планшет не должен оставаться открытым
      console.warn('lock:', err.message);
    }
  }

  $('btn-lock').addEventListener('click', async function () {
    await serverLock();
    lockScreen('');
  });

  // Закрытие смены — в два нажатия вместо confirm()
  var closeArmed = null;
  $('btn-close-shift').addEventListener('click', async function () {
    var btn = this;
    if (!closeArmed) {
      btn.textContent = 'Точно закрыть смену?';
      closeArmed = setTimeout(function () { btn.textContent = 'Закрыть смену'; closeArmed = null; }, 4000);
      return;
    }
    clearTimeout(closeArmed);
    closeArmed = null;
    btn.textContent = 'Закрыть смену';
    try {
      await api('/api/finance/registers/' + state.register.id + '/close', { method: 'POST', body: '{}' });
      await serverLock();
      lockScreen('Смена закрыта');
    } catch (err) {
      $('till-error').textContent = 'Смена не закрыта: ' + err.message;
    }
  });

  // ── чеки смены: просмотр, возврат, смена оплаты ──
  // Возврат и смену оплаты подтверждает PIN владельца или админа: кассир
  // вводит действие, админ подходит и набирает свой PIN прямо здесь.
  var rc = { list: [], current: null, sel: {}, pending: null, pin: '', reason: '' };

  function payTag(m) { return m === 'card' ? '<span class="tag t-card">Карта</span>' : '<span class="tag t-cash">Наличные</span>'; }
  function refundTag(r) {
    var ref = Number(r.refunded_amount) || 0;
    if (r.status === 'cancelled') return ' <span class="tag ref">Возврат</span>';
    return ref > 0 ? ' <span class="tag part">Возврат ' + money(ref) + '</span>' : '';
  }
  function hhmm(t) { return new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }
  function shortNo(n) { return String(n || '').replace(/^POS-\d{8}-/, '№ '); }

  async function loadReceipts() {
    $('rc-error').textContent = '';
    var q = '?restaurantId=' + encodeURIComponent(state.restaurant.id);
    if ($('rc-date').value) q += '&date=' + $('rc-date').value;
    var s = $('rc-search').value.trim();
    if (s) q += '&search=' + encodeURIComponent(s);
    try {
      rc.list = (await posApi('/api/pos/receipts' + q)).receipts || [];
    } catch (err) {
      if (err.status === 403 && /PIN|сесси/i.test(err.message)) return lockScreen(err.message);
      rc.list = [];
      $('rc-error').textContent = 'Чеки не загрузились: ' + err.message;
    }
    var today = new Date().toISOString().slice(0, 10);
    $('rc-title').textContent = (!$('rc-date').value || $('rc-date').value === today) ? 'Чеки за сегодня'
      : 'Чеки за ' + new Date($('rc-date').value).toLocaleDateString('ru-RU');
    renderReceipts();
    if (rc.current) {
      var fresh = rc.list.filter(function (r) { return r.id === rc.current.id; })[0];
      if (fresh) { rc.current = fresh; renderReceipt(); }
    }
  }

  function renderReceipts() {
    if (!rc.list.length) { $('rc-list').innerHTML = '<p class="muted">Чеков нет.</p>'; return; }
    var sum = rc.list.reduce(function (s, r) { return s + Number(r.total) - Number(r.refunded_amount || 0); }, 0);
    $('rc-list').innerHTML = '<p class="muted" style="margin:0 0 4px">' + rc.list.length + ' чек(ов) · выручка за вычетом возвратов ' + money(sum) + '</p>' +
      rc.list.map(function (r) {
        var names = (r.items || []).map(function (i) { return i.name + (i.quantity > 1 ? ' ×' + i.quantity : ''); }).join(', ');
        return '<button class="rc-row" data-id="' + esc(r.id) + '"><span class="no">' + esc(shortNo(r.order_number)) + '</span>' +
          '<span class="tm">' + hhmm(r.created_at) + '</span><span class="it">' + esc(names) + '</span>' +
          payTag(r.payment_method) + refundTag(r) + '<span class="sm">' + money(r.total) + '</span></button>';
      }).join('');
    $('rc-list').querySelectorAll('.rc-row').forEach(function (b) {
      b.addEventListener('click', function () { openReceipt(b.dataset.id); });
    });
  }

  function openReceipt(id) {
    rc.current = rc.list.filter(function (r) { return r.id === id; })[0];
    rc.sel = {};
    rc.pending = null;
    $('rc-ok').innerHTML = '';
    $('rc-error').textContent = '';
    $('rc-list-view').style.display = 'none';
    $('rc-detail-view').style.display = '';
    renderReceipt();
  }

  function selectedRefund() {
    var r = rc.current, sum = 0, items = [];
    var ratio = Number(r.subtotal) > 0 ? Number(r.total) / Number(r.subtotal) : 1;
    (r.items || []).forEach(function (i) {
      var q = rc.sel[i.id] || 0;
      if (q > 0) { items.push({ orderItemId: i.id, quantity: q }); sum += Number(i.subtotal) * q / i.quantity * ratio; }
    });
    return { items: items, sum: Math.round(sum * 100) / 100 };
  }

  function renderReceipt() {
    var r = rc.current;
    if (!r) return;
    var cancelled = r.status === 'cancelled';
    var refunded = Number(r.refunded_amount) || 0;
    var lines = (r.items || []).map(function (i) {
      var left = i.quantity - (i.refundedQuantity || 0);
      var q = rc.sel[i.id] || 0;
      return '<div class="rc-line"><span class="n">' + esc(i.name) + ' × ' + i.quantity +
        '<small>' + money(i.subtotal) + (i.refundedQuantity ? ' · возвращено ' + i.refundedQuantity + ' шт.' : '') + '</small></span>' +
        (left > 0 && !cancelled && !rc.pending
          ? '<span class="stp"><button data-id="' + esc(i.id) + '" data-d="-1">−</button><span>' + q + '</span>' +
            '<button data-id="' + esc(i.id) + '" data-d="1">+</button></span>'
          : '<span class="muted" style="margin:0">' + (left > 0 ? '' : 'возвращено') + '</span>') + '</div>';
    }).join('');
    var sel = selectedRefund();
    var hist = (r.history || []).map(function (h) {
      return '<div>' + new Date(h.createdAt).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) + ' · ' +
        (h.kind === 'refund' ? 'возврат ' + money(h.amount) : 'оплата изменена на «' + (h.newPaymentMethod === 'card' ? 'карта' : 'наличные') + '»') +
        (h.approvedBy ? ' · подтвердил ' + esc(h.approvedBy) : '') + (h.reason ? ' · ' + esc(h.reason) : '') + '</div>';
    }).join('');
    var other = r.payment_method === 'card' ? 'cash' : 'card';
    var html = '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">' +
      '<div><h2 style="margin:0">' + esc(r.order_number) + '</h2><div class="muted" style="margin:4px 0 0">' +
      new Date(r.created_at).toLocaleString('ru-RU') + (r.cashier ? ' · кассир ' + esc(r.cashier) : '') + '</div></div>' +
      '<div style="text-align:right"><div style="font-size:22px;font-weight:700">' + money(r.total) + '</div>' + payTag(r.payment_method) + refundTag(r) + '</div></div>' +
      (Number(r.discount_amount) > 0 ? '<div class="muted" style="margin:6px 0 0">Скидка ' + money(r.discount_amount) + '</div>' : '') +
      '<div style="margin-top:10px">' + lines + '</div>' +
      (hist ? '<div class="rc-hist"><b>История</b>' + hist + '</div>' : '');
    if (!cancelled && !rc.pending) {
      html += '<label class="label" for="rc-reason">Причина (необязательно)</label>' +
        '<input id="rc-reason" type="text" maxlength="200" placeholder="Например: гость передумал" value="' + esc(rc.reason) + '">' +
        '<div class="rc-actions">' +
        '<button class="btn-danger" id="btn-rc-refund-sel"' + (sel.items.length ? '' : ' disabled') + '>Вернуть выбранное' + (sel.items.length ? ' · ' + money(sel.sum) : '') + '</button>' +
        '<button class="btn-danger" id="btn-rc-refund-all">Вернуть весь чек · ' + money(Number(r.total) - refunded) + '</button>' +
        (refunded > 0 ? '' : '<button class="btn-secondary" id="btn-rc-pay">Сменить оплату на «' + (other === 'card' ? 'Картой' : 'Наличные') + '»</button>') +
        '</div>';
    }
    if (rc.pending) {
      var dots = '';
      for (var k = 0; k < PIN_LEN; k++) dots += '<span class="' + (k < rc.pin.length ? 'filled' : '') + '"></span>';
      html += '<div class="approve-box"><h3>Подтверждение администратора</h3><p class="muted" style="margin:0">' + esc(rc.pending.title) +
        '. Владелец или админ вводит свой PIN.</p><div class="pin-dots">' + dots + '</div><div class="keypad" id="rc-keypad">' +
        ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', 'X'].map(function (key) {
          return '<button data-k="' + key + '"' + (key.length > 0 && isNaN(key) ? ' class="wide"' : '') + '>' +
            (key === 'C' ? 'Стереть' : key === 'X' ? 'Отмена' : key) + '</button>';
        }).join('') + '</div><p class="error" id="rc-pin-error"></p></div>';
    }
    $('rc-detail').innerHTML = html;
    $('rc-detail').querySelectorAll('.stp button').forEach(function (b) {
      b.addEventListener('click', function () {
        var it = (r.items || []).filter(function (x) { return x.id === b.dataset.id; })[0];
        var left = it.quantity - (it.refundedQuantity || 0);
        rc.reason = ($('rc-reason') || {}).value || rc.reason;
        rc.sel[it.id] = Math.max(0, Math.min(left, (rc.sel[it.id] || 0) + Number(b.dataset.d)));
        renderReceipt();
      });
    });
    var pick = function (id, fn) { var el = $(id); if (el) el.addEventListener('click', fn); };
    pick('btn-rc-refund-sel', function () { startAction('refund', selectedRefund().items, 'Возврат ' + money(selectedRefund().sum)); });
    pick('btn-rc-refund-all', function () {
      var all = (r.items || []).map(function (i) { return { orderItemId: i.id, quantity: i.quantity - (i.refundedQuantity || 0) }; })
        .filter(function (x) { return x.quantity > 0; });
      startAction('refund', all, 'Возврат всего чека ' + money(Number(r.total) - refunded));
    });
    pick('btn-rc-pay', function () { startAction('payment_change', other, 'Смена оплаты на «' + (other === 'card' ? 'карта' : 'наличные') + '»'); });
    if ($('rc-keypad')) {
      $('rc-keypad').querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function () { approveKey(b.dataset.k); });
      });
    }
  }

  function startAction(kind, payload, title) {
    rc.reason = (($('rc-reason') || {}).value || '').trim();
    // refundId создаётся один раз на действие: повтор после обрыва сети не вернёт деньги дважды
    rc.pending = { kind: kind, payload: payload, title: title, refundId: uuid() };
    rc.pin = '';
    $('rc-ok').innerHTML = '';
    $('rc-error').textContent = '';
    renderReceipt();
  }

  async function approveKey(k) {
    if (!rc.pending || state.busy) return;
    if (k === 'X') { rc.pending = null; rc.pin = ''; renderReceipt(); return; }
    if (k === 'C') { rc.pin = rc.pin.slice(0, -1); renderReceipt(); return; }
    if (rc.pin.length < PIN_LEN) rc.pin += k;
    renderReceipt();
    if (rc.pin.length < PIN_LEN) return;
    state.busy = true;
    var p = rc.pending;
    try {
      var ap = await posApi('/api/auth/cash-register/approve', {
        method: 'POST',
        body: JSON.stringify({ registerId: state.register.id, pin: rc.pin, action: p.kind }),
      });
      var url = '/api/pos/receipts/' + encodeURIComponent(rc.current.id) + (p.kind === 'refund' ? '/refund' : '/payment-method');
      var body = { refundId: p.refundId, approvalToken: ap.approvalToken, reason: rc.reason || undefined };
      if (p.kind === 'refund') body.items = p.payload; else body.paymentMethod = p.payload;
      var d = await posApi(url, { method: 'POST', body: JSON.stringify(body) });
      var res = d.refund || d.change || {};
      rc.pending = null;
      rc.sel = {};
      rc.reason = '';
      $('rc-ok').innerHTML = '<div class="ok-msg">' + (p.kind === 'refund'
        ? '↩️ Возврат ' + money(res.amount) + ' оформлен (подтвердил ' + esc(ap.approverName) + ').' +
          (res.paymentMethod === 'cash' ? ' Выдайте наличные из кассы.' : ' Верните деньги на карту через терминал.')
        : '✅ Оплата изменена на «' + (res.paymentMethod === 'card' ? 'карта' : 'наличные') + '» (подтвердил ' + esc(ap.approverName) + ')') + '</div>';
      await loadReceipts();
    } catch (err) {
      rc.pin = '';
      renderReceipt();
      var el = $('rc-pin-error');
      if (err.status === 403 && /разблокируйте|PIN кассира|сесси/i.test(err.message)) return lockScreen(err.message);
      if (el && (err.status === 401 || err.status === 429 || err.code === 'NO_ADMIN_PIN')) { el.textContent = err.message; }
      else { rc.pending = null; renderReceipt(); $('rc-error').textContent = '❌ ' + err.message; }
    } finally {
      state.busy = false;
    }
  }

  $('btn-receipts').addEventListener('click', function () {
    $('checks-panel').style.display = 'none';
    $('receipts-panel').style.display = '';
    $('rc-list-view').style.display = '';
    $('rc-detail-view').style.display = 'none';
    rc.current = null;
    rc.pending = null;
    $('rc-ok').innerHTML = '';
    $('rc-list').innerHTML = '<p class="muted">Загрузка…</p>';
    loadReceipts();
  });
  $('btn-receipts-close').addEventListener('click', function () { rc.pending = null; $('receipts-panel').style.display = 'none'; });
  $('btn-rc-back').addEventListener('click', function () {
    rc.current = null; rc.pending = null; $('rc-ok').innerHTML = '';
    $('rc-detail-view').style.display = 'none'; $('rc-list-view').style.display = ''; renderReceipts();
  });
  $('btn-rc-refresh').addEventListener('click', loadReceipts);
  $('rc-date').addEventListener('change', loadReceipts);
  var rcSearchTimer = null;
  $('rc-search').addEventListener('input', function () { clearTimeout(rcSearchTimer); rcSearchTimer = setTimeout(loadReceipts, 400); });
  document.addEventListener('keydown', function (e) {
    if (!rc.pending || $('receipts-panel').style.display === 'none') return;
    if (/^[0-9]$/.test(e.key)) approveKey(e.key);
    else if (e.key === 'Backspace') approveKey('C');
    else if (e.key === 'Escape') approveKey('X');
  });

  // ── старт ──
  // После перезагрузки планшета — всегда экран PIN: входа кассира не держим
  (function init() {
    state.device = loadDevice();
    // Чужой вход (владелец в админке этого же браузера) не трогаем — гасим только кассирский
    var cur = AUTH.getUser() || {};
    if ((cur.enterpriseRole || cur.enterprise_role) === 'cashier') dropCashierAuth();
    if (!state.device || !state.device.token) return show('activate-screen');
    openPin();
  })();
})();
