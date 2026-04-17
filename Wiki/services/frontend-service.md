---
type: service
status: stable
last_verified: 2026-04-16
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

## Design system (с 2026-04-16, коммит `840546d`)

Sedap-style: белый sidebar с зелёным акцентом `#00B074`, шрифт Barlow, унифицированные токены в `frontend/css/tokens.css`. Все 16 страниц админки + customer-app переведены. Тёмная тема удалена.

- **Бренд**: `frontend/assets/logo.png` — единый лого на всех страницах.
- **Моб. адаптив**: sidebar collapse на всех страницах.
- **Kong наружу**: `docker-compose.yml` экспонирует порт 8000 (раньше internal-only) — нужен фронту для API-вызовов.

## Что ходит в реальный API vs LocalStorage

Состояние на 2026-04-16. Миграция с LocalStorage-first архитектуры идёт постранично.

### ✅ На реальном API
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
