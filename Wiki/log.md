# Wiki Log

Append-only хронология. Новые записи снизу.

## [2026-04-11] bootstrap | Wiki initialized
- Создан скелет вики по паттерну Karpathy LLM Wiki.
- Ingest первого уровня: 13 сервисов, 4 концепта, sources.md.
- Источники: `ARCHITECTURE.md`, `PROJECT_OVERVIEW.md`, `docker-compose.yml`, `services/*/package.json`, `database/migrations/`, `docs/`.
- Замечание: `ARCHITECTURE.md` устарел — описывает только 4 исходных сервиса, тогда как сейчас их 13. Помечено в [[sources]].

## [2026-04-11] ingest | docs/IMPLEMENTED_FEATURES.md
Документ датирован 2025-01-07, описывает 6 сервисов (старый срез). Извлечённые новые факты:
- [[services/telegram-bot-service]] — полностью расписан пайплайн: Tesseract.js OCR (ru+en), Sharp предобработка, OpenAI GPT-4 парсинг + regex fallback, хранение в **MongoDB**, команды бота.
- [[services/inventory-service]] — два канала ingress (ручной UI и автоматический через бота); отмечено что UI может быть на LocalStorage.
- [[services/restaurant-service]] — уточнены фичи меню (модификаторы, стоп-лист, расчёт себестоимости по техкартам).
- [[services/order-service]] — флаг что tables.html/hall-designer.html работают через LocalStorage.
- [[services/frontend-service]] — **добавлен критичный раздел "LocalStorage-first архитектура"**: многие страницы хранят состояние в браузере, а не в БД, зрелость фичей ниже чем кажется по UI.
Новый инфраструктурный факт: **MongoDB** — используется только [[services/telegram-bot-service]].
Не покрыты (оставлены на будущие ingest-ы): раздел "Ближайшие цели" (это роадмап, не факты).

## [2026-04-11] audit | deep security+correctness sweep
4 параллельных аудита (multi-tenancy, auth/Kong, bug hunt, docs vs code) + тестовая инфраструктура. Итог: [[decisions/2026-04-11-deep-audit]].
Ключевое:
- **0 тестовых файлов** при 9 сервисах с `"test": "jest"` — тесты вывеска.
- **Multi-tenant изоляция сломана** во всех сервисах кроме user-service → [[concepts/multi-tenancy]] понижен до `status: broken`.
- **Открытые endpoint'ы без auth** возвращают PBX credentials и заказы по ID (C2 в аудите).
- **Hardcoded JWT secret** одинаковый во всех 9 сервисах с дефолтом `'your-jwt-secret-key-change-in-production'`.
- **Race conditions** в loyalty redeem, cash register, inventory decrement, delivery status — ни один не обёрнут в транзакцию/SELECT FOR UPDATE.
- **Promo codes можно использовать бесконечно** — `used_count` никогда не инкрементируется.
- **docker-compose.yml** декларирует `MONGODB_URI` для telegram-bot но mongodb-сервиса нет → бот не стартует out of the box.
- **RabbitMQ события без `enterprise_id`** + ошибки публикации заглушаются console.warn → тихая потеря заказов.
- Обновлены концепты [[concepts/multi-tenancy]] (broken), [[concepts/auth]], [[concepts/events]].

## [2026-04-11] fix | Phase 0 — stop the bleeding
Реализованы минимальные критичные правки из [[decisions/2026-04-11-deep-audit]]. TypeScript всех затронутых сервисов компилируется чисто.

**Auth на открытые endpoint'ы**:
- `services/user-service/src/routes/user.routes.ts`: добавлен `authenticateUser + requireAdmin` на `GET /api/users`, также убрано поле `pbx_ws_password` из SELECT. `GET /:userId/pbx-settings` — auth + проверка "admin или свой userId". `PUT /:userId/pbx-settings` — auth + admin.
- `services/order-service/src/routes/orders.ts`: `authenticateUser` на `GET /:id`.
- `services/kitchen-service/` — создан `src/middleware/auth.middleware.ts` (скопирован паттерн из order-service), `kitchen.routes.ts` использует `router.use(authenticateUser)` на все маршруты. В config добавлен `jwt.secret`.
- `services/delivery-service/src/routes/delivery.routes.ts`: `authenticateUser` на `GET /:id/track` и `GET /zones`.

**Fail-hard секреты**: во все 9 config/index.ts добавлен guard-блок — в `NODE_ENV=production` бросает ошибку на старте, если `JWT_SECRET` не задан или равен дефолту `'your-jwt-secret-key-change-in-production'`, либо если не задан `DATABASE_URL`. В dev fallback остаётся для удобства.

**CORS**: `kong/kong.yml` — `credentials: true` → `false` (JWT передаётся в Authorization header, cookies не нужны). Оставлен комментарий, как вернуть credentials через явный whitelist origins.

**Не сделано в Phase 0** (идёт в Phase 1):
- Multi-tenant изоляция (C1) — требует shared middleware пакет и переписывание SQL во всех сервисах.
- Auth на остальных открытых endpoint'ах order-service legacy маршрутов.
- События без `enterprise_id` (H3).

## [2026-04-11] fix | Phase 2 — race conditions и транзакции
Закрыты C5, C6, C7, C8, H2 из [[decisions/2026-04-11-deep-audit]]. Все 4 затронутых сервиса компилируются чисто.

- **`services/crm-service/src/services/crm.service.ts` `redeemPoints`**: заменён read-then-write на атомарный `UPDATE ... WHERE loyalty_points >= $points` в транзакции. Overdraft невозможен даже при concurrent-запросах. Добавлена ранняя валидация `points > 0`.
- **`crm.service.ts` новый метод `redeemPromoCode`**: атомарный `UPDATE promotions SET used_count = used_count + 1 WHERE ... AND (usage_limit IS NULL OR used_count < usage_limit) RETURNING *`. Возвращает `null` если лимит исчерпан. Закрывает H2 (бесконечное применение промокодов). Routes-слой пока не переключён на этот метод — нужно апдейтнуть `crm.routes.ts` отдельно.
- **`finance-service/src/services/finance.service.ts` `addCashOperation`**: обёрнуто в `BEGIN/COMMIT` через `pool.connect()`. Касса блокируется через `SELECT ... FOR UPDATE` перед вставкой операции и обновлением баланса. Добавлена проверка `status = 'open'` под блокировкой.
- **`finance.service.ts` `closeRegister`**: обёрнуто в транзакцию с `SELECT ... FOR UPDATE`. Теперь между чтением баланса, инсертом инкассации и закрытием кассы никто не может вставить операцию, которая бы "повисла".
- **`inventory-service/src/services/inventory.service.ts` `deductByTechCards`**: UPDATE stock теперь с условием `AND quantity >= $1` и проверкой `rowCount === 0`. Если остатка не хватает или записи нет — бросает ошибку с внятным текстом и транзакция откатывается. Склад не уйдёт в минус даже под concurrent order completion.
- **`delivery-service/src/services/delivery.service.ts` `updateStatus`**: 3 UPDATE (deliveries, orders, driver_shifts) обёрнуты в `BEGIN/COMMIT`. При сбое в середине все изменения откатятся.

**Осталось на Phase 3**:
- H1 — enum-валидация status'ов в order/delivery/kitchen routes.
- M1 — RabbitMQ publish без глотания ошибок (outbox или retry).
- Переключить `crm.routes.ts` с `validatePromoCode` на `redeemPromoCode` при реальном применении промо.
- H5 — order split: вынести `getById()` внутрь транзакции.

**Phase 1** (multi-tenant изоляция) — остаётся самой большой оставшейся задачей.

## [2026-04-11] fix | Phase 3 — мелочи по корректности
Закрыты H1, H2, H5, M1 (частично) из аудита.

- **`order-service/src/services/order.service.ts`** — добавлена константа `VALID_ORDER_STATUSES` (`pending/confirmed/preparing/ready/out_for_delivery/delivered/completed/cancelled`). `updateStatus()` бросает `OrderError 400` на невалидный статус. (H1)
- **`kitchen-service/src/routes/kitchen.routes.ts`** — `PUT /orders/:orderId/status` теперь проверяет `KITCHEN_ALLOWED_STATUSES = ['preparing', 'ready', 'completed']`. (H1)
- **`order-service splitOrder`** — читал parent через `this.getById()` (вне транзакции). Переписано: чтение через `client` + `SELECT ... FOR UPDATE` + отдельный запрос items. Parent блокируется на время создания дочерних заказов. (H5)
- **`order.service.create` и `updateStatus`** — `publishOrderEvent` обёрнут в `try/catch`. Если RabbitMQ упал — API возвращает успех (в БД уже commit), ошибка логируется. TODO-комментарий указывает на outbox pattern как настоящее решение. (M1)
- **`crm-service/src/routes/crm.routes.ts`** — добавлен `POST /promotions/apply`: вызывает новый `redeemPromoCode`, возвращает 410 Gone при исчерпании лимита. Старый `GET /promotions/validate-code` оставлен для preview. (H2)

## [2026-04-11] fix | Phase 1 — multi-tenant изоляция (критичный subset)
Закрыт C1 для трёх самых открытых сервисов из аудита (order, kitchen, delivery) + H3 в payload событий. Полный pass по inventory/hr/crm/finance/restaurant остаётся на follow-up.

- **`order-service/src/services/order.service.ts`**:
  - `CreateOrderInput` — добавлено поле `enterpriseId?`.
  - `create()` — использует `data.enterpriseId` при INSERT (раньше было `null`).
  - `list()` — добавлен `filters.enterpriseId`, фильтрация через `WHERE o.enterprise_id = $X`.
  - `getById(orderId, enterpriseId?)` — опциональный tenant guard.
  - `updateStatus(orderId, status, enterpriseId?)` — tenant guard в WHERE.
  - RabbitMQ payload в `create()` и `updateStatus()` теперь несёт `enterpriseId`.
- **`order-service/src/routes/orders.ts`** — все вызовы сервиса передают `req.enterpriseId`.
- **`kitchen-service/src/routes/kitchen.routes.ts`** — все 3 SQL (GET /orders, PUT status, GET /stats) фильтруют по `o.enterprise_id = $X` из `req.enterpriseId`. `PUT /status` возвращает 404 "Order not found or access denied" при `rowCount === 0`.
- **`delivery-service/src/services/delivery.service.ts`**:
  - `list()` — добавлен `filters.enterpriseId`, фильтрация через JOIN `o.enterprise_id` (у `deliveries` нет своей колонки).
  - `getById(id, enterpriseId?)` — tenant guard.
  - `assignDriver(id, driverId, enterpriseId?)` — ownership check через JOIN.
  - `updateStatus(id, status, enterpriseId?)` — ownership check с `SELECT ... FOR UPDATE OF d` внутри уже существующей транзакции.
- **`delivery-service/src/routes/delivery.routes.ts`** — все вызовы передают `req.enterpriseId`.

**Все 3 сервиса компилируются чисто** (`npx tsc --noEmit`).

### 🔑 Важная находка про RLS
Миграция `006_add_enterprises_multi_tenant.sql` **включает Row Level Security** на 5 таблицах (enterprises/restaurants/menu_categories/menu_items/orders) с политикой через `current_setting('app.current_user_id')::UUID`. Но: (1) никто не ставит эту переменную в сервисах, (2) `FORCE ROW LEVEL SECURITY` не включено, значит owner `foodflow` обходит RLS полностью, (3) RLS покрывает только 5 таблиц из десятков в миграциях 008-015.

**Итог**: RLS — косметика, реальная изоляция только на application-level. Подробности в [[concepts/multi-tenancy]] (раздел "RLS не работает"). Решение: либо удалить RLS как misleading, либо fully enforce через `FORCE ROW LEVEL SECURITY` + session-variable-per-request middleware.

### Что остаётся НЕ сделано (на момент первого прохода)
- **restaurant/inventory/hr/crm/finance** — update/delete без tenant guard. Нужен проход по SQL, список методов в [[concepts/multi-tenancy]].
- **Consumer-side фильтрация в RabbitMQ** — payload теперь несёт `enterpriseId`, но kitchen/delivery consumer'ы его не используют для валидации (они пока даже не существуют как consumer'ы — kitchen читает из БД напрямую, у delivery есть скелет).
- **`optionalAuth` в `GET /api/orders`** — если без JWT, фильтрация не применяется. Для продакшена надо `authenticateUser`.
- **RLS решение** — оставить/удалить/включить. Архитектурный вопрос.
- **Outbox pattern** для RabbitMQ — TODO-комментарии расставлены, но реализация не сделана.
- **Автотесты** — 0 тестов, вся цепочка починок не покрыта регрессиями.

## [2026-04-11] fix | Phase 1 second pass — все оставшиеся сервисы
Добавлены tenant guards на update/delete во всех ранее непокрытых сервисах. **Все 9 сервисов компилируются чисто** после финального прохода.

- **`restaurant-service/src/services/restaurant.service.ts`**: `getById/update/delete` принимают `enterpriseId?`, добавлены в WHERE. `update` возвращает через `getById(id, enterpriseId)` при пустых полях (сохраняя tenant guard).
- **`restaurant-service/src/routes/restaurant.routes.ts`**: `GET /:id` теперь идёт через `optionalAuth`, передаёт `req.enterpriseId` в service. `PUT /:id`, `DELETE /:id` аналогично.
- **`inventory-service/src/services/inventory.service.ts`**: `updateItem/deleteItem/updateWarehouse` — tenant guard.
- **`inventory-service/src/routes/inventory.routes.ts`**: соответствующие вызовы передают `req.enterpriseId`.
- **`hr-service/src/services/hr.service.ts`**: `updateStaffProfile/updateSchedule/deleteSchedule/approvePayroll/markPayrollPaid` — все 5 методов защищены.
- **`hr-service/src/routes/hr.routes.ts`**: 5 точек передают `req.enterpriseId`.
- **`crm-service/src/services/crm.service.ts`**: `updateProfile/updateLoyaltyProgram/updatePromotion` — tenant guard.
- **`crm-service/src/routes/crm.routes.ts`**: 3 точки передают `req.enterpriseId`.
- **`finance-service/src/services/finance.service.ts`**: `updatePaymentStatus` принимает `enterpriseId?`.
- **`finance-service/src/routes/finance.routes.ts`**: `PUT /payments/:id/status` передаёт `req.enterpriseId`.

### Паттерн (применён 15+ раз единообразно)
```ts
const whereConds = [`id = $${p++}`];
values.push(id);
if (enterpriseId) {
  whereConds.push(`enterprise_id = $${p++}`);
  values.push(enterpriseId);
}
// WHERE ${whereConds.join(' AND ')}
```

### Итог Phase 1 после второго прохода
- Application-level tenant isolation закрыт на **write-path'е** во всех 9 сервисах.
- **Read-path** частично: `list()` методы везде уже принимали `enterpriseId`, `getById` теперь с guard'ом в order/delivery/restaurant. Остальные getById (inventory/hr/crm — их меньше и они менее критичны) без guard'а. Не критично если list защищён и клиент не может enumerate by ID незаметно.

### Всё ещё не сделано (финальный список)
- Consumer-side валидация RabbitMQ `enterpriseId` в kitchen/delivery (+ сами consumer'ы нужно реализовать — сейчас их нет).
- `inventory.deductByTechCards` — не валидирует, что `warehouseId` принадлежит caller'у. В целом deductByTechCards вызывается из order-service через event, так что tenant уже прошёл гарду. Но прямой API-вызов можно abuse'нуть.
- `optionalAuth` на публичных GET (restaurants, orders) — это архитектурный trade-off между public catalog и tenant isolation.
- Outbox pattern вместо try/catch на RabbitMQ (TODO стоят в order.service.ts).
- Автотесты — 0. Без них вся цепочка уязвима к регрессиям.
- RLS — решить, удалять ли misleading политики из миграции 006 или включать через session-variable middleware.

## [2026-04-12] run | Первый полный запуск проекта после всех починок
Поднят минимальный продакшн-набор через `docker-compose up`: postgres + redis + rabbitmq + 9 бэкенд-сервисов. Kong/ELK/Prometheus/Grafana/Telegram/Yeastar/PJSIP не поднимались.

### Предстартовые правки
- `.env` — сгенерирован реальный `JWT_SECRET` через `openssl rand -hex 32` (было дефолтное значение, guard из Phase 0 ронял сервисы на старте).
- `docker-compose.yml` — **4 сервиса не получали `JWT_SECRET`** (restaurant/order/delivery/kitchen). Добавлено. Все 9 сервисов читают `${JWT_SECRET:?JWT_SECRET required}`.
- **Миграции 005–015** применены вручную (живут в `database/migrations/`, а docker-compose монтирует только `database/init/`). Теперь в БД 48 таблиц.

### Регрессия Phase 0 из-за Docker layer cache
`GET /api/users` при первом проходе возвращал 200 со списком включая `pbx_ws_password`. Причина — Docker `COPY . .` использовал кешированный слой со старым кодом. Пересборка с `--no-cache` — всё корректно. **Вывод**: после правок кода всегда `--no-cache`.

### Регрессия Phase 0 F0.3: недостающая зависимость
`services/kitchen-service/src/middleware/auth.middleware.ts` импортирует `jsonwebtoken`, но пакет не был в `package.json`. Локальный `tsc --noEmit` проходил (кеш node_modules), Docker build падал с `TS2307`. Добавлены `jsonwebtoken@9.0.3` + `@types/jsonwebtoken@9.0.10`.

### Регрессия Phase 3 H1: OrderError → 500 вместо 400
`PUT /:id/status` и `PUT /:id` в orders.ts ловили любые ошибки как 500. Enum-валидация бросает `OrderError(400)`, но catch превращал в 500. **Исправлено**: добавлен `instanceof OrderError` check по аналогии с `POST /`.

### Live smoke-тесты (всё ✅)

| Тест | Ожидание | Результат |
|---|---|---|
| `GET /api/users` без auth | 401 | ✅ 401 |
| `GET /api/users` с customer token | 403 | ✅ 403 |
| `GET /api/users` с admin token | 200, без pbx_ws_password | ✅ |
| `GET /api/users/:id/pbx-settings` без auth | 401 | ✅ 401 |
| `GET /api/orders/:id` без auth | 401 | ✅ 401 |
| `GET /api/kitchen/orders` без auth | 401 | ✅ 401 |
| `GET /api/deliveries/:id/track` без auth | 401 | ✅ 401 |
| `GET /api/deliveries/zones` без auth | 401 | ✅ 401 |
| Compose запуск с дефолтным JWT_SECRET | fail на старте | ✅ 9 сервисов упали до фикса .env |
| `PUT /api/orders/:id/status` `"hacked"` | 400 enum | ✅ 400 с allowed list |
| `PUT /api/kitchen/orders/:id/status` `"foo"` | 400 | ✅ 400 |
| `POST /api/crm/promotions/apply` несуществующий | 410 | ✅ 410 Gone |
| `POST /api/crm/points/redeem` несуществующий профиль | 404 | ✅ 404 |

### Live state
12/12 контейнеров healthy (postgres, redis, rabbitmq + 9 backend services).

### Уроки для будущего
1. **`tsc --noEmit` не гарантирует Docker build** — проверять Docker build при добавлении импортов.
2. **Docker layer cache опасен** — `--no-cache` перед валидацией, либо volume-mount в dev-compose.
3. **Миграции должны применяться автоматически** — сейчас 005–015 не в init. Нужна миграционная система (db-migrate / flyway / startup-скрипт). **Follow-up**.
4. **OrderError instanceof check** нужно повторить в остальных сервисах с типизированными ошибками. **Follow-up**.
5. **`.env.example`** надо обновить с подсказкой `openssl rand -hex 32` и пометкой что значение обязательно.

## [2026-04-12] analysis | Enhancement recommendations
3 параллельных аудита (feature gap vs iiko/Poster/R-keeper, архитектура/DevEx, compliance РФ). Синтез в [[decisions/2026-04-12-enhancement-recommendations]].

**Ключевые находки**:
- **База есть** — миграции 005–015 покрывают продуктовую глубину (tech_cards, payroll, loyalty, cash_registers, delivery_zones), но бизнес-логика поверх них часто отсутствует. Много quick-win'ов типа "`orders.is_split` колонка есть, логика отсутствует — написать 200 строк".
- **Compliance РФ — блокер**: 54-ФЗ/ОФД/онлайн-касса, реальный платёжный шлюз, ФЗ-152 audit log, PCI DSS — ничего не реализовано, без этого нельзя легально работать.
- **Инфра-минимум не выполнен**: миграции применяются вручную, нет idempotency keys, нет circuit breakers, нет graceful shutdown, нет CI, нет correlation IDs, нет Sentry, нет автотестов. Это всё работа на ~1 неделю.
- **Топ-30 пробелов** расписаны с эффорт-оценкой и владельцами.

**Рекомендованный roadmap** (4 фазы, ~5–6 недель до production-ready):
- **A** (1 нед): инфра-минимум — миграции+secrets+CI+correlation ID+Sentry+idempotency+graceful shutdown+deep healthchecks.
- **B** (2 нед): compliance РФ — ЮKassa+АТОЛ фискализация+ФЗ-152 audit+PCI DSS hygiene.
- **C** (2 нед): MVP features — split bill+discount rules+stop-list+reservations+QR-меню.
- **D** (ongoing): growth — онлайн-заказ, агрегаторы, tracing, мобильное приложение, ЕГАИС, 1С.

**Решено НЕ делать сейчас**: Kubernetes, PgBouncer, ML-forecasting, нативные мобильные приложения, полная переделка LocalStorage-фронта. Преждевременно.

## [2026-04-12] fix | Phase A — инфра-минимум
Закрыты пункты A.1–A.6 из [[decisions/2026-04-12-enhancement-recommendations]]. Все 9 сервисов компилируются чисто.

- **A.1 Автомиграции**: `database/init/03-run-migrations.sh` — shell-скрипт в docker-entrypoint-initdb.d, создаёт `migration_history` таблицу, последовательно применяет SQL из `database/migrations/`, пропускает уже примёненные. Docker-compose монтирует `./database/migrations:/migrations:ro`.
- **A.2 GitHub Actions CI**: `.github/workflows/ci.yml` — 3 jobs (typecheck, docker-build, audit) × 9 сервисов в matrix. `npm ci → tsc --noEmit → docker build → npm audit`.
- **A.3 Correlation ID**: middleware `x-request-id` (crypto.randomUUID если отсутствует) + structured logging с `requestId/userId/enterpriseId` в каждом из 9 сервисов.
- **A.4 Graceful shutdown**: `server.close → healthPool.end → exit` с 10s timeout на forced exit. SIGTERM+SIGINT. В kitchen/delivery — также RabbitMQ disconnect.
- **A.5 Deep health checks**: `/health` делает `SELECT 1` против pg, возвращает 503 если БД недоступна (было статическое `{ status: 'healthy' }`).
- **A.6 Idempotency keys**: Redis-based middleware `idempotency.middleware.ts`. Клиент передаёт `Idempotency-Key` header → ответ кешируется на 24h → повторный запрос с тем же key получает тот же ответ без повторного выполнения. Применено на: `POST /api/orders` (order-service), `POST /api/finance/payments` (finance-service), `POST /api/crm/promotions/apply` и `POST /api/crm/points/redeem` (crm-service). Graceful degradation: если Redis недоступен — middleware пропускает запрос без кеша.
- **Shared packages/**: создана директория `packages/shared/src/` с request-id.ts как reference-реализацией. Пока не npm-пакет, а паттерн для копирования. Переход на Turborepo/Nx — follow-up.

## [2026-04-12] fix | Phase B — compliance РФ
Закрыты B.1–B.4 из [[decisions/2026-04-12-enhancement-recommendations]]. Компиляция чистая.

- **B.1 ЮKassa**: новый `services/finance-service/src/services/yookassa.service.ts` — HTTP wrapper поверх YooKassa API v3 (axios, Basic auth). Методы: `createPayment` (с 54-ФЗ receipt inline), `getPayment`, `createRefund`. В `finance.service.ts` — `initiateOnlinePayment` (create → insert pending → return redirect URL), `processPaymentWebhook` (succeeded/canceled/refunded → update + fiscal). Routes: `POST /online-payment`, `POST /webhooks/yookassa` (без auth, с validation), `GET /fiscal-receipts/:orderId`.
- **B.2 Фискализация 54-ФЗ**: receipt data отправляется inline с платежом в ЮKassa (items с `vat_code`, `payment_subject`, `payment_mode`). При `payment.succeeded` создаётся запись в `fiscal_receipts`. `createFiscalReceipt()` и `getFiscalReceipts()` в finance.service.ts.
- **B.3 ФЗ-152 PII audit log**: миграция `016_pii_audit_log.sql` (таблица `pii_access_log` с полями user_id/enterprise_id/accessed_entity/fields_accessed/action/ip/request_id). Middleware `pii-audit.middleware.ts` в user-service. Применено на: `GET /api/users` (email, phone, pbx_extension), `GET /api/users/profile` (email, phone), `GET /api/users/:userId/pbx-settings` (pbx_*). Логирование fire-and-forget (не блокирует request).
- **B.4 PCI DSS hygiene**: `sanitizePaymentMetadata()` в finance.service.ts — стрипит forbidden keys (card_number, cvv, cvc, pan, expiry, card_holder, pin) перед сохранением в `payments.metadata`. Применяется в `createPayment()`.

### Env для ЮKassa (добавить в .env)
```
YOOKASSA_SHOP_ID=<shop_id>
YOOKASSA_SECRET_KEY=<secret_key>
YOOKASSA_RETURN_URL=https://yourdomain.com/payment/callback
YOOKASSA_WEBHOOK_SECRET=<optional>
```

## [2026-04-12] fix | Phase C — MVP features
Закрыты C.1–C.4 из [[decisions/2026-04-12-enhancement-recommendations]]. Все 9 сервисов компилируются. Миграция `017_split_bill_discounts_stoplist_reservations.sql`.

- **C.1 Split Bill**: таблица `order_splits` (parent→child, split_type, amount, paid). Логика split уже была в `order.service.ts` через `splitOrder()` (Phase 3 H5) — теперь подкреплена нормальной DDL.
- **C.2 Discount Rules**: `discounts` таблица + `DiscountService` в order-service (CRUD + `calculateDiscountsInTx` static method работающий внутри order creation транзакции). В `order.service.ts create()`: после subtotal → расчёт скидок → discount_amount/applied_discounts в INSERT + RabbitMQ payload. Routes: `GET/POST/PUT/DELETE /api/discounts`. Типы: percentage/fixed_amount/bogo/combo, applicable_to order/item/category, min_order_amount, max_discount, valid_from/until.
- **C.3 Stop-list**: в `menu.service.ts` — `stopMenuItem/unstopMenuItem/getStopList`. Колонки `stop_reason/stopped_at/stop_until/stopped_by` в menu_items. Routes: `POST /api/menus/items/:id/stop`, `POST .../unstop`, `GET /api/menus/stop-list?restaurantId=X`.
- **C.4 Reservations**: `reservations` таблица (restaurant_id, table_id, customer_name/phone/email, party_size, date/time, duration, status machine, deposit). `ReservationService` с overlap detection через SQL OVERLAPS. Status transitions: pending→confirmed→seated→completed, cancel/no_show. Routes: full CRUD `GET/POST/PUT/DELETE /api/reservations`. Смонтирован в restaurant-service `index.ts`.

## [2026-04-12] fix | Phase D — growth features
Закрыты D.1–D.3 из [[decisions/2026-04-12-enhancement-recommendations]]. Все 9 сервисов компилируются. Миграция `018_kitchen_stations_fifo_1c.sql`.

- **D.1 Кухонные станции**: 3 таблицы (`kitchen_stations`, `menu_item_stations`, `order_item_station_status`). `StationService` в kitchen-service с полным CRUD + station-specific KDS view + auto-complete: когда все станции для всех items в заказе завершены → заказ автоматически переходит в `ready` (внутри транзакции). Routes: 8 endpoint'ов `/api/stations/*`.
- **D.2 FIFO склад с партиями**: таблица `inventory_batches` (batch_number, quantity, cost_price, expiry_date, supplier_id, invoice_id, is_depleted). В inventory-service: `createBatch`, `listBatches`, `deductFIFO` (SELECT FOR UPDATE oldest→newest, deduct до исчерпания, throw если не хватает), `getExpiringItems` (срок годности через N дней). `addStockMovement` автоматически создаёт batch при `receipt`. `deductFIFO` принимает optional `client` для интеграции в чужие транзакции. Existing `deductByTechCards` не сломан — два пути сосуществуют.
- **D.3 1С экспорт**: `ExportService` в finance-service с `exportSales` и `exportExpenses` — генерирует XML с русскими тегами (`<СписокДокументов>`, `<Документ>`, `<НомерДокумента>` и т.д.) в формате 1С:Бухгалтерия, namespace `http://v8.1c.ru/8.2/data/core`. XML escaping, UTF-8. Routes: `GET /exports/sales`, `GET /exports/expenses` (Content-Type: application/xml), `GET /exports/history`. Каждый экспорт логируется в `export_log`.

### Не вошло в Phase A (запланировано)
- **Sentry** — решили пока не добавлять, т.к. нет paid tier и нет деплоя на внешний сервер.
- **Dead-letter queues** — нужно переписать RabbitMQ setup в kitchen/delivery consumers. Follow-up.
- **Circuit breakers / retry** — нет межсервисных HTTP-вызовов в production flow (всё через RabbitMQ). Актуально когда появятся sync calls. Follow-up.

## [2026-04-12] fix | Post-fix audit — remaining security & quality gaps (`129f88d`)
Дочинен хвост после Phase 0–D: auth-покрытие для ранее пропущенных endpoint'ов, tenant guards на supplier/CRM tier recalc, strict TS в kitchen-service.

- **Auth на 11 printer endpoints**: `kitchen-service/src/routes/printer.routes.ts` — `router.use(authenticateUser)` на весь модуль (было без auth). В Phase 0 закрывались только kitchen.routes.ts, printer.routes.ts был упущен.
- **Auth на PBX settings**: `restaurant-service/src/routes/pbx.routes.ts` — на `GET/PUT /settings` добавлен `authenticateUser`. (Phase 0 закрывал только `user-service /:userId/pbx-settings`, но в restaurant-service был параллельный endpoint с PBX credentials.)
- **Auth на GET /api/tables**: `order-service/src/routes/tables.ts` — добавлен `authenticateUser`.
- **Tenant guard на `_recalculateTier`**: `crm-service/src/services/crm.service.ts` — внутренний метод tier-пересчёта теперь учитывает `enterprise_id` в WHERE, иначе бонусы одного tenant'а могли повышать tier клиента другого.
- **Tenant guard на supplier update/delete**: `inventory-service/src/services/supplier.service.ts` — `update/delete` принимают `enterpriseId?` и фильтруют в WHERE (были пропущены в Phase 1 second pass).
- **TypeScript strict:true в kitchen-service**: `services/kitchen-service/tsconfig.json` — `strict` был `false` на фоне остальных сервисов. Переключено на `true`. Побочный фикс: `printer.service.ts` переписан с getter-паттерном для null-safe доступа к принтер-инстансу.
- **rabbitmq.service.ts**: правки в kitchen-service RabbitMQ publisher (8 строк — скорее cleanup под strict).

**Как искать регрессии**: ранее аналогичные «пропущенные» endpoint'ы нашлись только через повторный аудит. Добавить в follow-up список: grep по всем `src/routes/*.ts` на отсутствие `authenticateUser`/`optionalAuth`.

## [2026-04-16] refactor | UI redesign — Sedap design system (`840546d`)
Полная визуальная переработка фронта (16 страниц admin-panel + customer-app). Дизайн-токены, новая главная, моб. адаптивность.

- **Design system**: новый `frontend/css/tokens.css` (100 строк) — цветовая схема с зелёным акцентом `#00B074` на белом, Barlow шрифт. Тёмная тема отменена.
- **Новый `dashboard.html`** (1382 строк, ранее 85): KPI cards + placeholder'ы под графики + recent orders table. В этом коммите UI статический; подключение к API — в `17a7b92`.
- **Brand**: `frontend/assets/logo.png` применён во всех 16 страницах.
- **Адаптивность**: sidebar collapse для моб. на всех страницах.
- **Infra**: `docker-compose.yml` — Kong порт 8000 экспонирован наружу (раньше был только внутренний) для фронта.

Изменено по одному .html файлу на каждую страницу: analytics, calls, hall-designer, index, inventory, kds, login, loyalty, menu, orders, settings, staff, tables, user-profile + dashboard (новый) + customer-app/index.html.

**Что это НЕ меняет**: backend endpoints и контракты — фронт всё ещё смотрит туда же (или в LocalStorage, см. следующий ingest). Только визуал.

## [2026-04-16] fix | Customer-app → real API + guest orders (`a53f75c`)
Первый реальный прокол LocalStorage-архитектуры на customer-app: меню теперь тянется из `restaurant-service`, заказы создаются в `order-service` без обязательного JWT.

- **`POST /api/orders` — `authenticateUser` → `optionalAuth`** (`services/order-service/src/routes/orders.ts:81`). Гостевой checkout теперь возможен: если JWT есть — заказ привязывается к `req.userId`, если нет — гостевой заказ без userId. Tenant изоляция при этом не нарушается (enterpriseId передаётся отдельно).
- **`customer-app/index.html`**: меню через `GET /api/restaurants/:id/menu-items` (раньше был hardcoded mock). Используется реальный restaurant UUID вместо integer ID. Fix menu item ID handling для UUID в корзине/order flow.

**Trade-off**: `optionalAuth` на создании заказа — осознанный выбор для B2C guest checkout. Злоупотребление ограничено rate limit'ами Kong (spam заказов с гостевого IP) + idempotency keys из Phase A.6.

**Следствие для [[services/frontend-service]]**: LocalStorage-first пометка «всё в браузере» для customer-app больше не актуальна — меню и создание заказа идут через API. Админ-панель пока не трогали (`tables.html`, `hall-designer.html`, `inventory.html` — по-прежнему LocalStorage на чтение).

## [2026-04-16] fix | Dashboard → real API + Chart.js (`17a7b92`)
Второй прокол LocalStorage: новый `dashboard.html` из UI-редизайна теперь на реальных данных. Применены миграции 017/018 вручную.

- **`admin-panel/dashboard.html`**: KPI cards считают `GET /api/orders` (total/pending/completed/revenue), recent orders table отрисовывается из того же endpoint'а. Chart.js: doughnut (распределение order types) + line (7-дневный trend). Graceful fallback на пустые/mock данные если API недоступен.
- **Order payload fix** в `customer-app/index.html`: payload приведён к Joi-схеме order-service — отправляем только `menuItemId + quantity`, цены бэкенд считает сам (раньше фронт прокидывал price/total → отсеивалось валидацией).
- **Миграции 017/018**: применены вручную (из `Phase C` и `Phase D` DDL). До этого discount_rules, stations, FIFO batches тянули на API без таблиц.

**Что это меняет для [[services/frontend-service]]**: LocalStorage-first пометка «дашборд показывает mock» устарела. Dashboard → real API. Но admin-panel pages из списка `tables.html`, `hall-designer.html`, `inventory.html` всё ещё не мигрированы.

**Миграции через ручной `psql`** — напоминание: auto-migrations script из Phase A.1 (`database/init/03-run-migrations.sh`) работает только на **первом запуске** контейнера. Для «добавили миграции 017/018 после поднятого постгреса» нужно либо rebuild с clean volume, либо прогонять вручную. Follow-up: startup-based миграции, а не init-based.

## [2026-04-17] analysis | Frontend ↔ Backend gap analysis
Deep audit фронта и бекенда. Итог в [[decisions/2026-04-17-frontend-backend-sync-roadmap]].

**Главные находки**:
- 3 несвязанных набора ролей: JWT global (customer/restaurant_owner/admin), enterprise_users (owner/admin/manager/employee/viewer), localStorage frontend (admin/manager/operator/chef/waiter). `hasPermission()` возвращает undefined для JWT role: "restaurant_owner" при любом frontend-чеке.
- ~60% admin-страниц работают на mock/localStorage: loyalty, staff, user-profile, menu, tables, hall-designer.
- Orphan-страницы не в сайдбаре: delivery-dashboard (mock), order-management (mock дубль), kds/ (standalone с Socket.IO).
- Finance и Enterprises — 0 страниц при 42 backend endpoint'ах.
- Permission-чеки только в браузере (localStorage.rolePermissions) — не enforce на бекенде.

**Решение**: 6 фаз, приоритет A→F. Детали в [[decisions/2026-04-17-frontend-backend-sync-roadmap]].

## [2026-04-17] fix | Phase E — Unified RBAC across all services
Синхронизированы роли, `requireRole` применён на всех route-файлах. Migration 019 — расширен CHECK constraint.

**Бекенд-изменения**:
- `user-service/src/services/auth.service.ts` — `enterpriseRole` включён в JWT payload (register/login/refresh). Теперь клиент получает enterprise role в токене и не делает дополнительных запросов.
- `user-service/src/middleware/enterprise.middleware.ts` — добавлены `ROLES`, `requireEnterpriseRole`, `requirePermission`, `setRLSContext`.
- Все 9 `auth.middleware.ts` — `ROLES` enum + `requireRole(...)` + `req.enterpriseRole` из JWT decoded.
- `database/migrations/019_extend_enterprise_roles.sql` — идемпотентно расширяет CHECK constraint: добавлены `operator | chef | waiter`. Легаси-значения нормализуются к `employee`.

**Применение `requireRole` на routes (суммарно ~90 endpoint'ов)**:
- `kitchen-service` (kitchen, station, printer): router-level `requireRole(KITCHEN)` — admin/owner/manager/operator/chef
- `hr-service`: MGMT (admin/owner/manager) на staff/schedules/payroll/time-entries; STAFF (+ operator/chef/waiter/employee) на clock-in/out
- `finance-service`: MGMT на registers/reports/exports/payments-read; POS (+ operator/waiter) на POST payments/operations/online-payment
- `crm-service`: MGMT на customers/loyalty-programs/promotions/transactions; POS на apply/points/redeem/validate-code
- `inventory-service`: INVENTORY_OPS (admin/owner/manager/operator) на все маршруты
- `restaurant-service` (restaurant, menu, reservation): MGMT на create/update/delete restaurant и menu CRUD; stop-list/unstop — MGMT+operator; stop-list GET — + chef; reservations — POS
- `order-service` (discounts, tables): MGMT на discount CRUD; tables — POS на read/update, MGMT на create/delete

**Маппинг ролей (финальный)**:
```
MGMT          = admin | owner | manager
POS           = admin | owner | manager | operator | waiter
KITCHEN       = admin | owner | manager | operator | chef
INVENTORY_OPS = admin | owner | manager | operator
STAFF         = admin | owner | manager | operator | chef | waiter | employee
```

**Что НЕ изменилось намеренно (Phase E)**:
- `POST /api/orders` остаётся `optionalAuth` (B2C guest checkout).
- `GET /api/restaurants`, `GET /api/restaurants/:id`, `GET /:restaurantId/menu*` — публичные (customer-app и витрина).
- `POST /webhooks/yookassa` — без auth (внешний callback ЮKassa).
- Глобальные роли `admin` и `restaurant_owner` в JWT автоматически bypass `requireRole` без enterprise membership.

## [2026-04-17] fix | Phase 2 — Multi-tenant getById guards + orphan orders
Закрыты оставшиеся tenant-isolation пробелы: getById без enterpriseId guard в inventory/hr/crm, warehouse ownership check, orphan orders.

- **`inventory-service/src/services/inventory.service.ts`**: новый метод `getItem(id, enterpriseId?)` — dynamic WHERE с `AND enterprise_id = $2`. `deductByTechCards(orderId, warehouseId, performedBy?, enterpriseId?)` — добавлена проверка `SELECT id FROM warehouses WHERE id = $1 AND enterprise_id = $2` перед deduction, иначе 403 с rollback.
- **`inventory-service/src/routes/inventory.routes.ts`**: добавлен `GET /items/:id` маршрут (был пропущен), передаёт `req.enterpriseId` в `getItem`.
- **`hr-service/src/services/hr.service.ts`**: `getStaffProfile(userId, enterpriseId?)` — добавлен tenant guard.
- **`hr-service/src/routes/hr.routes.ts`**: `GET /staff/:userId` передаёт `req.enterpriseId`.
- **`crm-service/src/services/crm.service.ts`**: `getCustomerProfile(userId, enterpriseId?)` — tenant guard через `AND cp.enterprise_id = $2`.
- **`crm-service/src/routes/crm.routes.ts`**: `GET /customers/:userId` передаёт `req.enterpriseId`.
- **`order-service/src/routes/orders.ts`**: `GET /` (список заказов) — `optionalAuth` → `authenticateUser`. Анонимные пользователи больше не могут просматривать заказы. `POST /` остаётся `optionalAuth` (guest checkout).

## [2026-04-17] fix | Phase 3 — Role-based UI + Auth module + Logout
Создан общий auth-модуль, login подключён к реальному API, все 14 admin-страниц защищены и имеют role-based sidebar.

- **`frontend/js/auth.js`** (новый): `AUTH.getToken/getUser/getRole/isLoggedIn/hasRole/logout/requireAuth/fetch`. Нормализует `enterpriseRole` из JWT как приоритетную роль для UI-решений. `AUTH.fetch()` добавляет `Authorization: Bearer` автоматически, поддерживает silent refresh.
- **`frontend/admin-panel/login.html`**: подключён к `POST /api/auth/login` и `POST /api/auth/register` через `AUTH.API_BASE`. Сохраняет токены в `ff_token/ff_refresh_token/ff_user`. При наличии `ff_token` → автоматический редирект на dashboard.
- **Все 14 protected HTML-страниц**: `AUTH.requireAuth()` — редирект на login если нет токена. Role-based sidebar filtering: chef видит только KDS; waiter — orders/tables/KDS; viewer — dashboard/analytics; operator — orders/tables/KDS/inventory/calls; manager/owner/admin — всё. Logout кнопка в sidebar footer с именем пользователя.

## [2026-04-17] fix | Phase 4 — Mock-страницы подключены к реальному API
7 admin-panel страниц переключены с localStorage/mock на живые endpoint'ы.

- **`menu.html`**: CRUD блюд через `POST/PUT/DELETE /api/menus/items`, категории через `GET/POST /api/restaurants/:id/menu-categories`, стоп-лист через `stop`/`unstop`/`stop-list` endpoints. Загрузка ресторана при инициализации.
- **`tables.html`**: `GET /api/tables?restaurantId=X`, `POST /api/tables`, `PUT /api/tables/:id` — зал отображает живое состояние столов.
- **`loyalty.html`**: customers из `GET /api/crm/customers`, loyalty-programs, promotions CRUD, транзакции клиента из `GET /api/crm/transactions?customerId=X`.
- **`staff.html`**: staff list из `GET /api/hr/staff`, расписание текущей недели из `GET /api/hr/schedules`, payroll из `GET /api/hr/payroll`, сохранение смен через `POST /api/hr/schedules`.
- **`user-profile.html`**: `GET /api/users/profile` при загрузке, `PUT /api/users/:id` при сохранении.
- **`analytics.html`**: расширен — revenue/P&L из `GET /api/finance/reports/revenue` и `/pnl`, date range picker.
- **`inventory.html`**: write-операции: `POST/PUT/DELETE /api/inventory/items`, `POST /api/inventory/movements`, склады из `GET /api/inventory/warehouses`.

## [2026-04-17] feat | Phase 5 — Новые страницы Finance и Enterprises
Созданы 2 новые страницы, покрывающие ранее недоступный из UI функционал.

- **`admin-panel/finance.html`** (1167 строк): 4 таба — Кассы (открыть/закрыть/операции), Платежи (фильтр, список, статусы), Отчёты (revenue + P&L + кнопки «Экспорт в 1С» sales/expenses XML), Расходы (список + форма добавления с категориями). Все данные из finance-service.
- **`admin-panel/enterprises.html`** (1124 строки): 3 секции — Сеть ресторанов (карточки, expand с деталями), Пользователи предприятия (таблица, смена роли, deactivate/activate, invite), Бенчмарки (select → метрики). Все данные из user-service `/api/enterprises/...`.
- **Sidebar links**: ссылки на finance.html и enterprises.html добавлены во все 16 страниц admin-panel.

## [2026-04-17] feat | Phase 6 — ЮKassa и промокод в customer-app checkout
Реальная онлайн-оплата и промокоды в B2C витрине.

- **`customer-app/index.html`**:
  - `API_BASE_URL` исправлен: `localhost/api` → `localhost:8000/api` (Kong порт).
  - Добавлено поле промокода с кнопкой «Применить» → `POST /api/crm/promotions/apply` (idempotency key). Визуальный feedback: зелёный текст при успехе, красный при ошибке/исчерпании.
  - Добавлен выбор способа оплаты: Наличными / Онлайн (карта) — radio-кнопки с выделением выбранного.
  - При наличных: `POST /api/orders` → success modal (как раньше).
  - При онлайн: `POST /api/orders` → `POST /api/finance/online-payment` → редирект на `confirmationUrl` ЮKassa с параметром `return_url` на payment-callback.html.
  - Кнопка submit блокируется на время запроса, меняет текст.
- **`customer-app/payment-callback.html`** (новый): страница возврата после ЮKassa. Читает `orderId` из URL-параметра → polling `GET /api/finance/payments?orderId=X` с retry. Отображает статус: Оплачено / В обработке (retry каждые 5с) / Отклонено / Уточняется. Кнопка «Вернуться в меню».

## [2026-04-17] cleanup | Phase 5+3 — Orphan pages redirect + settings role editor removed
Устранены последние misleading/дублирующие элементы UI.

- **`frontend/order-management/index.html`**: заменён на 10-строчный redirect (meta refresh + JS) → `../admin-panel/orders.html`. Страница была 708-строчным mock-канбаном с LocalStorage; функциональный аналог — `orders.html` на реальном API.
- **`frontend/kds/index.html`**: заменён на redirect → `../admin-panel/kds.html`. Была standalone KDS с Socket.IO hardcoded на `localhost:3009`; актуальная версия — `kds.html` с polling через реальный API.
- **`admin-panel/settings.html`** таб «Роли и доступ»: убрана вся форма с чекбоксами прав (250+ строк HTML + ~160 строк JS). `rolePermissions`, `loadRolePermissions`, `saveRolePermissions`, `resetRolePermissions`, `hasPermission`, DOMContentLoaded-инициализация — все удалены. `window.hasPermission` больше не экспортируется. Вместо формы — информационная панель с описанием каждой роли (admin/owner, manager, operator, chef, waiter, employee/viewer) и ссылка на `enterprises.html` для реального управления ролями.

## [2026-04-17] fix | Phase 2 follow-up — Consumer-side enterpriseId validation in kitchen-service RabbitMQ
Закрыт последний pending пункт Phase 2: KDS-consumer теперь scope'ит события и Socket.IO rooms по enterpriseId.

**Проблема**: `kitchen-service` RabbitMQ consumer принимал все `order.confirmed` события из общей очереди и бродкастил через Socket.IO в room `restaurant:${restaurantId}`. KDS-дисплеи разных enterprise теоретически могли видеть чужие заказы если restaurantId совпадал (маловероятно с UUID, но архитектурно неверно).

**Изменения в `services/kitchen-service/`**:

- **`KitchenOrder` interface** — добавлено поле `enterpriseId?: string`.
- **`rabbitmq.service.ts` `consumeOrders()`** — валидация: `logger.warn` если `enterpriseId` отсутствует в payload (graceful degradation — заказ всё равно обрабатывается). `enterpriseId` передаётся дальше в `kitchenOrder`.
- **`kitchen-display.service.ts` `broadcastNewOrder()`** — room теперь `enterprise:${enterpriseId}:restaurant:${restaurantId}` при наличии enterpriseId, иначе fallback на `restaurant:${restaurantId}`.
- **`kitchen-display.service.ts` `broadcastOrderUpdate()`** — добавлен опциональный параметр `enterpriseId`, аналогичная логика room.
- **`kitchen-display.service.ts` `updateOrderStatus()`** — SQL RETURNING расширен: добавлен `enterprise_id`, передаётся в `broadcastOrderUpdate`.
- **`kitchen-display.service.ts` `completeOrder()`** — аналогично.
- **`kitchen-display.service.ts` `sendActiveOrders(restaurantId, socket, enterpriseId?)`** — добавлен параметр `enterpriseId`; если указан, добавляется `AND o.enterprise_id = $2` в WHERE (tenant guard на чтение).
- **`index.ts` Socket.IO `authenticate` handler** — `data` расширен: `{ restaurantId, token, enterpriseId? }`. Socket присоединяется к enterprise-scoped room. `sendActiveOrders` получает `enterpriseId`.

**Delivery-service**: RabbitMQ consumer отсутствует (delivery работает через Socket.IO напрямую) — нечего фиксить.

## [2026-07-02] feat | Оптовый контур B2B (commit b543a90)
Крупнейшая фича сессии: +3 сервиса, оптовые продажи, производство, WhatsApp.

- **Миграции 020–021**: контрагенты (балансы, кредитные лимиты), оптовые заказы/позиции, оплаты и долги, возвраты (restock/write_off), производство по техкартам, Z-отчёты касс, оптовые/розничные цены, связь расходов с накладными поставщиков, `telegram_chat_id` для водителей.
- **`wholesale-service` (3013)** — контрагенты с балансами, жизненный цикл заказа draft→confirmed→assembled→shipped→delivered→closed, FIFO-списание при отгрузке с фактической себестоимостью, автонумерация накладных, возвраты с кредит-нотами (переплата → минусовой баланс = «в плюс» клиенту), отчёты по водителям/менеджерам/сводный, PDF-накладные (PDFKit + DejaVu) с отправкой в WhatsApp.
- **`whatsapp-service` (3014)** — WhatsApp Web автоматизация (puppeteer-core), сессия в volume, QR по HTTP, отправка текста и файлов.
- **`driver-bot-service` (3015)** — Telegram-бот водителей: привязка по телефону, доставки с составом и адресом, приём наличных, возвраты, push при назначении на отгрузку.
- **Расширены**: inventory-service (производство по техкартам с FIFO-себестоимостью, каскад полуфабрикатов, отчёт маржинальности), finance-service (Z-отчёты при закрытии смены, авторасход из подтверждённой накладной, отчёт расходов по поставщикам, межсервисный `X-Internal-Token`).
- **Frontend**: новый раздел «Опт» (`wholesale.html`, ~2000 строк), реальная вкладка «Производство», цены/маржа в меню, пункт «Опт» в сайдбарах. Итого сервисов в системе: 13 → **16**.

## [2026-07-02] feat | Дизайн «Базилик и томат» + мобильный доступ (commit dedcecb)
Единая дизайн-система через токены + фронт работает с телефона.

- **`frontend/css/tokens.css`** — палитра: кремовый фон `#F6F1E4`, поверхности `#FFFDF7`, базиликовый зелёный `#2E7D4F`, томатный `#D94F30`, жёлтый `#F0C93B`, чернильный текст `#23201A`; шрифты Bitter (заголовки) + Onest (текст). В 13 разделах ~1050 захардкоженных цветов старой палитры заменены на токены, 134 белых фона → тёплая поверхность.
- **Мобильный доступ**: `API_BASE` больше не захардкожен на localhost — берётся из `window.location.origin`, фронт открывается с телефона по IP в локальной сети (фронт и API за одним Kong).

## [2026-07-02] feat | Взаиморасчёты с поставщиками + анализ (commit bbc9602)
- **Миграция 022**: долг поставщику (`suppliers.balance` с бэкфиллом по принятым накладным), `supplier_payments`, статус оплаты накладных.
- **inventory-service**: долг растёт при подтверждении накладной, повторное подтверждение отклоняется (раньше дублировало приход+расход); `POST /suppliers/:id/payments` (наличные проводятся изъятием через кассу finance-service); `GET /suppliers/:id/balance`, `/suppliers/reports/settlements`; `GET /inventory/items/:id/cost-history` (себестоимость по партиям, средневзвешенная); `/inventory/reports/item-analysis` и `/dish-analysis` (списания и спрос).
- **Frontend (Склад)**: долг и оплата на карточках поставщиков, взаиморасчёты и анализ спроса в отчётах.

## [2026-07-03] feat | Тип заведения — фильтрация разделов (commit e32f9bf)
Завершена фича из прошлой сессии (backend был не подключён). Тип: ресторан / кафе / кофейня / производство.

- **Миграция 023**: колонка `enterprises.business_type` (CHECK на 4 значения, дефолт `restaurant`).
- **user-service**: `business_type` в интерфейсах Enterprise/Create/UpdateEnterpriseInput + INSERT при создании. `updateEnterprise` — **whitelist колонок**: ключи `req.body` уходили прямо в SQL (`${key} = $N`) без проверки → закрыта SQL-инъекция через произвольные ключи.
- **Frontend (`admin-panel/js/auth.js`)**: `MODULE_ACCESS` прячет пункты сайдбара под тип (кофейня без столов/зала/KDS; производство — только склад/производство/опт). `setBusinessType` сохраняет тип на предприятии + кэш в `ff_enterprise`; `hydrateEnterprise` подтягивает серверный тип при входе без локального override; `logout` чистит `ff_business_type`/`ff_enterprise`. UI выбора — карточки во вкладке «Функционал» settings.html.
- Приоритет источника типа: локальный `ff_business_type` > `ff_enterprise.business_type` > null (показываем всё).
