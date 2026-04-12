---
type: service
status: stable
last_verified: 2026-04-11
sources:
  - services/yeastar-service/
  - docs/TELEPHONY_INTEGRATION.md
---

# yeastar-service

Интеграция с Yeastar PBX через WebSocket API.

- **Порт**: 3008

## Ответственность
- Подключение к Yeastar PBX по WebSocket
- Проксирование событий звонков (incoming call, answered, hangup) в систему
- Вероятно отправка в [[services/restaurant-service]] для идентификации клиента по номеру

## Связи
- [[concepts/telephony]] — общая модель телефонии
- [[services/pjsip-service]] — альтернативный нативный путь (см. `docs/PJSIP_NATIVE_MIGRATION.md`)
- [[services/restaurant-service]] — PBX settings per restaurant (migration 005)
- Админ-панель: `frontend/admin-panel/calls.html`

## Контекст
Yeastar — внешний аппаратный PBX. Этот сервис — тонкая обёртка поверх его WebSocket API. Параллельно существует [[services/pjsip-service]] — миграция на нативный SIP-стек.
