---
type: service
status: stable
last_verified: 2026-04-16
sources:
  - services/order-service/
  - database/migrations/009_extend_orders_for_pos.sql
---

# order-service

Корзина, заказы, **POS-расширения**, столы.

- **Порт**: 3003
- **БД**: PostgreSQL
- **События**: publisher в RabbitMQ → [[concepts/events]]

## Ответственность
- Cart management (Redis)
- Создание и lifecycle заказа
- **POS**: расширения заказов для работы в зале (migration 009 — вероятно поля table_id, waiter_id, shift_id и т.п.)
- **Столы** (`tables.ts`): управление столами в зале, статусы. ⚠️ На фронте `tables.html` и `hall-designer.html` работают через LocalStorage (`docs/IMPLEMENTED_FEATURES.md`, 2025-01-07) — нужно проверить, синхронизирован ли фронт с этим сервисом. Hall-designer поддерживает drag-and-drop, фигурные столы, декорации (двери/окна/растения), экспорт JSON.
- Публикация событий `order.created`, `order.confirmed`, `order.ready`, `order.cancelled`

## Routes
- `orders.ts` — заказы и статусы
- `tables.ts` — столы зала (связано с hall designer в админке)

## Связи
- [[services/delivery-service]] — подписчик `order.ready`
- [[services/kitchen-service]] — подписчик `order.confirmed` для KDS
- [[services/restaurant-service]] — меню читается при создании заказа
- [[services/finance-service]] — платежи по заказам
- [[concepts/events]] — topology событий

## Auth-политика на endpoint'ах (2026-04-16)
- `POST /api/orders` — `optionalAuth` (гостевой checkout, коммит `a53f75c`). Если JWT есть — заказ привязывается к userId, иначе гостевой. Злоупотребление ограничено rate limit'ами Kong + idempotency keys из Phase A.
- `GET /api/orders` — `optionalAuth` (фильтрация по enterprise если JWT есть).
- `GET /api/orders/:id`, `PUT/DELETE` — `authenticateUser` (Phase 0).
- `GET /api/tables` — `authenticateUser` (post-fix audit `129f88d`, раньше было открыто).

## Открытые вопросы
- Уточнить точную схему полей из migration 009 при следующем ingest-е.
