---
type: service
status: stable
last_verified: 2026-04-11
sources:
  - services/hr-service/
  - database/migrations/012_hr_staff_management.sql
  - docs/SHIFT_FILTERING.md
---

# hr-service

HR и управление персоналом: сотрудники, смены, роли.

- **Порт**: 3010

## Ответственность
- Сотрудники ресторана (не путать с пользователями из [[services/user-service]] — это штат, не аккаунты)
- Смены (shifts), графики работы
- Фильтрация по сменам (`docs/SHIFT_FILTERING.md`)
- Вероятно расчёт рабочих часов

## Routes
- `hr.routes.ts`

## Связи
- [[services/order-service]] — заказы могут привязываться к waiter (staff_id) → migration 009
- [[services/finance-service]] — зарплаты
- Админ-панель: `frontend/admin-panel/staff.html`
