---
type: concept
status: wip
last_verified: 2026-04-11
sources:
  - docs/TELEPHONY_INTEGRATION.md
  - docs/PJSIP_NATIVE_MIGRATION.md
  - database/migrations/005_add_pbx_settings.sql
  - services/yeastar-service/
  - services/pjsip-service/
  - services/restaurant-service/src/routes/pbx.routes.ts
---

# Telephony

Две параллельные реализации телефонии, идёт миграция.

## Два пути

### Legacy: Yeastar (WebSocket)
- [[services/yeastar-service]] (порт 3008)
- Подключается к внешнему аппаратному Yeastar PBX через WebSocket API
- Тонкая обёртка: получает события звонков и проксирует дальше

### Native: PJSIP
- [[services/pjsip-service]] (HTTP 3009, SIP 5060)
- Нативный SIP-стек на базе PJSIP
- Регистрирует SIP-аккаунты и обрабатывает звонки без промежуточного PBX
- Цель миграции: убрать зависимость от Yeastar железа

## Per-restaurant конфигурация
- Миграция `005_add_pbx_settings.sql` — каждый ресторан имеет свои PBX настройки
- API: [[services/restaurant-service]] / `pbx.routes.ts`
- Позволяет запускать multi-tenant телефонию ([[concepts/multi-tenancy]])

## Фронт
- `frontend/admin-panel/calls.html` — экран звонков/истории

## Открытые вопросы
- Как именно события входящего звонка доходят до фронта? Напрямую WebSocket или через [[concepts/events]]?
- Какой сервис отвечает за идентификацию клиента по номеру (lookup в [[services/crm-service]])?
- Какой статус миграции: можно ли полностью отключить yeastar-service?
