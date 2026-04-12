---
type: service
status: stable
last_verified: 2026-04-11
sources:
  - services/restaurant-service/
  - database/migrations/005_add_pbx_settings.sql
  - database/migrations/008_add_menu_modifiers.sql
---

# restaurant-service

Рестораны, меню, категории, модификаторы, PBX-настройки ресторана.

- **Порт**: 3002
- **БД**: PostgreSQL

## Ответственность
- CRUD ресторанов и профилей
- Меню: категории, позиции, **модификаторы** (размеры, добавки, ценовые схемы) — migration 008
- **Стоп-лист** с комментариями (по `docs/IMPLEMENTED_FEATURES.md`)
- Поиск/фильтрация ресторанов
- **PBX settings per restaurant** (migration 005) — привязка SIP/Yeastar конфигов → [[concepts/telephony]]

## Техкарты и себестоимость
В админ-панели `menu.html` реализован расчёт себестоимости блюда: техкарта (список ингредиентов с количеством) × цены закупки → cost + margin.
- Ингредиенты и цены живут в [[services/inventory-service]]
- Техкарты могут быть здесь (menu items) либо там (techcard.routes) — нужно уточнить владельца сущности при следующем ingest-е: в `inventory-service/src/routes/techcard.routes.ts` она явно есть.

## Routes
- `restaurant.routes.ts` — рестораны
- `menu.routes.ts` — меню, категории, позиции, модификаторы
- `pbx.routes.ts` — PBX-настройки ресторана

## Связи
- [[services/order-service]] — читает меню для корзины и заказов
- [[concepts/telephony]] — pbx.routes хранит конфигурацию для [[services/yeastar-service]]/[[services/pjsip-service]]
- [[concepts/multi-tenancy]] — рестораны принадлежат enterprise
