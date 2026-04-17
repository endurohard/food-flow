# Frontend ↔ Backend Sync Roadmap

**Дата**: 2026-04-17  
**Контекст**: Deep analysis выявил 3 главные проблемы: роли не синхронизированы, ~60% admin-страниц на mock, нет role-based UI. Шесть фаз от критичного к полировке.

---

## Фаза 1 — Единые роли + requireRole middleware
**Цель**: Backend enforces roles, один enum во всех сервисах.

- [x] `auth.service.ts` (user-service) — `enterpriseRole` включён в JWT payload
- [x] `enterprise.middleware.ts` (user-service) — расширен: `ROLES`, `requireEnterpriseRole`, `requirePermission`, `setRLSContext`
- [x] Все 9 `auth.middleware.ts` — `ROLES` константы + `requireRole` + `req.enterpriseRole` из JWT
- [x] `database/migrations/019_extend_enterprise_roles.sql` — расширен CHECK constraint: добавлены `operator | chef | waiter`
- [x] `kitchen-service` routes (kitchen, station, printer) — `router.use(requireRole(KITCHEN))` 
- [x] `hr-service` routes — `requireRole` по группам: MGMT для HR/payroll/schedules, STAFF для clock-in/out
- [x] `finance-service` routes — MGMT для reports/registers/exports, POS для создания платежей/операций
- [x] `crm-service` routes — MGMT для клиентов/программ/транзакций, POS для points/redeem/apply
- [x] `inventory-service` routes — INVENTORY_OPS (admin/owner/manager/operator) для всего
- [x] `restaurant-service` routes — requireRole на menu CRUD (POST/PUT/DELETE items/categories/modifiers) → MGMT; reservations → POS; stop-list → MGMT+operator; stop-list GET → +chef
- [x] `order-service` routes — discount CRUD → MGMT; tables GET/PUT → POS; tables POST/DELETE → MGMT
- [x] Написать `Wiki/log.md` entry для Phase E
- [x] Commit Phase 1

**Маппинг ролей (финальный)**:
```
MGMT           = admin | owner | manager
POS            = admin | owner | manager | operator | waiter
KITCHEN        = admin | owner | manager | operator | chef
INVENTORY_OPS  = admin | owner | manager | operator
STAFF (clock)  = admin | owner | manager | operator | chef | waiter | employee
```

---

## Фаза 2 — Multi-tenant Phase 1: tenantGuard везде
**Цель**: Закрыть getById без tenant guard на inventory/hr/crm.

- [x] `inventory-service`: `getItem(id, enterpriseId?)` — tenant guard в getById; добавлен `GET /items/:id` маршрут
- [x] `hr-service`: `getStaffProfile(userId, enterpriseId?)` — tenant guard
- [x] `crm-service`: `getCustomerProfile(userId, enterpriseId?)` — tenant guard
- [x] `inventory.deductByTechCards` — warehouse ownership check перед deduction
- [ ] Consumer-side валидация `enterpriseId` в RabbitMQ kitchen/delivery consumers
- [x] `GET /api/orders` — `optionalAuth` → `authenticateUser` (orphan orders закрыты)
- [x] Wiki log entry + commit

---

## Фаза 3 — Role-based UI + logout + единый API_BASE
**Цель**: Frontend отражает реальные права, нет localStorage permission tricks.

- [x] `frontend/js/auth.js` — создан: `getToken/getUser/getRole/isLoggedIn/hasRole/logout/requireAuth/fetch` + silent refresh
- [x] `admin-panel/login.html` — подключён к `POST /api/auth/login`, сохраняет JWT в `ff_token/ff_user`
- [x] Sidebar во всех 14 protected страницах — role-based hiding + logout кнопка
- [x] `AUTH.requireAuth()` на всех 14 страницах — редирект на login при отсутствии токена
- [x] Убрать `settings.html` role editor (localStorage permissions) — он misleading, реальные права на бекенде
- [x] Wiki log entry + commit

---

## Фаза 4 — Подключить mock-страницы к реальному API
**Цель**: Все 8 страниц с mock данными переключить на готовый бекенд.

- [x] `menu.html` — подключён к API: categories/items CRUD, stop/unstop, stop-list
- [x] `tables.html` — подключён к API: GET/POST/PUT tables
- [x] `loyalty.html` — подключён к API: customers, loyalty-programs, promotions CRUD, transactions
- [x] `staff.html` — подключён к API: staff list, schedules (current week), payroll
- [x] `user-profile.html` — подключён к `GET /api/users/profile`, `PUT /api/users/:id`
- [x] `analytics.html` — расширен: revenue + P&L из finance-service, date range picker
- [x] `inventory.html` — write-операции подключены: POST/PUT/DELETE items, POST movements
- [ ] Orphan `delivery-dashboard/` — подключить к `GET /api/deliveries`, Socket.IO tracking; добавить в сайдбар
- [ ] Wiki log entry + commit

---

## Фаза 5 — Новые страницы: Finance + Enterprises
**Цель**: Покрыть самые «мёртвые» части бекенда UI-ом.

- [x] Создана `admin-panel/finance.html` — кассы (открыть/закрыть/операции), платежи, отчёты P&L + revenue, расходы, экспорт в 1С
- [x] Создана `admin-panel/enterprises.html` — список сети, пользователи enterprise (роли, invite, deactivate), benchmarks
- [x] Ссылки на finance.html и enterprises.html добавлены во все 16 страниц сайдбара
- [x] Убрать/merge orphan `order-management/` → уже есть `orders.html`; убрать orphan `kds/` → уже есть `kds.html` с polling
- [ ] Wiki log entry + commit

---

## Фаза 6 — ЮKassa в customer-app checkout
**Цель**: Реальная оплата в B2C витрине.

- [x] `customer-app/index.html` — выбор cash / online в checkout
- [x] При online → `POST /api/finance/online-payment` → редирект на `confirmationUrl`
- [x] Создана `/customer-app/payment-callback.html` — polling статуса из `GET /api/finance/payments?orderId=X`
- [x] Промокод-поле в checkout → `POST /api/crm/promotions/apply` с визуальным feedback
- [x] Исправлен `API_BASE_URL`: `localhost/api` → `localhost:8000/api`
- [x] Wiki log entry + commit

---

## Статус по сессиям

| Дата | Фаза | Статус |
|------|------|--------|
| 2026-04-17 | Phase 1 (роли) | ✅ завершено |
| 2026-04-17 | Phase 2 (tenant) | ✅ завершено (RabbitMQ consumer pending) |
| 2026-04-17 | Phase 3 (UI roles) | ✅ завершено (settings.html role editor pending) |
| 2026-04-17 | Phase 4 (mock→API) | ✅ завершено (delivery-dashboard pending) |
| 2026-04-17 | Phase 5 (new pages) | ✅ завершено (orphan cleanup pending) |
| 2026-04-17 | Phase 6 (YooKassa) | ✅ завершено |
