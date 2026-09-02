---
type: service
status: stable
last_verified: 2026-09-02
sources:
  - services/frontend-service/
  - frontend/admin-panel/
  - frontend/customer-app/
  - frontend/css/tokens.css
---

# frontend-service

Статический сервер для админ-панели + customer-app.

- **Порт**: 3000 (`services/frontend-service/index.js:5`)
- **Тип**: plain Node.js, без TypeScript
- **Раздаёт**: `frontend/admin-panel/*.html`, `frontend/customer-app/*.html`, `frontend/css/`, `frontend/assets/`

## Точка входа (с 2026-09-01)

`frontend/index.html` — корневая страница: залогиненного ведёт в админку (`super_admin` → `super-admin.html`, `cashier` → `pos.html`, остальные → `dashboard.html`), гостя на `login.html`. Отдаётся `express.static` раньше серверного роута `/` (`services/frontend-service/index.js:15`), поэтому меняется без пересборки образа.

Публичная B2C-витрина `customer-app/index.html` **отключена** — заменена редиректом. Розничный заказ теперь оформляется только на кассе (`admin-panel/pos.html`, см. ниже).

## Design system

Тема **«Базилик и томат»** (направление 1b, коммит `dedcecb`): фон `#F6F1E4`, поверхность `#FFFDF7`, зелёный `#2E7D4F`, томатный `#D94F30`, шрифты Bitter + Onest. Токены — `frontend/css/tokens.css`.

Предыдущая Sedap-тема (`840546d`, зелёный `#00B074`, Barlow) полностью вычищена коммитом `82b1d32`: фавикон вынесен в `frontend/assets/favicon.svg`, иконки аватара используют `currentColor` + `--color-primary`, цвета графиков дашборда читаются из токенов через `getComputedStyle`.

**Не переведено на дизайн-систему**: `frontend/delivery-dashboard/index.html` (системный шрифт, `#2196F3`, `tokens.css` не подключён) и KDS — канвас направления 1b предполагал для него тёмную тему с тач-кнопками от 56px, реализован светлый на общем шелле.

- **Бренд**: `frontend/assets/logo.png` — единый лого на всех страницах.
- **Моб. адаптив**: sidebar collapse на всех страницах.
- **Kong наружу**: `docker-compose.yml` экспонирует порт 8000 (раньше internal-only) — нужен фронту для API-вызовов.

## Что ходит в реальный API vs LocalStorage

Состояние на 2026-04-16. Миграция с LocalStorage-first архитектуры идёт постранично.

### ✅ На реальном API
- **`pos.html`** (коммит `4e03a4f`) — кассовый экран: меню и модификаторы из restaurant-service, `POST /api/orders`, платёж и кассовая операция в finance-service. Единственное место, где создаётся розничный заказ.
- **`dashboard.html`** (коммит `17a7b92`) — KPI cards и recent orders через `GET /api/orders`. Chart.js: doughnut по order types + line 7-day trend. Graceful fallback на mock если API недоступен.
- **`customer-app/index.html`** (коммит `a53f75c`) — меню через `GET /api/restaurants/:id/menu-items`, заказ через `POST /api/orders` (гостевой checkout через `optionalAuth`). Payload строго по Joi-схеме: `menuItemId + quantity`, цены считает backend.
- **`login.html`, `index.html`** — auth через `js/auth.js` → `user-service`.

### ⚠️ Всё ещё LocalStorage (миграция в процессе)
- `tables.html`, `hall-designer.html` — столы, бронирования, планировки залов. Hall-designer поддерживает drag-and-drop, фигурные столы, декорации, экспорт JSON.
- `inventory.html` — склад.
- Остальные страницы (menu/orders/kds/staff/loyalty/analytics/calls/settings/user-profile) в редизайне получили новую вёрстку, но data-source нужно проверять индивидуально.

**Правило проверки**: grep по странице на `fetch(`, `axios.`, `API_BASE` → если нет, скорее всего LocalStorage. При ingest новых правок — обновлять этот список.

### Следствие
Реальная зрелость системы **растёт**: customer-app и дашборд уже на API. Но админка пока гибрид. При разработке фич всегда смотреть, куда ходит конкретная страница.

## Страницы админки (16 шт.)
- `login.html`, `index.html`, `dashboard.html` — вход, главная, аналитический дашборд
- `menu.html`, `orders.html`, `tables.html`, `hall-designer.html`
- `kds.html` — Kitchen Display → [[services/kitchen-service]]
- `inventory.html` — склад → [[services/inventory-service]]
- `staff.html` — штат → [[services/hr-service]]
- `loyalty.html` — CRM/лояльность → [[services/crm-service]]
- `analytics.html` — финансы/аналитика → [[services/finance-service]]
- `calls.html` — звонки → [[concepts/telephony]]
- `settings.html`, `user-profile.html`
- `js/auth.js` — клиент [[concepts/auth]]

## Customer-app
- `frontend/customer-app/index.html` — single-page B2C витрина. Меню + корзина + checkout. Использует реальный restaurant UUID, идёт в `restaurant-service` и `order-service`.
