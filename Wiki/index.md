# Wiki Index

Каталог всех страниц. Обновляется при каждом ingest.

## Meta
- [[AGENTS]] — схема вики (правила ingest/query/lint)
- [[log]] — хронология операций
- [[sources]] — карта raw-sources → страницы

## Services (13)
- [[services/user-service]] — auth, пользователи, enterprise/multi-tenant (порт 3001)
- [[services/restaurant-service]] — рестораны, меню, PBX-настройки (3002)
- [[services/order-service]] — заказы, столы, POS (3003)
- [[services/delivery-service]] — доставка, зоны, трекинг (3004)
- [[services/kitchen-service]] — KDS, принтеры (3005)
- [[services/inventory-service]] — склад, поставщики, техкарты (3006)
- [[services/telegram-bot-service]] — бот для инвойсов/инвентаря (3007)
- [[services/yeastar-service]] — Yeastar PBX WebSocket (3008)
- [[services/pjsip-service]] — нативный SIP/PJSIP (3009)
- [[services/hr-service]] — HR, штат, смены (3010)
- [[services/crm-service]] — CRM, лояльность, промо (3011)
- [[services/finance-service]] — финансы, платежи, касса (3012)
- [[services/frontend-service]] — статика админ-панели (3000)

## Concepts
- [[concepts/multi-tenancy]] — enterprise-модель, row-level изоляция
- [[concepts/events]] — RabbitMQ, exchange'ы, топология событий
- [[concepts/telephony]] — Yeastar + PJSIP, маршрутизация звонков
- [[concepts/auth]] — JWT, refresh токены, RBAC

## Decisions / Audits
- [[decisions/2026-04-11-deep-audit]] — 🔴 **критический аудит**: сломанная multi-tenant изоляция, hardcoded JWT, race conditions, 0 тестов
- [[decisions/2026-04-12-enhancement-recommendations]] — 📋 **план роста**: 30 пробелов (compliance РФ, инфра, фичи) с roadmap на 4 фазы
