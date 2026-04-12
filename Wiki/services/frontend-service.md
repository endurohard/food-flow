---
type: service
status: stable
last_verified: 2026-04-11
sources:
  - services/frontend-service/
  - frontend/admin-panel/
---

# frontend-service

Статический сервер для фронта (`frontend/admin-panel/`).

- **Порт**: 3000 (`services/frontend-service/index.js:5`)
- **Тип**: plain Node.js, без TypeScript

## Ответственность
- Раздача HTML/JS/CSS админ-панели
- Вся логика в статических `.html` файлах из `frontend/admin-panel/`

## ⚠️ LocalStorage-first архитектура (на момент 2025-01-07)

Согласно `docs/IMPLEMENTED_FEATURES.md`, значительная часть админ-панели хранит состояние в **LocalStorage браузера**, а не через API бэкенд-сервисов. Подтверждённые на localStorage:
- `tables.html` — столы, бронирования, таймеры
- `hall-designer.html` — планировки залов (с экспортом в JSON)
- Общая пометка в доке: "LocalStorage для хранения данных"

**Следствие**: многие фичи в UI могут не быть синхронизированы с реальными БД-сервисами. При разработке нужно проверять каждую страницу индивидуально — есть ли там `fetch()` к backend или только манипуляции с `localStorage`.

Это значит, что реальная зрелость системы ниже, чем кажется по UI: бэкенд-сервисы могут быть готовы, но фронт ещё не подключен. Или наоборот — фронт показывает mock-данные там, где бэкенда нет.

## Страницы админки
- `login.html`, `index.html` — вход и главная
- `menu.html`, `orders.html`, `tables.html`, `hall-designer.html`
- `kds.html` — Kitchen Display ([[services/kitchen-service]])
- `inventory.html` — склад ([[services/inventory-service]])
- `staff.html` — штат ([[services/hr-service]])
- `loyalty.html` — CRM/лояльность ([[services/crm-service]])
- `analytics.html` — финансы/аналитика ([[services/finance-service]])
- `calls.html` — звонки ([[concepts/telephony]])
- `settings.html`, `user-profile.html`
- `js/auth.js` — клиент [[concepts/auth]]
