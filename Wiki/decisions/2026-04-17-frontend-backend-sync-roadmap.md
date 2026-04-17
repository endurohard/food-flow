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
- [ ] Commit Phase 1

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

- [ ] `inventory-service`: `getItem(id, enterpriseId?)` — tenant guard в getById
- [ ] `hr-service`: `getStaffProfile(userId, enterpriseId?)` — tenant guard
- [ ] `crm-service`: `getCustomerProfile(userId, enterpriseId?)` — tenant guard
- [ ] `inventory.deductByTechCards` — проверить что warehouseId принадлежит caller'у
- [ ] Consumer-side валидация `enterpriseId` в RabbitMQ kitchen/delivery consumers
- [ ] `GET /api/orders` — `optionalAuth` → `authenticateUser` (orphan orders закрыть)
- [ ] Wiki log entry + commit

---

## Фаза 3 — Role-based UI + logout + единый API_BASE
**Цель**: Frontend отражает реальные права, нет localStorage permission tricks.

- [ ] `frontend/js/auth.js` (общий модуль) — создать: `getToken()`, `getUser()`, `hasRole(role)`, `logout()`, `API_BASE = 'http://localhost:8000'`
- [ ] `admin-panel/login.html` — подключить к real API (`POST /api/auth/login`), сохранять JWT в `localStorage.token`
- [ ] Sidebar во всех 16 страницах — скрывать пункты по роли: `chef` видит только KDS, `waiter` — заказы/столы, `manager` — всё кроме системных настроек, `admin` — всё
- [ ] Добавить кнопку Logout в sidebar (вызов `logout()` → редирект на login.html)
- [ ] Убрать `settings.html` role editor (localStorage permissions) — он misleading, реальные права на бекенде
- [ ] Wiki log entry + commit

---

## Фаза 4 — Подключить mock-страницы к реальному API
**Цель**: Все 8 страниц с mock данными переключить на готовый бекенд.

- [ ] `menu.html` — подключить к `GET/POST/PUT/DELETE /api/menus/items`, `GET /api/menus/categories`; добавить stop-list кнопки (POST `.../stop`, `.../unstop`)
- [ ] `tables.html` — подключить к `GET /api/tables`, `PUT /api/tables/:id`
- [ ] `loyalty.html` (CRM) — подключить к `GET /api/crm/customers`, `GET /api/crm/loyalty-programs`, `GET /api/crm/promotions`
- [ ] `staff.html` — подключить к `GET /api/hr/staff`, `GET/POST /api/hr/schedules`, `GET /api/hr/payroll`
- [ ] `user-profile.html` — подключить к `GET /api/users/profile`, `PUT /api/users/:id`
- [ ] `analytics.html` — расширить: подключить к `GET /api/finance/reports/revenue`, `GET /api/finance/reports/pnl`
- [ ] `inventory.html` — дочинить: подключить write-операции к `POST/PUT/DELETE /api/inventory/items`, `POST /api/inventory/movements`
- [ ] Orphan `delivery-dashboard/` — подключить к `GET /api/deliveries`, Socket.IO tracking; добавить в сайдбар
- [ ] Wiki log entry + commit

---

## Фаза 5 — Новые страницы: Finance + Enterprises
**Цель**: Покрыть самые «мёртвые» части бекенда UI-ом.

- [ ] Создать `admin-panel/finance.html` — кассы (открыть/закрыть/операции), платежи (список/создать), отчёты (P&L + revenue), расходы, кнопка «Экспорт в 1С»
- [ ] Создать `admin-panel/enterprises.html` — список ресторанов сети, управление пользователями enterprise (invite, роли), benchmarks
- [ ] Убрать/merge orphan `order-management/` → уже есть `orders.html`; убрать orphan `kds/` → уже есть `kds.html` с polling
- [ ] Wiki log entry + commit

---

## Фаза 6 — ЮKassa в customer-app checkout
**Цель**: Реальная оплата в B2C витрине.

- [ ] `customer-app/index.html` — добавить шаг оплаты после создания заказа: выбор cash / online
- [ ] При выборе online → `POST /api/finance/online-payment` → редирект на `confirmationUrl` (ЮKassa)
- [ ] Добавить страницу `/payment-callback.html` — обработка return URL (показать статус из `GET /api/finance/payments?orderId=X`)
- [ ] Добавить промокод-поле в checkout → `POST /api/crm/promotions/apply` перед созданием заказа
- [ ] Wiki log entry + commit

---

## Статус по сессиям

| Дата | Фаза | Статус |
|------|------|--------|
| 2026-04-17 | Phase 1 (роли) | ✅ завершено |
| — | Phase 2 (tenant) | ⬜ не начато |
| — | Phase 3 (UI roles) | ⬜ не начато |
| — | Phase 4 (mock→API) | ⬜ не начато |
| — | Phase 5 (new pages) | ⬜ не начато |
| — | Phase 6 (YooKassa) | ⬜ не начато |
