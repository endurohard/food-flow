---
type: service
status: stable
last_verified: 2026-04-11
sources:
  - services/finance-service/
  - database/migrations/014_financials.sql
---

# finance-service

Финансы, платежи, касса.

- **Порт**: 3012

## Ответственность
- Учёт платежей по заказам
- Кассовые операции (открытие/закрытие смены, X/Z-отчёты — предположительно)
- Финансовая отчётность (migration 014)
- Вероятно интеграция с платёжными шлюзами

## Routes
- `finance.routes.ts`

## Связи
- [[services/order-service]] — заказ → платёж
- [[services/hr-service]] — зарплаты (возможно)
- [[services/crm-service]] — бонусы
- Админ-панель: `frontend/admin-panel/analytics.html`
