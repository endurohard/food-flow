---
type: service
status: stable
last_verified: 2026-04-11
sources:
  - services/crm-service/
  - database/migrations/013_crm_loyalty.sql
---

# crm-service

CRM, программы лояльности, промо-акции.

- **Порт**: 3011

## Ответственность
- База клиентов ресторана (отличается от `user-service`: это CRM-контакты, не обязательно зарегистрированные пользователи)
- Программы лояльности (бонусы, уровни, кешбек — см. migration 013)
- Промо-акции и скидки
- Вероятно сегментация и рассылки

## Routes
- `crm.routes.ts`

## Связи
- [[services/order-service]] — применение промокодов/списание бонусов при создании заказа
- [[services/finance-service]] — учёт бонусов в финансовой отчётности
- Админ-панель: `frontend/admin-panel/loyalty.html`
