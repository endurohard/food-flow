---
type: meta
status: stable
last_verified: 2026-04-16
---

# Sources Map

Карта raw-sources → страницы вики, которые их покрывают. Обновляется при ingest. Используется lint-ом для поиска непокрытых источников.

## Корневые документы

| Источник | Статус | Страницы |
|---|---|---|
| `README.md` | актуален | общий обзор |
| `PROJECT_OVERVIEW.md` | **частично устарел** (4 сервиса вместо 13) | [[index]] |
| `ARCHITECTURE.md` | **устарел** — описывает только user/restaurant/order/delivery | нужен рефреш |
| `FEATURES.md` | ? | — |
| `API_DOCUMENTATION.md` | ? | — |
| `QUICK_START.md` / `FIRST_RUN.md` | туториалы | не для вики |
| `KITCHEN_PRINTER_SETUP.md`, `PRINTER_SETUP.md`, `KITCHEN_QUICK_START.md` | туториалы | [[services/kitchen-service]] |

## docs/

| Источник | Покрытие |
|---|---|
| `docs/MULTI_TENANT_GUIDE.md` | [[concepts/multi-tenancy]] |
| `docs/MULTI_TENANT_QUICK_START.md` | [[concepts/multi-tenancy]] |
| `docs/TELEPHONY_INTEGRATION.md` | [[concepts/telephony]] |
| `docs/PJSIP_NATIVE_MIGRATION.md` | [[services/pjsip-service]] |
| `docs/FEATURES_ROADMAP.md` | — (роадмап, не факты) |
| `docs/IMPLEMENTED_FEATURES.md` | **проингесчен 2026-04-11**; документ датирован 2025-01-07, частично устарел (описывает 6 сервисов вместо 13, не упоминает crm/finance/hr/pjsip/yeastar) |
| `docs/SYSTEM_ARCHITECTURE_ANALYSIS.md` | нужен ingest |
| `docs/SHIFT_FILTERING.md` | [[services/hr-service]] |
| `docs/ACCESS_URLS.md` | [[index]] (порты) |
| `docs/PROJECT_VERIFICATION_REPORT.md` | — |

## Миграции БД

Каждая миграция вводит фичу/таблицу — должна быть отражена в соответствующей service-странице.

| Миграция | Страница |
|---|---|
| `005_add_pbx_settings.sql` | [[services/restaurant-service]], [[concepts/telephony]] |
| `006_add_enterprises_multi_tenant.sql` | [[concepts/multi-tenancy]] |
| `007_add_refresh_tokens.sql` | [[concepts/auth]] |
| `008_add_menu_modifiers.sql` | [[services/restaurant-service]] |
| `009_extend_orders_for_pos.sql` | [[services/order-service]] |
| `010_inventory_warehouse.sql` | [[services/inventory-service]] |
| `011_delivery_zones_and_tracking.sql` | [[services/delivery-service]] |
| `012_hr_staff_management.sql` | [[services/hr-service]] |
| `013_crm_loyalty.sql` | [[services/crm-service]] |
| `014_financials.sql` | [[services/finance-service]] |
| `015_chain_management.sql` | [[concepts/multi-tenancy]] |
| `016_pii_audit_log.sql` | [[services/user-service]] (Phase B) |
| `017_split_bill_discounts_stoplist_reservations.sql` | [[services/order-service]], [[services/restaurant-service]] (Phase C) |
| `018_kitchen_stations_fifo_1c.sql` | [[services/kitchen-service]], [[services/inventory-service]], [[services/finance-service]] (Phase D) |

## Конфигурация

- `docker-compose.yml` — источник истины по портам и зависимостям сервисов → [[index]]. С 2026-04-16 Kong порт 8000 экспонирован наружу для фронта.
- `kong/kong.yml` — маршруты API Gateway → нужен ingest в отдельную страницу `concepts/api-gateway`
- `services/*/package.json` — описания и зависимости
- `frontend/css/tokens.css` — design system токены (с 2026-04-16) → [[services/frontend-service]]
- `frontend/customer-app/` — B2C витрина → [[services/frontend-service]]
- `database/init/03-run-migrations.sh` — auto-миграции на первом запуске контейнера (Phase A.1). Для миграций после старта — ручной `psql` или rebuild.
