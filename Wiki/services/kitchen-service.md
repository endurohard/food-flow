---
type: service
status: stable
last_verified: 2026-04-16
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
- `kitchen.routes.ts` — KDS API (auth: `router.use(authenticateUser)` на всё, Phase 0)
- `printer.routes.ts` — настройка и управление принтерами (auth: `router.use(authenticateUser)` на все 11 endpoint'ов, post-fix audit `129f88d` — ранее было открыто)
- `stations.routes.ts` — kitchen stations routing (Phase D)

## TypeScript
`tsconfig.json` `strict: true` (включено в post-fix audit `129f88d`, было `false` на фоне остальных сервисов). Побочный фикс — `printer.service.ts` переписан с getter-паттерном для null-safe доступа.

## Связи
- [[services/order-service]] — consumer событий
- [[concepts/events]]
- Туториалы: `KITCHEN_PRINTER_SETUP.md`, `PRINTER_SETUP.md`
