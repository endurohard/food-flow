---
type: service
status: stable
last_verified: 2026-04-11
sources:
  - services/kitchen-service/
  - KITCHEN_PRINTER_SETUP.md
  - PRINTER_SETUP.md
  - KITCHEN_QUICK_START.md
---

# kitchen-service

Kitchen Display System (KDS) и интеграция с принтерами чеков/кухонными принтерами.

- **Порт**: 3005

## Ответственность
- KDS: отображение активных заказов на кухне
- Драйверы принтеров (чековые/кухонные)
- Печать заказов по событию `order.confirmed`

## Routes
- `kitchen.routes.ts` — KDS API
- `printer.routes.ts` — настройка и управление принтерами

## Связи
- [[services/order-service]] — consumer событий
- [[concepts/events]]
- Туториалы: `KITCHEN_PRINTER_SETUP.md`, `PRINTER_SETUP.md`
