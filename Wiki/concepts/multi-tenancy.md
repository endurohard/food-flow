---
type: concept
status: broken
last_verified: 2026-04-11
sources:
  - database/migrations/006_add_enterprises_multi_tenant.sql
  - database/migrations/015_chain_management.sql
  - docs/MULTI_TENANT_GUIDE.md
  - docs/MULTI_TENANT_QUICK_START.md
  - services/user-service/src/middleware/enterprise.middleware.ts
  - services/user-service/src/services/enterprise.service.ts
---

# Multi-tenancy

Архитектура multi-tenant добавлена миграцией `006_add_enterprises_multi_tenant.sql` и расширена `015_chain_management.sql` (управление сетями ресторанов — несколько точек в одном enterprise).

## Модель
- **Enterprise** — верхний уровень (компания / сеть).
- Ресторан принадлежит enterprise.
- Пользователи привязаны к enterprise (вероятно через таблицу-связку или колонку).
- Row-level изоляция: каждый запрос несёт `enterprise_id`, бизнес-сервисы фильтруют по нему.

## Механизм
- **Источник истины**: [[services/user-service]] — регистрация enterprise, привязка пользователей (`enterprise.routes.ts`, `enterprise.service.ts`).
- **Пропагирование**: `enterprise.middleware.ts` в user-service выдёргивает tenant из JWT и кладёт в request.
- **Остальные сервисы**: должны читать `enterprise_id` из JWT-claim (или заголовка от Kong) и применять в запросах к БД.

## Связанные сущности
- [[services/user-service]] — владелец регистрации
- [[services/restaurant-service]] — рестораны с `enterprise_id`
- [[concepts/auth]] — JWT должен нести `enterprise_id`

## ⚠️ Статус: СЛОМАНО → частично починено (2026-04-11)

См. [[../decisions/2026-04-11-deep-audit]] раздел C1. Middleware `enterprise.middleware.ts` применяется **только в user-service**. Во всех остальных сервисах SQL-запросы не фильтруют по `enterprise_id` — cross-tenant чтение и запись возможны.

**Починено в Phase 1** (2026-04-11, application-level фильтрация):
- **`order-service`**: `list/getById/create/updateStatus` принимают `enterpriseId` из `req.enterpriseId`, `WHERE o.enterprise_id = $X`.
- **`kitchen-service`**: все 3 SQL-запроса фильтруют по `enterprise_id` из JWT.
- **`delivery-service`**: `list/getById/assignDriver/updateStatus` — tenant guard через JOIN на `orders.enterprise_id` (у `deliveries` нет своей колонки).
- **`restaurant-service`**: `getById/update/delete` принимают `enterpriseId`, `WHERE r.enterprise_id = $X`. `GET /:id` теперь через `optionalAuth`.
- **`inventory-service`**: `updateItem/deleteItem/updateWarehouse` — tenant guard.
- **`hr-service`**: `updateStaffProfile/updateSchedule/deleteSchedule/approvePayroll/markPayrollPaid` — все update/delete защищены.
- **`crm-service`**: `updateProfile/updateLoyaltyProgram/updatePromotion` — tenant guard.
- **`finance-service`**: `updatePaymentStatus` — tenant guard.
- **RabbitMQ payloads**: `order.*` события несут `enterpriseId` (H3 частично).
- **Все 9 сервисов компилируются чисто** после правок (`tsc --noEmit`).

**Осталось** (не сделано в Phase 1):
- Consumer-side фильтрация в kitchen/delivery по `enterpriseId` из RabbitMQ payload (сейчас только producer-side публикация несёт).
- `optionalAuth` в `GET /api/orders` и `GET /api/restaurants/:id` — если без JWT, фильтрация не применяется. Для production нужно `authenticateUser`, но это может сломать публичные customer-потоки (список ресторанов для незалогиненных).
- **Read-side** в inventory/hr/crm/finance — `getById` методы без тенант-гарда (там где они есть). Не критично если list() защищён, но даёт возможность enumerate by ID.
- **Inventory deductByTechCards** — принимает `warehouseId` напрямую, tenant guard должен быть на уровне warehouse ownership (мы защитили updateWarehouse, но не добавили проверку `warehouses.enterprise_id = caller` при deduct). Следующий виток.

## 🔑 Важная находка: RLS включена, но не работает
Миграция `006_add_enterprises_multi_tenant.sql` **включает Row Level Security** на `enterprises`, `restaurants`, `menu_categories`, `menu_items`, `orders` с политикой, которая читает `current_setting('app.current_user_id')::UUID` и ищет строку в `enterprise_users`.

Но:
1. **Никто не устанавливает `app.current_user_id`** — ни один сервис не делает `SET LOCAL app.current_user_id = ...` перед запросами. Если бы RLS применялась — все запросы возвращали бы пустой результат (переменная не задана).
2. **`FORCE ROW LEVEL SECURITY` не включено** — значит owner БД (`foodflow` user, которым работают все сервисы) **обходит RLS полностью**.
3. **RLS покрывает только 5 таблиц** из десятков, добавленных в миграциях 008–015. Новые таблицы (`cash_operations`, `loyalty_transactions`, `inventory_stock`, `hr_employees` и т.д.) без RLS совсем.

**Вывод**: RLS — косметический слой на бумаге, реальная изоляция держится только на application-level `WHERE enterprise_id`. Либо:
- (а) закрепить application-level подход и удалить RLS как misleading;
- (б) реально включить RLS: `ALTER TABLE ... FORCE ROW LEVEL SECURITY`, добавить политики на все таблицы, и сделать session-variable-per-request через middleware, которая выполняет `SET LOCAL` в начале каждого request'а внутри транзакции.

Вариант (б) элегантнее, но требует рефакторинга каждого сервиса на pool.connect()+BEGIN+SET LOCAL+query+COMMIT паттерн.

## Открытые вопросы
- Есть ли cross-tenant роли (superadmin)?
- Как фиксить: shared middleware пакет? Или каждый сервис копирует?
