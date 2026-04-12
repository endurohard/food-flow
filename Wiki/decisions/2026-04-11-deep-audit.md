---
type: audit
status: stable
last_verified: 2026-04-11
severity: critical
sources:
  - all services/
  - kong/kong.yml
  - database/migrations/
  - docs/IMPLEMENTED_FEATURES.md
  - docs/ARCHITECTURE.md
---

# Deep Audit 2026-04-11 — Security, Correctness, Consistency

Глубокий аудит всего проекта food-flow: 4 параллельных среза (multi-tenancy, auth, bug hunt, несхождения docs/code) + тестовая инфраструктура. Все находки с file:line цитатами.

**Общая оценка**: проект функционально широк (13 сервисов, POS/KDS/CRM/HR/Finance/телефония), но **не готов к продакшену**. Критические дыры в изоляции tenants, auth непоследователен, нет автотестов, часть фронта — LocalStorage-мок без backend.

---

## 🔴 CRITICAL — data leaks и повреждение данных

### C1. Multi-tenant изоляция сломана во ВСЕХ сервисах кроме user-service
Middleware `enterprise.middleware.ts` определён только в [[../services/user-service]] и не применяется к остальным. SQL-запросы систематически не содержат `WHERE enterprise_id = ?`. Следствие: пользователь из компании A читает/пишет данные компании B.

Подтверждённые дыры:
- `services/order-service/src/services/order.service.ts:223-289` (`list()`) — нет enterprise_id
- `services/order-service/src/services/order.service.ts:291-317` (`getById()`) — только `WHERE o.id = $1`
- `services/kitchen-service/src/services/kitchen-display.service.ts:119-123` — `WHERE id = $2` без tenant
- `services/delivery-service/src/services/delivery.service.ts:53-69` (`getById()`) — нет фильтра
- `services/delivery-service/src/services/delivery.service.ts:98-103` (`assignDriver()`)
- `services/restaurant-service/src/services/restaurant.service.ts:92-102` (GET) и `141-182` (UPDATE)
- Inventory / HR / CRM / Finance — все update/delete операции без tenant-проверки

### C2. Публичные endpoint'ы без auth возвращают чувствительные данные
- `services/user-service/src/routes/user.routes.ts:44-58` — `GET /api/users` **без middleware**, возвращает всех пользователей с PBX-credentials (`pbx_extension`, `pbx_username`, `pbx_ws_password`)
- `services/order-service/src/routes/orders.ts:63-74` — `GET /api/orders/:id` без auth, перечислением ID можно читать любые заказы
- `services/delivery-service/src/routes/delivery.routes.ts:101-109` — `GET /api/deliveries/:id/track` GPS-трекинг без auth
- `services/kitchen-service/src/routes/kitchen.routes.ts:24-64, 92-111, 129-160` — все KDS endpoint'ы без auth

### C3. Hardcoded JWT секрет, одинаковый во всех 9 сервисах
Файлы: `src/config/index.ts` в user/restaurant/delivery/inventory/hr/crm/finance/order/kitchen. Везде default fallback:
```
'your-jwt-secret-key-change-in-production'
```
Если хоть один сервис утечёт `JWT_SECRET` — скомпрометированы все. Плюс этот default может уехать в прод.

### C4. Hardcoded DB credentials в конфигах
`services/user-service/src/config/index.ts:10` — `'postgresql://foodflow:foodflow_secret@localhost:5432/foodflow'` по умолчанию. Аналогично в других сервисах.

### C5. Race condition: списание бонусов лояльности (overdraft возможен)
`services/crm-service/src/services/crm.service.ts:249-271` — `redeemPoints()` делает check balance → update балансом в двух отдельных запросах без транзакции/блокировки. Два concurrent-запроса проходят проверку и списывают дважды.

### C6. Race condition: касса, баланс расхождения
`services/finance-service/src/services/finance.service.ts:54-87` — `addCashOperation()` читает и обновляет баланс кассы без транзакции.

### C7. Race condition: инвентарь уходит в минус
`services/inventory-service/src/services/inventory.service.ts:228-234` — `deductByTechCards()` уменьшает остаток без проверки на достаточность и без блокировки строки. Заказ оплачен, склад в отрицательных числах.

### C8. Missing transaction: обновление статуса доставки
`services/delivery-service/src/services/delivery.service.ts:117-131` — `updateStatus()` делает 3 раздельных UPDATE (delivery/order/driver shift). Сбой в середине — несогласованное состояние.

---

## 🟠 HIGH — функциональные уязвимости

### H1. Нет валидации status во многих endpoint'ах
- `services/order-service/src/routes/orders.ts:110-117` — `PUT /orders/:id/status` принимает любую строку
- `services/order-service/src/routes/orders.ts:132-148` — legacy `PUT /orders/:id` то же самое
- delivery updateStatus — аналогично
Можно поставить `admin_override`, `hacked` или любую несуществующую метку, что ломает state machine downstream.

### H2. Promo-коды можно применять бесконечно
`services/crm-service/src/services/crm.service.ts:187-203` — `validatePromoCode()` проверяет `used_count < usage_limit`, но **никогда не инкрементирует** `used_count` при реальном redemption.

### H3. Events без enterprise_id
RabbitMQ публикации в order-service (например `routes/orders.ts:13`, `services/order.service.ts:183-211`) не включают `enterprise_id` в payload. Consumer'ы ([[../services/kitchen-service]], [[../services/delivery-service]]) не могут фильтровать → обрабатывают заказы чужих tenants, если очередь общая.

### H4. CORS * + credentials: true
`kong/kong.yml:156-157` — опасная комбинация, даёт возможность CSRF с любого origin при наличии cookies.

### H5. Order split — транзакция неполная
`services/order-service/src/services/order.service.ts:361-430` — `getById()` вызывается **до** `BEGIN`, между чтением и транзакцией заказ может быть обновлён, дочерние заказы создаются со stale-данными.

---

## 🟡 MEDIUM

### M1. RabbitMQ-сбои заглушаются
`services/order-service/src/routes/orders.ts:13` — `.catch(err => console.warn(...))`. События `order.created` теряются тихо, кухня не узнаёт о заказе, клиент получает "OK".

### M2. N+1 при создании заказа
`services/order-service/src/services/order.service.ts:137-155` — цикл по items/modifiers с отдельными INSERT.

### M3. Race на счётчике `deliveries_completed`
`services/delivery-service/src/services/delivery.service.ts:126-130` — read-modify-write, lost updates.

### M4. Loyalty tier stale после earnPoints
`services/crm-service/src/services/crm.service.ts:207-246` — чтение total_spent, update, пересчёт tier в трёх шагах.

---

## 📊 Тестовая инфраструктура — отсутствует

- **7 из 13 сервисов** декларируют `"test": "jest"` в `package.json` (user, restaurant, order, inventory, kitchen, pjsip, yeastar, telegram-bot, finance).
- **0 тестовых файлов** в репо (`find ... -name "*.test.ts" -o -name "*.spec.ts"` → пусто).
- Запуск `npm test` в user-service даёт: `No tests found, exiting with code 1` (jest.config пишет `testMatch` по `**/__tests__`, `**/*.spec.ts`, `**/*.test.ts` — нет совпадений).
- Jest — вывеска. CI любая будет зелёной автоматически, если это не `--passWithNoTests`.

**TypeScript**: `npx tsc --noEmit` на user/order проходит без ошибок — значит типизация хотя бы не сломана.

---

## ⚠️ Несхождения документация ↔ код

### D1. `docker-compose.yml:387` — MongoDB отсутствует
`telegram-bot-service` указывает `MONGODB_URI: mongodb://mongodb:27017/telegram-bot`, но **в docker-compose нет сервиса mongodb**. Бот не стартует в standalone compose. Подтверждает ingest из [[../log]].

### D2. Kong пропускает telegram-bot-service
`kong/kong.yml` — 12 маршрутов, а сервисов 13. Нет маршрута для `telegram-bot-service` (правда, ему и не нужен — это out-of-band ingress через Telegram, не через HTTP).

### D3. Фронт-страницы без backend (чистые моки)
Подтверждено grep'ом: нет ни одного `fetch()` вызова в:
- `frontend/admin-panel/tables.html` (881-911) — только localStorage
- `frontend/admin-panel/hall-designer.html` (578-968)
- `frontend/admin-panel/inventory.html`
- `frontend/admin-panel/staff.html`
- `frontend/admin-panel/loyalty.html`

**Частичные**:
- `menu.html` — есть `fetch()`, но с fallback на localStorage; endpoint расчёта себестоимости `TechCardService.getCostCalculation` (inventory-service) **никогда не вызывается** из UI, хотя в `IMPLEMENTED_FEATURES.md` галочка стоит.

### D4. `docs/IMPLEMENTED_FEATURES.md` — ложные галочки
- Строка 75 — "Стоп-лист с комментариями" [x], в `services/` grep по "стоп-лист"/"stop_list"/"stopList" = 0 совпадений.
- Строка 206 — "Бронирование с депозитами" фактически [ ] (не галочка) — документ противоречит сам себе в "Ближайших целях".

### D5. `ARCHITECTURE.md` устарел
Описывает 4 сервиса (user/restaurant/order/delivery). Нет: kitchen, inventory, hr, crm, finance, telegram-bot, yeastar, pjsip, frontend.

---

## Карта покрытия по сервисам

| Сервис | Multi-tenant | Auth на routes | Транзакции | Тесты |
|---|---|---|---|---|
| user-service | ✅ (источник) | частично | — | ❌ |
| restaurant-service | ❌ | частично | ? | ❌ |
| order-service | ❌ | ❌ критично | ⚠️ неполно | ❌ |
| delivery-service | ❌ | ❌ критично | ❌ | ❌ |
| kitchen-service | ❌ | ❌ критично | — | ❌ |
| inventory-service | ❌ | ? | ❌ (stock) | ❌ |
| crm-service | ❌ | ? | ❌ (points) | — |
| finance-service | ❌ | ? | ❌ (cash) | — |
| hr-service | ❌ | ? | — | — |

---

## Приоритетный план починки (рекомендация)

**Фаза 0 — остановить кровь** (1–2 дня):
1. `C2` — навесить auth middleware на открытые endpoint'ы (order GET, user GET, kitchen.*, delivery/track).
2. `C3/C4` — убрать hardcoded fallback'и для `JWT_SECRET` и DB URL. Падать на старте, если env-var не задана.
3. `H4` — CORS: убрать `*` при `credentials: true`, whitelist.

**Фаза 1 — tenant изоляция** (неделя):
4. `C1` — ввести общий `enterprise.middleware.ts` как npm-пакет/shared utils и применить ко всем сервисам. Добавить `WHERE enterprise_id = $X` во все SELECT/UPDATE/DELETE.
5. `H3` — добавить `enterprise_id` в payload всех RabbitMQ событий + фильтрация на consumer-стороне.

**Фаза 2 — критичные race conditions** (неделя):
6. `C5` — bonus redemption через `SELECT ... FOR UPDATE` или атомарный `UPDATE ... WHERE balance >= amount RETURNING`.
7. `C6` — cash operations в транзакции.
8. `C7` — inventory decrement через атомарный `UPDATE ... WHERE qty >= need`.
9. `C8, H5` — обернуть multi-step flow'ы в `BEGIN/COMMIT`.

**Фаза 3 — корректность** (параллельно):
10. `H1` — enum-валидация status'ов (Joi/Zod schemas).
11. `H2` — инкремент `used_count` при redemption промо.
12. `M1` — не глотать RabbitMQ ошибки, outbox pattern или retry.

**Фаза 4 — качество**:
13. Написать хотя бы smoke-тесты на критичные флоу (login, order creation + stock decrement, bonus redemption). Иначе фиксы регрессируют.
14. Синхронизировать `ARCHITECTURE.md` и `IMPLEMENTED_FEATURES.md` с реальностью или удалить/пометить устаревшими.
15. Решить судьбу LocalStorage-фронта: либо дописать API-wiring, либо честно пометить страницы как демо.

---

## Связи
- [[../concepts/multi-tenancy]] — критичный открытый вопрос закрыт: изоляция **не работает**, статус концепта нужно понизить до `broken`.
- [[../concepts/auth]] — подтверждено: JWT проверяется в каждом сервисе, не в Kong.
- [[../concepts/events]] — подтверждено: события без `enterprise_id`.
- Все service-страницы нуждаются в апдейте `status` (многие сейчас `stable`, реально `wip` или `broken`).
