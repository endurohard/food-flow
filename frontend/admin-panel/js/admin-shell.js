/**
 * Общий каркас админки (пара к /css/admin-shell.css).
 *
 * 1. Поиск в шапке — быстрый переход к разделу. Раньше поле «Поиск...»
 *    ни к чему не было привязано. Теперь оно ищет по пунктам меню,
 *    которые видны текущей роли; Ctrl/⌘+K ставит в него курсор.
 * 2. Меню по роли. Страничные скрипты прячут пункты через
 *    el.style.display = 'none', но стили страниц задают .nav-item
 *    display:flex !important — и официант с кассиром видели всё меню.
 *    Здесь такое скрытие усиливается до !important. Группа, все пункты
 *    которой скрыты, прячет и свой заголовок.
 * 3. Счётчики в шапке со значением 0 не показываются.
 * 4. Уведомление (.notification / .dev-toast) закрывается кликом.
 * 5. Широкие таблицы получают обёртку с горизонтальной прокруткой,
 *    чтобы колонка «Действия» не уезжала за край карточки.
 */
(function () {
  'use strict';

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  function isShown(el) {
    return el && el.style.display !== 'none' && getComputedStyle(el).display !== 'none';
  }

  // ── 2. Пустые группы меню ────────────────────────────────────────────
  function syncNavGroups() {
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(function (a) {
      if (a.style.display === 'none' && a.style.getPropertyPriority('display') !== 'important') {
        a.style.setProperty('display', 'none', 'important');
      }
    });
    document.querySelectorAll('.sidebar-nav .nav-section-label').forEach(function (label) {
      var any = false;
      for (var el = label.nextElementSibling; el && !el.classList.contains('nav-section-label'); el = el.nextElementSibling) {
        if (el.classList.contains('nav-item') && isShown(el)) { any = true; break; }
      }
      label.classList.toggle('is-empty', !any);
    });
  }

  // ── 3. Нулевые счётчики ──────────────────────────────────────────────
  function syncCounts() {
    document.querySelectorAll('.topbar .notif-count, .sidebar-nav .nav-badge').forEach(function (c) {
      var t = (c.textContent || '').trim();
      c.classList.toggle('is-zero', t === '' || t === '0');
    });
  }

  // ── 1. Быстрый переход ───────────────────────────────────────────────
  function setupJump() {
    var box = document.querySelector('.topbar-search');
    var input = box && box.querySelector('input');
    if (!input || input.dataset.ffJump) return;
    input.dataset.ffJump = '1';
    input.placeholder = 'Перейти к разделу…';
    input.setAttribute('aria-label', 'Перейти к разделу');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');

    var kbd = document.createElement('span');
    kbd.className = 'ff-kbd';
    kbd.textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K';
    box.appendChild(kbd);

    var list = document.createElement('div');
    list.className = 'ff-jump';
    list.id = 'ffJumpList';
    list.setAttribute('role', 'listbox');
    input.setAttribute('aria-controls', list.id);
    box.appendChild(list);

    var items = [], active = 0;

    function collect() {
      var group = '';
      var out = [];
      document.querySelectorAll('.sidebar-nav > *').forEach(function (el) {
        if (el.classList.contains('nav-section-label')) group = el.textContent.trim();
        else if (el.matches('a.nav-item[href]') && isShown(el)) {
          var label = el.querySelector('span') ? el.querySelector('span').textContent.trim() : el.textContent.trim();
          var svg = el.querySelector('svg');
          out.push({ href: el.getAttribute('href'), label: label, group: group, icon: svg ? svg.outerHTML : '' });
        }
      });
      return out;
    }

    function norm(s) { return s.toLowerCase().replace(/ё/g, 'е'); }

    function render() {
      var q = norm(input.value.trim());
      items = collect().filter(function (it) {
        return !q || norm(it.label).indexOf(q) !== -1 || norm(it.group).indexOf(q) !== -1;
      });
      // Совпадение по названию раздела — выше совпадения по группе
      if (q) items.sort(function (a, b) {
        return (norm(a.label).indexOf(q) === -1) - (norm(b.label).indexOf(q) === -1);
      });
      active = Math.min(active, Math.max(items.length - 1, 0));
      list.innerHTML = items.length
        ? items.map(function (it, i) {
            var a = document.createElement('a');
            a.href = it.href;
            a.setAttribute('role', 'option');
            a.className = i === active ? 'is-active' : '';
            a.innerHTML = it.icon;
            a.appendChild(document.createTextNode(it.label));
            var small = document.createElement('small');
            small.textContent = it.group;
            a.appendChild(small);
            return a.outerHTML;
          }).join('')
        : '<div class="ff-jump-empty">Нет такого раздела</div>';
    }

    function open() { render(); list.classList.add('open'); input.setAttribute('aria-expanded', 'true'); }
    function close() { list.classList.remove('open'); input.setAttribute('aria-expanded', 'false'); }

    input.addEventListener('focus', open);
    input.addEventListener('input', function () { active = 0; open(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { active = Math.min(active + 1, items.length - 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); render(); e.preventDefault(); }
      else if (e.key === 'Enter' && items[active]) { window.location.href = items[active].href; }
      else if (e.key === 'Escape') { input.value = ''; close(); input.blur(); }
    });
    document.addEventListener('click', function (e) { if (!box.contains(e.target)) close(); });
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K' || e.key === 'л' || e.key === 'Л')) {
        e.preventDefault();
        input.focus();
        input.select();
      }
    });
  }

  // ── 4. Уведомления закрываются кликом ────────────────────────────────
  function setupToasts() {
    document.addEventListener('click', function (e) {
      var t = e.target.closest && e.target.closest('.notification, .dev-toast');
      if (!t || e.target.closest('a, button')) return;
      t.classList.remove('show');
      t.style.display = 'none';
      // Следующий показ страница делает через classList.add('show') — вернём display
      setTimeout(function () { t.style.removeProperty('display'); }, 400);
    });
  }

  // ── 5. Прокрутка широких таблиц ──────────────────────────────────────
  function wrapTables(root) {
    (root || document).querySelectorAll('.main-wrapper table').forEach(function (table) {
      if (table.dataset.ffWrapped) return;
      table.dataset.ffWrapped = '1';
      var p = table.parentElement;
      if (!p) return;
      var ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll' || p.classList.contains('ff-table-scroll')) return;
      var wrap = document.createElement('div');
      wrap.className = 'ff-table-scroll';
      p.insertBefore(wrap, table);
      wrap.appendChild(table);
    });
  }

  ready(function () {
    setupJump();
    setupToasts();
    wrapTables();
    syncNavGroups();
    syncCounts();

    // Роль и тип заведения скрывают пункты уже после загрузки (auth.js,
    // страничные скрипты), счётчики обновляются по API — следим за ними.
    var nav = document.querySelector('.sidebar-nav');
    if (nav && window.MutationObserver) {
      new MutationObserver(syncNavGroups).observe(nav, { subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    }
    var counters = document.querySelectorAll('.topbar .notif-count, .sidebar-nav .nav-badge');
    if (window.MutationObserver) {
      var mo = new MutationObserver(syncCounts);
      counters.forEach(function (c) { mo.observe(c, { childList: true, characterData: true, subtree: true }); });
      // stock-alerts.js пересобирает свою кнопку — подхватим новый счётчик
      var right = document.querySelector('.topbar-right');
      if (right) new MutationObserver(function () {
        syncCounts();
        document.querySelectorAll('.topbar .notif-count').forEach(function (c) {
          if (!c.dataset.ffWatch) { c.dataset.ffWatch = '1'; mo.observe(c, { childList: true, characterData: true, subtree: true }); }
        });
      }).observe(right, { childList: true, subtree: true });
      var main = document.querySelector('.main-wrapper');
      if (main) new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          if (muts[i].addedNodes.length) { wrapTables(main); break; }
        }
      }).observe(main, { childList: true, subtree: true });
    }
  });
})();
