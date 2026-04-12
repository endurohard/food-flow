---
type: service
status: wip
last_verified: 2026-04-11
sources:
  - services/pjsip-service/
  - docs/PJSIP_NATIVE_MIGRATION.md
---

# pjsip-service

Нативная интеграция SIP/PJSIP — замена Yeastar WebSocket-пути.

- **HTTP порт**: 3009
- **SIP порт**: 5060 (`services/pjsip-service/src/index.ts:242`, default)

## Ответственность
- Прямая работа со SIP-стеком через PJSIP
- Регистрация SIP-аккаунтов
- Обработка входящих/исходящих звонков без промежуточного PBX

## Контекст миграции
Проект переходит с [[services/yeastar-service]] (внешний PBX) на этот сервис (нативный стек). См. `docs/PJSIP_NATIVE_MIGRATION.md`.

## Связи
- [[concepts/telephony]]
- [[services/yeastar-service]] — legacy путь
