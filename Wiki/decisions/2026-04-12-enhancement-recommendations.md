---
type: audit
status: stable
last_verified: 2026-04-12
severity: planning
sources:
  - 3 параллельных аудита subagent'ами
  - Реальный код services/*/
  - database/migrations/005-015
  - docker-compose.yml, kong/kong.yml
---

# Enhancement Recommendations — 2026-04-12

Глубокий анализ food-flow в трёх срезах: **функциональные пробелы** vs prod-grade POS, **архитектурные/DevEx** пробелы, **интеграции и compliance** для рынка РФ. Все фиксы Phase 0–3 из [[2026-04-11-deep-audit]] считаем сделанными.

**Главный вывод**: техническая база есть (13 сервисов, нормальная модель данных, миграции 005–015 покрывают продуктовую глубину), но проект живёт в серой зоне между "демо" и "production". Чтобы выйти на рынок в РФ, нужно ~3–4 недели фокусной работы на compliance + базовые инфра-практики.

---

## Сводная матрица (топ-30 пробелов)

### 🔴 Блокеры для легальной работы в РФ

| # | Пробел | Категория | Эффорт | Кому владеть |
|---|---|---|---|---|
| 1 | **54-ФЗ / ОФД / онлайн-касса** | Compliance | XL | finance-service |
| 2 | **Реальный платёжный шлюз** (ЮKassa/Tinkoff/Сбер) | Compliance | M | finance-service |
| 3 | **ФЗ-152 аудит доступа к PII** | Compliance | M | shared audit-log |
| 4 | **Нет PCI DSS практик** (metadata JSONB хранит raw) | Compliance | M | finance-service |
| 5 | **ЕГАИС** (если торговать алкоголем) | Compliance | XL | inventory-service |

Без #1–4 ресторан **не может легально работать в РФ**. #5 — только если есть алкогольная лицензия. Это не "хорошо бы добавить" — это приоритет абсолютный.

### 🔴 Критичные инфра-пробелы, без которых multi-tenant-production невозможен

| # | Пробел | Последствие | Эффорт |
|---|---|---|---|
| 6 | **Миграционная система (automigrate on start)** | Миграции 005–015 вручную, schema drift неизбежен | M |
| 7 | **Idempotency keys** на POST `/api/orders`, `/api/payments` | Двойные заказы/платежи на retry | M |
| 8 | **Circuit breakers + retry с backoff** | Случайный timeout inventory → падает весь checkout | M |
| 9 | **Graceful shutdown** (SIGTERM → drain RabbitMQ/pool) | Rolling deploy теряет in-flight заказы | M |
| 10 | **Dead-letter queues** в RabbitMQ | Rejected события тихо пропадают (и так M1 в order.service — best-effort) | M |
| 11 | **Secrets management** (Vault/Doppler vs plain .env) | В repo уже был дефолт-секрет, сейчас в .env тоже в plain | M |
| 12 | **Distributed tracing** (OpenTelemetry → Tempo/Jaeger) | Баг в цепочке order→kitchen→printer→delivery отлаживается вслепую | M |
| 13 | **Correlation ID** в логах всех сервисов | Невозможно cross-trace логи через ELK в multi-tenant сетапе | S |
| 14 | **Sentry / error tracking** | Rare edge-case 500 уходят в Void, не ловятся | S |
| 15 | **CI/CD pipeline** (lint→test→build→scan) | Любой коммит может сломать prod (уже было в Phase 0 — jsonwebtoken dep) | L |
| 16 | **Автотесты (unit + integration)** | 0 файлов сейчас, каждая правка вслепую | L |
| 17 | **`tsc --noEmit` не ловит Docker-регрессии** → hook на Docker build в CI | Уже была регрессия в Phase 0 | S |

### 🟠 Функциональные пробелы vs конкуренты (iiko/Poster/R-keeper)

| # | Пробел | Важность | Эффорт | Сервис |
|---|---|---|---|---|
| 18 | **Split bill** (разделение счёта между гостями) | Critical | L | order |
| 19 | **Discount rules** (% / сумма / условия / комбо) | Critical | M | order + crm |
| 20 | **Маршрутизация по кухонным станциям** (salad→main→plating) | Critical | L | kitchen |
| 21 | **Stop-list с причинами и TTL** | High | M | restaurant |
| 22 | **Таймеры приготовления per item** (+ алерты) | High | M | kitchen |
| 23 | **FIFO/LIFO учёт партий + срок годности** | Critical | L | inventory |
| 24 | **Бронирование столов** (reservations) | High | M | restaurant |
| 25 | **QR-меню (заказ со стола)** | High | M | frontend + order |
| 26 | **Онлайн-заказ сайт для гостей** | Critical | L | frontend |
| 27 | **Мобильное приложение официанта** (POS на планшете) | Critical | L | новый frontend |
| 28 | **Allergen management** (пометки и алерты) | High | M | restaurant |
| 29 | **Триггерные CRM-кампании** (birthday, welcome back) | High | L | crm + notifications |
| 30 | **Агрегаторы доставки** (Яндекс.Еда, Delivery Club) | High | XL | order + delivery |

---

## Полезное, что нашли при анализе реальной схемы

Несколько приятных сюрпризов — **есть инфраструктура, но нет бизнес-логики**:
- `orders.is_split` — колонка существует (migration 009), но split-логика не реализована → добавить не сложно.
- `orders.tips` — есть, но не связано с payments.
- `inventory_stock.last_counted_at` — есть, но нет процедуры инвентаризации.
- `stock_movements.movement_type = 'transfer'` — есть, но межскладских перемещений нет.
- `customer_profiles.birthday` — есть, но триггерных кампаний нет.
- `work_schedules` — полностью реализовано, но нет UI.
- `fiscal_receipts` — таблица создана, но пустая (схема без логики заполнения).
- `menu_items.is_available` — есть, но нет stop_reason.

Это значит, что **многие high-value фичи — не "переписать пол-сервиса", а "дописать 200 строк логики + UI"**.

---

## Рекомендованный roadmap

Разбит на 4 фазы. Каждая фаза ~1–2 недели фокусной работы.

### Фаза A — Инфраструктурный минимум (1 неделя, до любого прод-деплоя)

Без этого продакшн невозможен, compliance не имеет значения.

1. **Миграционная система** (#6): `node-pg-migrate` или аналог, миграции применяются автоматически на старте каждого сервиса. `database/migrations/` → tracked table. — **M**
2. **Secrets management** (#11): как минимум, `.env` в git-crypt или Doppler/AWS Secrets Manager. Минимум — удалить `.env` из репо, использовать `.env.example` с `${VAR:?}` pattern как в docker-compose. — **S**
3. **CI pipeline** (#15): GitHub Actions — lint + `tsc --noEmit` + Docker build для каждого сервиса + `npm audit`. Никакого deploy, просто gate. — **M**
4. **Correlation ID + structured logging** (#12/#13): middleware в каждом сервисе, прокидывание `X-Request-Id`, Winston с обязательными полями `request_id`, `enterprise_id`, `user_id`, `service`. — **S**
5. **Sentry** (#14): бесплатный tier, настроить в каждом сервисе через `@sentry/node`, контекст с tenant/user/request_id. — **S**
6. **Idempotency keys** (#7): middleware `idempotency-key`, кеш в Redis на 24 часа. Применить на `POST /orders`, `POST /payments`, `POST /promotions/apply`, `POST /points/redeem`. — **M**
7. **Graceful shutdown** (#9): SIGTERM → stop accept, drain Express server, close pg pool, close RabbitMQ channel, exit. В каждом сервисе. — **M**
8. **Health checks deep** (#A2.reliability): `/health` проверяет pg/redis/rabbitmq реально, возвращает 503 если сломано. — **S**

**Эффорт Фазы A**: ~1 неделя соло или 3–4 дня с распараллеливанием по сервисам.

### Фаза B — Compliance для РФ (2 недели, блокер для легальной работы)

9. **Платёжный шлюз ЮKassa** (#2): `@yookassa/yookassa-sdk`, минимальный flow — create payment → webhook → update `payments` → trigger fiscal. — **M**
10. **54-ФЗ через АТОЛ или ЮKassa fiscal receipts** (#1): `fiscal_receipts` таблица заполняется при завершении оплаты, отправка в ОФД через SDK. Можно начать с Tochka Online / ЮKassa, которые делают фискализацию за тебя. — **L**
11. **ФЗ-152 audit log** (#3): shared middleware `audit-pii-access`, пишет в `pii_access_log(user_id, accessed_user_id, field_name, ts)`. Применить на все endpoint'ы возвращающие `phone/email`. — **M**
12. **PCI DSS hygiene** (#4): запретить сохранять raw card data в `payments.metadata`. Шифровать чувствительное в БД через `pgcrypto`. Документировать data classification. — **M**

**Эффорт Фазы B**: ~2 недели.

### Фаза C — Feature completeness для MVP (2 недели)

Минимум функций, чтобы реальный ресторан мог использовать систему.

13. **Split bill** (#18): таблица `order_splits` + логика разделения по позициям или equal split. UI в POS-экране. — **L**
14. **Discount rules** (#19): `discounts` таблица с типами (pct/fixed/bogo), применение в `order.create`, поле `applied_discounts` в `order_items`. — **M**
15. **Stop-list с причинами** (#21): `menu_items.stop_reason`, `menu_items.stop_until`, API `POST /menu/items/:id/stop`. — **M**
16. **Reservations (бронирование)** (#24): `reservations` таблица + UI. — **M**
17. **QR-меню** (#25): React SPA на `/menu/:restaurantId?table=X`, чтение из `restaurant-service`, заказ через `order-service`. — **M**

**Эффорт Фазы C**: ~2 недели.

### Фаза D — Рост и differentiation (по ходу)

18. **Онлайн-заказ сайт** (#26) — **L**
19. **Агрегаторы доставки** (#30) — **XL**, по одному
20. **Distributed tracing** (#12) — **M**
21. **Мобильное приложение официанта** (#27) — **L**
22. **ЕГАИС** (#5) — **XL**, только если есть алкоголь
23. **1С:Общепит экспорт** — **M**
24. **Маршрутизация по кухонным станциям** (#20) — **L**
25. **FIFO склад** (#23) — **L**

Эти фичи — не блокеры, но дают рост и отстройку от конкурентов. Добавляются в том порядке, в каком продуктовые гипотезы подтверждаются.

---

## Оценка ROI (грубо)

| Фаза | Эффорт | Что даёт |
|---|---|---|
| A (инфра-минимум) | 1 нед | Без этого каждый деплой — рулетка. Это не выбор, это обязательно. |
| B (compliance) | 2 нед | Открывает легальный рынок РФ. Один платёжный шлюз + фискализация + ФЗ-152. |
| C (MVP features) | 2 нед | Минимально конкурентоспособно — split bill + reservations + QR + стоп-лист + скидки. |
| D (growth) | ongoing | По приоритетам продакт-гипотез. |

**Итого до production-ready: ~5–6 недель** соло или 2–3 недели при параллельной работе.

---

## Что я бы НЕ делал прямо сейчас

- **Kubernetes / Helm** — преждевременно для early-stage multi-tenant. Docker Compose на 1 VPS с rolling deploy (через `--rolling-upgrade` или blue-green через два compose project) покрывает 100 ресторанов легко.
- **Read replicas / PgBouncer** — только когда увидишь pool exhaustion в Prometheus. Сейчас максимум 39 connections при 13 сервисах — хватит на тысячи заказов в день.
- **Forecast ML / демпинговой аналитики** — preпродаж, пока не будет данных.
- **Собственная мобильное приложение курьера** — можно обойтись web-PWA. Нативные приложения — когда есть 50+ курьеров.
- **Пересобирать фронт админки с LocalStorage на API** — сначала понять, какие страницы реально используются, потом таргетированно подключать.

---

## Связи
- [[2026-04-11-deep-audit]] — предыдущий аудит (security + correctness). Его фиксы Phase 0–3 должны быть закоммичены перед началом этой работы.
- [[../concepts/multi-tenancy]] — tenant isolation (частично починено, нужен второй проход).
- [[../concepts/auth]] — auth foundation.
- [[../concepts/events]] — RabbitMQ, нужны DLQ и outbox.

## Открытые архитектурные вопросы
- **Shared libs vs дублирование**: сейчас auth middleware скопирован в каждый сервис. С ростом сервисов это станет болью. Решение — monorepo с `packages/shared/` (Turborepo / Nx / plain workspaces). Эффорт **L**, но окупается после ~3 следующих фич.
- **Outbox pattern для RabbitMQ**: сейчас try/catch в order.service.ts. Правильно — `outbox` таблица в транзакции с INSERT order, background worker читает и публикует. Эффорт **M**, закрывает потерю событий навсегда.
- **RLS — включать или удалять**: из [[2026-04-11-deep-audit]], находка что RLS в миграции 006 включена косметически. Решение влияет на Phase A инфры — либо делаем fully enforce через session variable middleware, либо удаляем misleading политики.
