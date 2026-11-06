/**
 * FoodFlow Cash Register mode (kiosk, e.g. iPad).
 *
 * Flow:
 *   1. Вход по email/паролю (стандартный auth).
 *   2. Пин-ввод кассира -> активируется режим кассы (только продажи).
 *   3. Продажи через POST /api/pos/sales с заголовком X-Register-Session.
 *   4. Блокировка/разблокировка PIN: нажатие "Заблокировать кассу" и ввод PIN
 *      возвращают кассу в режим ожидания; ввод PIN снова включает продажи.
 *
 * URL: /cash-register.html?registerId=<uuid>&restaurantId=<uuid>
 */

(function () {
  'use strict';

  var AUTH = window.AUTH;

  var registerId = new URLSearchParams(window.location.search).get('registerId');
  var restaurantId = new URLSearchParams(window.location.search).get('restaurantId');

  if (!registerId || !restaurantId) {
    document.body.innerHTML =
      '<p style="padding:24px;font-family:sans-serif;color:#cf5b5b">' +
      'Неправильный адрес зала. Откройте /cash-register.html?registerId=...&restaurantId=...</p>';
    return;
  }

  // ---- helpers ----
  function $(id) { return document.getElementById(id); }

  function show(el) { el.classList.add('active'); }
  function hide(el) { el.classList.remove('active'); }
  function hideAll() {
    [loginScreen, pinScreen, tillScreen, lockedScreen].forEach(function (el) { hide(el); });
  }

  var loginScreen = $('login-screen');
  var pinScreen = $('pin-screen');
  var tillScreen = $('till-screen');
  var lockedScreen = $('locked-screen');

  var state = {
    userId: null,
    registerSessionId: null,
    cart: [], // { menuItemId, quantity }
    paymentMethod: 'cash',
    menuLoaded: false,
  };

  // ---- screens ----
  function showLogin() { hideAll(); show(loginScreen); }
  function showPin() { hideAll(); show(pinScreen); }
  function showTill() { hideAll(); show(tillScreen); }
  function showLocked() { hideAll(); show(lockedScreen); }

  // ---- login (email + password) ----
  function doLogin(email, password) {
    return AUTH.fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password }),
    }).then(function (res) {
      if (!res.ok) {
        return res.json().then(function (body) {
          var msg = body && body.message ? body.message : 'Ошибка входа';
          return Promise.reject(new Error(msg));
        });
      }
      return res.json().then(function (data) {
        if (data.user) { localStorage.setItem('ff_user', JSON.stringify(data.user)); }
        if (data.accessToken) { localStorage.setItem('ff_token', data.accessToken); }
        if (data.refreshToken) { localStorage.setItem('ff_refresh_token', data.refreshToken); }
        state.userId = data.user && data.user.id;
        return data;
      });
    });
  }

  // ---- cash register session (PIN) ----
  function doPinVerify(pin) {
    return AUTH.fetch('/api/auth/cash-register/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: pin, registerId: registerId }),
    }).then(function (res) {
      if (!res.ok) {
        return res.json().then(function (body) {
          var msg = body && body.message ? body.message : 'Неверный PIN';
          return Promise.reject(new Error(msg));
        });
      }
      return res.json().then(function (data) {
        state.registerSessionId = data.registerSessionId;
        return data;
      });
    });
  }

  // ---- lock / unlock PIN ----
  function doLock(pin) {
    return AUTH.fetch('/api/auth/cash-register/lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: pin, registerId: registerId }),
    }).then(function (res) {
      if (!res.ok) {
        return res.json().then(function (body) {
          var msg = body && body.message ? body.message : 'Ошибка блокировки';
          return Promise.reject(new Error(msg));
        });
      }
      return res.json();
    });
  }

  function doUnlock(pin) {
    return AUTH.fetch('/api/auth/cash-register/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: pin, registerId: registerId }),
    }).then(function (res) {
      if (!res.ok) {
        return res.json().then(function (body) {
          var msg = body && body.message ? body.message : 'Ошибка разблокировки';
          return Promise.reject(new Error(msg));
        });
      }
      return res.json().then(function (data) {
        state.registerSessionId = data.registerSessionId;
        return data;
      });
    });
  }

  // ---- menu ----
  var menuCache = null;
  function loadMenu() {
    if (menuCache) { return Promise.resolve(menuCache); }
    return AUTH.fetch('/api/restaurants/' + restaurantId + '/menu-items').then(function (res) {
      if (!res.ok) { return Promise.reject(new Error('Не удалось загрузить меню')); }
      return res.json().then(function (data) {
        menuCache = (data && data.items) || [];
        return menuCache;
      });
    });
  }

  function findMenuItem(id) {
    if (!menuCache) { return null; }
    return menuCache.filter(function (m) { return m.id === id; })[0] || null;
  }

  // ---- totals ----
  function money(value) { return Math.round((value || 0) * 100) / 100; }

  function calculateTotal() {
    var sum = 0;
    state.cart.forEach(function (item) {
      var menuItem = findMenuItem(item.menuItemId);
      if (menuItem) { sum += menuItem.price * item.quantity; }
    });
    return money(sum);
  }

  function getPaymentMethod() {
    var radios = document.getElementsByName('payment');
    for (var i = 0; i < radios.length; i += 1) {
      if (radios[i].checked) { return radios[i].value; }
    }
    return 'cash';
  }

  document.querySelectorAll('#pay-methods input').forEach(function (radio) {
    radio.addEventListener('change', function () {
      if (radio.value === 'card') {
        state.paymentMethod = 'card';
      } else {
        state.paymentMethod = 'cash';
      }
    });
  });

  // ---- render ----
  function renderTill() {
    loadMenu().then(function () {
      // menu list
      var list = $('menu-list');
      list.innerHTML = '';
      menuCache.forEach(function (menuItem) {
        var el = document.createElement('div');
        el.className = 'menu-item';
        el.innerHTML =
          '<div class="name">' + escapeHtml(menuItem.name) + '</div>' +
          '<div class="price">' + formatMoney(menuItem.price) + ' ₽</div>' +
          '<div class="qty-controls">' +
            '<button class="qty" data-action="inc" data-id="' + menuItem.id + '">+</button>' +
            '<span class="qty" style="width:28px;text-align:center;font-size:13px;color:var(--color-text-secondary)">0</span>' +
            '<button class="remove" data-action="rm" data-id="' + menuItem.id + '">&times;</button>' +
          '</div>';
        el.querySelector('[data-action="inc"]').addEventListener('click', function () {
          addToCart(menuItem);
        });
        el.querySelector('[data-action="rm"]').addEventListener('click', function () {
          removeFromCart(menuItem);
        });
        list.appendChild(el);
      });

      // cart
      var cartList = $('cart-list');
      var empty = $('cart-empty');
      if (state.cart.length === 0) {
        cartList.innerHTML = '<p style="color:var(--color-text-secondary);font-size:14px">Продуктов нет</p>';
      } else {
        cartList.innerHTML = '';
        state.cart.forEach(function (item) {
          var menuItem = findMenuItem(item.menuItemId);
          if (!menuItem) { return; }
          var div = document.createElement('div');
          div.className = 'cart-item';
          div.innerHTML =
            '<span class="name">' + escapeHtml(menuItem.name) + ' &times; ' + item.quantity + '</span>' +
            '<span class="price">' + formatMoney(menuItem.price * item.quantity) + ' ₽</span>';
          cartList.appendChild(div);
        });
      }

      $('till-total-value').textContent = formatMoney(calculateTotal()) + ' ₽';
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function formatMoney(v) {
    var n = Math.round((v || 0) * 100) / 100;
    return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function addToCart(menuItem) {
    var existing = state.cart.filter(function (i) { return i.menuItemId === menuItem.id; })[0];
    if (existing) { existing.quantity += 1; } else { state.cart.push({ menuItemId: menuItem.id, quantity: 1 }); }
    renderTill();
  }

  function removeFromCart(menuItem) {
    state.cart = state.cart.filter(function (i) { return i.menuItemId !== menuItem.id; });
    renderTill();
  }

  // ---- checkout ----
  function generateUuid() {
    if (window.crypto && crypto.randomUUID) { return crypto.randomUUID(); }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function doCheckout() {
    if (state.cart.length === 0) {
      alert('Сначала добавьте хотя бы один товар.');
      return;
    }
    var paymentMethod = getPaymentMethod();
    var saleRequest = {
      saleId: generateUuid(),
      restaurantId: restaurantId,
      registerId: registerId,
      orderType: 'pickup',
      paymentMethod: paymentMethod,
      items: state.cart.map(function (item) {
        return { menuItemId: item.menuItemId, quantity: item.quantity };
      }),
    };

    var headers = {
      'Content-Type': 'application/json',
    };
    if (state.registerSessionId) {
      headers['X-Register-Session'] = state.registerSessionId;
    }

    AUTH.fetch('/api/pos/sales', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(saleRequest),
    }).then(function (res) {
      if (!res.ok) {
        return res.json().then(function (body) {
          var msg = body && body.message ? body.message : 'Ошибка оплаты';
          return Promise.reject(new Error(msg));
        });
      }
      return res.json();
    }).then(function (data) {
      state.cart = [];
      renderTill();
      var msg = $('success-msg');
      if (!msg) {
        msg = document.createElement('div');
        msg.id = 'success-msg';
        msg.style.cssText = 'margin-top:12px;padding:12px;background:#e8f5e9;color:#1b5e20;text-align:center;font-size:15px;border-radius:8px;border:1px solid #a5d6a7';
        $('cart-list').appendChild(msg);
      }
      msg.textContent = 'Добавлено в чек. Номер продажи: ' + (data && data.sale ? data.sale.orderNumber : '—');
      setTimeout(function () {
        msg.textContent = 'Чек создан. Касса осталась в режиме продаж.';
      }, 2000);
    }).catch(function (err) {
      alert('Ошибка: ' + err.message);
      console.error(err);
    });
  }

  // ---- lock / unlock ----
  function doLock() {
    var pin = $('pin-input').value.trim();
    if (!pin) { $('pin-error').textContent = 'Введите PIN.'; return; }
    $('pin-error').textContent = '';
    doLock(pin).then(function () {
      showLocked();
    }).catch(function (err) {
      $('pin-error').textContent = err.message;
    });
  }

  function doUnlock() {
    var pin = $('unlock-pin').value.trim();
    if (!pin) { $('unlock-error').textContent = 'Введите PIN.'; return; }
    $('unlock-error').textContent = '';
    doUnlock(pin).then(function () {
      showTill();
      renderTill();
    }).catch(function (err) {
      $('unlock-error').textContent = err.message;
    });
  }

  // ---- event bindings ----
  $('btn-login').addEventListener('click', function () {
    var email = $('login-email').value.trim();
    var password = $('login-password').value;
    if (!email || !password) { alert('Введите логин и пароль.'); return; }
    doLogin(email, password).then(function () {
      showPin();
    }).catch(function (err) {
      alert('Ошибка входа: ' + err.message);
    });
  });

  $('btn-verify-pin').addEventListener('click', function () {
    var pin = $('pin-input').value.trim();
    if (!pin) { $('pin-error').textContent = 'Введите PIN.'; return; }
    $('pin-error').textContent = '';
    doPinVerify(pin).then(function () {
      showTill();
      renderTill();
    }).catch(function (err) {
      $('pin-error').textContent = err.message;
    });
  });

  $('btn-lock').addEventListener('click', function () { showPin(); });

  $('btn-unlock').addEventListener('click', doUnlock);

  $('btn-checkout').addEventListener('click', doCheckout);

  // ---- init ----
  showLogin();
})();
