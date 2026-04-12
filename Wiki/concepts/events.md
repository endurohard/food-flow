---
type: concept
status: stable
last_verified: 2026-04-11
sources:
  - docker-compose.yml
  - ARCHITECTURE.md
---

# Events / RabbitMQ

Межсервисная асинхронная коммуникация через RabbitMQ.

## Инфраструктура
- Брокер: RabbitMQ (порт 5672, UI 15672)
- Креды по умолчанию: `foodflow / foodflow_secret`
- Exchange: `orders_exchange` (topic)
- Очереди: `delivery_queue`, `notification_queue`

## Топология событий (из ARCHITECTURE.md — проверить актуальность)

| Событие | Publisher | Consumers |
|---|---|---|
| `order.created` | [[services/order-service]] | [[services/restaurant-service]] (?) |
| `order.confirmed` | [[services/order-service]] | [[services/kitchen-service]] (KDS), [[services/restaurant-service]] |
| `order.ready` | [[services/order-service]] | [[services/delivery-service]] |
| `order.cancelled` | [[services/order-service]] | все заинтересованные |

## Ответы (аудит 2026-04-11)
- **События НЕ несут `enterprise_id`** — подтверждено в `services/order-service/src/services/order.service.ts:183-211` и `services/order-service/src/routes/orders.ts:13`. Consumer'ы не могут фильтровать по tenant. См. [[../decisions/2026-04-11-deep-audit]] H3.
- **Ошибки публикации заглушаются**: `.catch(err => console.warn(...))` — событие теряется тихо, заказ попадает в БД но не доходит до кухни.

## Открытые вопросы
- Какие события публикуют новые сервисы ([[services/crm-service]], [[services/finance-service]], [[services/inventory-service]])?
- Есть ли события от [[services/yeastar-service]]/[[services/pjsip-service]] о входящих звонках (для popup в [[services/frontend-service]])?
