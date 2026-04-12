---
type: service
status: stable
last_verified: 2026-04-11
sources:
  - services/delivery-service/
  - database/migrations/011_delivery_zones_and_tracking.sql
---

# delivery-service

Доставка, назначение курьерам, зоны доставки, real-time трекинг.

- **Порт**: 3004
- **Realtime**: Socket.IO
- **События**: consumer RabbitMQ (`order.ready`)

## Ответственность
- Назначение заказа водителю
- **Delivery zones** (migration 011) — геометрия зон, стоимость/доступность
- Real-time обновление локации водителя
- Broadcast трекинга клиенту через WebSocket

## Структура
- `src/routes/delivery.routes.ts`
- `src/services/` — бизнес-логика
- `src/middleware/`, `src/config/`, `src/utils/` — стандартная обвязка

## Связи
- [[services/order-service]] — источник события `order.ready`
- [[concepts/events]]
- frontend: карта трекинга использует WebSocket этого сервиса
