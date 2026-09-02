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
- **Права кассовых ролей** (с 2026-09-02): `GET /registers`, `POST /registers/:id/operations` и `POST /payments` доступны `operator`/`waiter`/`cashier` — кассиру нужно видеть открытую смену и проводить продажу.
- **`POST /payments` принимает `status`** (`pending`|`completed`): касса пробивает уже полученные деньги, а отчёт выручки считает только `completed` (`finance.service.ts`, условие `p.status = 'completed'`). Онлайн-оплаты остаются `pending` до вебхука ЮKassa.

## Связи
- [[services/order-service]] — заказ → платёж
- [[services/hr-service]] — зарплаты (возможно)
- [[services/crm-service]] — бонусы
- Админ-панель: `frontend/admin-panel/analytics.html`
