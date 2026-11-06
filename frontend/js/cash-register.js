/**
 * FoodFlow — режим кассы для планшета.
 *
 * Сценарий:
 *   1. Вход кассира по email/паролю.
 *   2. Выбор кассы точки; если смена закрыта — открыть её прямо здесь.
 *   3. PIN кассира → сессия режима кассы (X-Register-Session).
 *   4. Продажи через POST /api/pos/sales (атомарно: заказ + платёж + касса).
 *   5. «Заблокировать» — касса ждёт PIN, продажи на сервере запрещены.
 *
 * Адрес: /cash-register.html (необязательно ?registerId=<uuid> — сразу эта касса).
 * Модальных диалогов браузера нет намеренно: во встроенных браузерах и
 * киоск-режимах планшетов alert/confirm заблокированы, кнопка выглядит мёртвой.
 */
(function () {
  'use strict';

  // const AUTH из /js/auth.js — глобальная лексическая переменная, в window её нет
  var KIOSK_KEY = 'ff_kiosk';

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
    restaurant: null,      // { id, name }
    register: null,        // строка cash_registers
    sessionId: null,
    categories: [],
    items: [],
    category: 'all',
    cart: [],              // { item, qty }
    method: 'cash',
    pin: '',
    pinMode: 'verify',     // verify | unlock
    busy: false,
  };

  function saveKiosk() {
    localStorage.setItem(KIOSK_KEY, JSON.stringify({
      restaurantId: state.restaurant && state.restaurant.id,
      registerId: state.register && state.register.id,
      sessionId: state.sessionId,
    }));
  }
  function loadKiosk() {
    try { return JSON.parse(localStorage.getItem(KIOSK_KEY) || '{}'); } catch (e) { return {}; }
  }

  // ── экраны ──
  var SCREENS = ['login-screen', 'setup-screen', 'pin-screen', 'till-screen'];
  function show(id) {
    SCREENS.forEach(function (s) { $(s).classList.toggle('active', s === id); });
  }

  // ── запросы ──
  // Своя обёртка вместо AUTH.fetch: тот при 401 уводит на вход админки,
  // а кассира надо вернуть на экран входа кассы.
  async function api(url, options) {
    options = options || {};
    var headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    var token = AUTH.getToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    var res = await window.fetch(url, Object.assign({}, options, { headers: headers }));
    // 401 от PIN-эндпоинтов — это «неверный PIN», а не протухший токен
    if (res.status === 401 && token && url.indexOf('/api/auth/') !== 0) {
      try {
        headers.Authorization = 'Bearer ' + (await AUTH._refresh());
        res = await window.fetch(url, Object.assign({}, options, { headers: headers }));
      } catch (e) {
        logout('Сессия истекла — войдите снова');
        throw new Error('Сессия истекла');
      }
    }
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      var err = new Error(body.message || body.error || ('Ошибка ' + res.status));
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  function logout(msg) {
    localStorage.removeItem('ff_token');
    localStorage.removeItem('ff_refresh_token');
    localStorage.removeItem('ff_user');
    localStorage.removeItem(KIOSK_KEY);
    state.sessionId = null;
    state.cart = [];
    state.items = [];
    $('login-password').value = '';
    $('login-error').textContent = msg || '';
    show('login-screen');
  }

  // ── 1. вход ──
  $('login-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var btn = $('btn-login');
    $('login-error').textContent = '';
    btn.disabled = true;
    try {
      var data = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: $('login-email').value.trim(), password: $('login-password').value }),
      });
      var user = data.user || {};
      localStorage.setItem('ff_token', data.accessToken || (data.tokens && data.tokens.accessToken));
      localStorage.setItem('ff_refresh_token', data.refreshToken || (data.tokens && data.tokens.refreshToken));
      localStorage.setItem('ff_user', JSON.stringify(Object.assign({}, user, {
        enterpriseId: user.enterpriseId || user.enterprise_id || null,
        enterpriseRole: user.enterpriseRole || user.enterprise_role || null,
      })));
      $('login-password').value = '';
      await setup();
    } catch (err) {
      $('login-error').textContent = err.status === 401 ? 'Неверный логин или пароль' : err.message;
    } finally {
      btn.disabled = false;
    }
  });

  // ── 2. точка и касса ──
  async function setup() {
    show('setup-screen');
    $('setup-title').textContent = 'Выбор кассы';
    $('setup-hint').textContent = 'Загрузка…';
    $('setup-list').innerHTML = '';
    $('open-shift').style.display = 'none';
    $('setup-error').textContent = '';
    try {
      var r = await api('/api/restaurants');
      var rests = r.restaurants || r.data || [];
      if (!rests.length) {
        $('setup-hint').textContent = 'У организации нет ни одной точки — заведите её в админке.';
        return;
      }
      var saved = loadKiosk();
      state.restaurant = rests.filter(function (x) { return x.id === saved.restaurantId; })[0] || rests[0];
      await pickRegister();
    } catch (err) {
      $('setup-hint').textContent = '';
      $('setup-error').textContent = 'Не удалось загрузить кассы: ' + err.message;
    }
  }

  async function pickRegister() {
    var d = await api('/api/finance/registers?restaurantId=' + encodeURIComponent(state.restaurant.id));
    var regs = d.registers || [];
    if (!regs.length) {
      $('setup-hint').textContent = 'На точке «' + state.restaurant.name + '» нет кассы. Владелец заводит её в админке: Устройства → Кассы.';
      return;
    }
    var wanted = new URLSearchParams(location.search).get('registerId') || loadKiosk().registerId;
    var open = regs.filter(function (x) { return x.status === 'open'; });
    // На точке может быть открыта только одна смена — её и берём
    var reg = open[0] || regs.filter(function (x) { return x.id === wanted; })[0] || (regs.length === 1 ? regs[0] : null);
    if (reg) return useRegister(reg);

    $('setup-hint').textContent = state.restaurant.name + ' — выберите кассу:';
    $('setup-list').innerHTML = regs.map(function (x) {
      return '<button class="choice" data-id="' + esc(x.id) + '">' + esc(x.name) +
        ' <span class="badge closed">смена закрыта</span></button>';
    }).join('');
    $('setup-list').querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        useRegister(regs.filter(function (x) { return x.id === b.dataset.id; })[0]);
      });
    });
  }

  function useRegister(reg) {
    state.register = reg;
    saveKiosk();
    if (reg.status !== 'open') {
      $('setup-title').textContent = reg.name;
      $('setup-hint').textContent = 'Смена на этой кассе закрыта. Пересчитайте наличные и откройте смену.';
      $('setup-list').innerHTML = '';
      $('open-shift').style.display = '';
      return;
    }
    openPin('verify');
  }

  $('btn-open-shift').addEventListener('click', async function () {
    var btn = this;
    var sum = parseFloat(String($('opening-balance').value).replace(',', '.'));
    if (!(sum >= 0)) { $('setup-error').textContent = 'Укажите сумму (0, если касса пустая)'; return; }
    btn.disabled = true;
    $('setup-error').textContent = '';
    try {
      var d = await api('/api/finance/registers/' + state.register.id + '/open', {
        method: 'POST',
        body: JSON.stringify({ restaurantId: state.restaurant.id, openingBalance: sum }),
      });
      state.register = d.register;
      saveKiosk();
      openPin('verify');
    } catch (err) {
      $('setup-error').textContent = err.message === 'Register already open for this restaurant'
        ? 'На точке уже открыта смена на другой кассе' : 'Смена не открыта: ' + err.message;
    } finally {
      btn.disabled = false;
    }
  });

  // ── 3. PIN ──
  function renderPin() {
    var dots = '';
    for (var i = 0; i < 6; i++) dots += '<span class="' + (i < state.pin.length ? 'filled' : '') + '"></span>';
    $('pin-dots').innerHTML = dots;
  }
  (function buildKeypad() {
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', 'OK'];
    $('keypad').innerHTML = keys.map(function (k) {
      return '<button data-k="' + k + '"' + (k.length > 1 ? ' class="wide"' : '') + '>' + (k === 'C' ? 'Стереть' : k) + '</button>';
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

  function openPin(mode) {
    state.pinMode = mode;
    state.pin = '';
    $('pin-error').textContent = '';
    $('pin-title').textContent = mode === 'unlock' ? '🔒 Касса заблокирована' : 'Введите PIN кассира';
    $('pin-hint').textContent = (state.register ? state.register.name + ' · ' : '') +
      (mode === 'unlock' ? 'Чтобы продолжить продажи, введите PIN.' : 'PIN выдаёт владелец при заведении кассира.');
    renderPin();
    show('pin-screen');
  }

  async function pressKey(k) {
    if (state.busy) return;
    if (k === 'C') { state.pin = state.pin.slice(0, -1); renderPin(); return; }
    if (k !== 'OK') {
      if (state.pin.length < 6) state.pin += k;
      renderPin();
      if (state.pin.length < 6) return;
    }
    if (state.pin.length < 4) { $('pin-error').textContent = 'PIN — от 4 до 6 цифр'; return; }
    state.busy = true;
    try {
      var d = await api('/api/auth/cash-register/' + state.pinMode, {
        method: 'POST',
        body: JSON.stringify({ pin: state.pin, registerId: state.register.id }),
      });
      state.sessionId = d.registerSessionId;
      saveKiosk();
      await openTill();
    } catch (err) {
      if (err.status === 401 && !(err.body && err.body.error === 'Invalid PIN')) {
        logout('Сессия истекла — войдите снова');
      } else {
        $('pin-error').textContent = err.message;
      }
    } finally {
      state.pin = '';
      renderPin();
      state.busy = false;
    }
  }

  // ── 4. продажи ──
  function isStopped(it) {
    if (it.is_available === false) return true;
    if (!it.stopped_at) return false;
    return !(it.stop_until && new Date(it.stop_until) < new Date());
  }

  async function openTill() {
    show('till-screen');
    var user = AUTH.getUser() || {};
    $('till-register').textContent = state.register.name;
    $('till-sub').textContent = state.restaurant.name + ' · ' +
      ((user.first_name || '') + ' ' + (user.last_name || '')).trim();
    $('till-error').textContent = '';
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
  }

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
    // Состав чека изменился — это уже другая продажа, нужен новый saleId
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

  // saleId живёт до успешной продажи: повтор после обрыва сети не пробьёт чек дважды
  var pendingSaleId = null;

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
          orderType: 'pickup',
          paymentMethod: state.method,
          items: state.cart.map(function (r) { return { menuItemId: r.item.id, quantity: r.qty }; }),
        }),
      });
      pendingSaleId = null;
      state.cart = [];
      renderGrid();
      renderCart();
      var sale = d.sale || {};
      $('till-ok').innerHTML = '<div class="ok-msg">✅ Оплачено ' + money(sale.total) +
        (sale.orderNumber ? ' · чек ' + esc(sale.orderNumber) : '') + '</div>';
    } catch (err) {
      if (err.status === 403 && /PIN|сесси/i.test(err.message)) {
        openPin(/заблокир/i.test(err.message) ? 'unlock' : 'verify');
        $('pin-error').textContent = err.message;
      } else {
        $('till-error').textContent = '❌ Не оплачено: ' + err.message;
      }
    } finally {
      state.busy = false;
      btn.disabled = !state.cart.length;
    }
  });

  $('btn-lock').addEventListener('click', async function () {
    try {
      await api('/api/auth/cash-register/lock', {
        method: 'POST',
        body: JSON.stringify({ registerId: state.register.id }),
      });
    } catch (err) {
      // Экран блокируем в любом случае: планшет не должен оставаться
      // открытым из-за сбоя сети
      console.warn('lock:', err.message);
    }
    openPin('unlock');
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
      await api('/api/auth/cash-register/lock', {
        method: 'POST',
        body: JSON.stringify({ registerId: state.register.id }),
      }).catch(function () {});
      state.sessionId = null;
      state.cart = [];
      saveKiosk();
      await setup();
    } catch (err) {
      $('till-error').textContent = 'Смена не закрыта: ' + err.message;
    }
  });

  document.querySelectorAll('[data-action="logout"]').forEach(function (b) {
    b.addEventListener('click', function () { logout(''); });
  });

  // ── старт ──
  // После перезагрузки планшета к продажам пускаем только через PIN
  (async function init() {
    if (!AUTH.isLoggedIn()) return show('login-screen');
    var saved = loadKiosk();
    await setup();
    if (saved.sessionId && state.register && state.register.status === 'open' &&
        state.register.id === saved.registerId) {
      state.sessionId = saved.sessionId;
      openPin('unlock');
    }
  })();
})();
