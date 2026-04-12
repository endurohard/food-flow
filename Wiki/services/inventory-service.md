---
type: service
status: stable
last_verified: 2026-04-11
sources:
  - services/inventory-service/
  - database/migrations/010_inventory_warehouse.sql
---

# inventory-service

Склад, поставщики, **техкарты** (рецептуры).

- **Порт**: 3006

## Ответственность
- Учёт остатков на складе
- Поставщики и приёмка товара
- **Технологические карты**: рецепт блюда → списание ингредиентов при продаже
- Warehouse операции (migration 010)

## Routes
- `inventory.routes.ts` — остатки, операции склада
- `supplier.routes.ts` — поставщики
- `techcard.routes.ts` — техкарты/рецептуры

## Ingress склада (два канала)
1. **Админ-панель**: `frontend/admin-panel/inventory.html` — ручной ввод приходов, заказы поставщикам. ⚠️ По состоянию на `IMPLEMENTED_FEATURES.md` (2025-01-07) фронт работал через LocalStorage — нужно проверить, подключен ли к реальному API.
2. **Telegram-бот**: [[services/telegram-bot-service]] — автоматический ingress из фото накладных через OCR+GPT-4, вызывает inventory API для создания прихода.

## Связи
- [[services/order-service]] — при закрытии заказа должны списываться ингредиенты по техкартам (event-driven?)
- [[services/telegram-bot-service]] — автоматический источник приходов
- [[services/restaurant-service]] — техкарты привязаны к menu items

## Открытые вопросы
- Как именно происходит списание при закрытии заказа — через event или синхронный вызов? Проверить.
- Насколько фронт `inventory.html` реально ходит в этот сервис vs LocalStorage.
