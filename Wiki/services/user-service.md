---
type: service
status: stable
last_verified: 2026-04-11
sources:
  - services/user-service/
  - database/migrations/006_add_enterprises_multi_tenant.sql
  - database/migrations/007_add_refresh_tokens.sql
---

# user-service

Аутентификация, пользователи, enterprise/multi-tenant регистрация и управление.

- **Порт**: 3001 (`docker-compose.yml`)
- **БД**: PostgreSQL `foodflow`
- **Кеш**: Redis (сессии)

## Ответственность
- JWT-аутентификация + refresh-токены ([[concepts/auth]])
- Регистрация/профили пользователей
- RBAC (customer, restaurant_owner, driver, admin)
- **Enterprise / multi-tenant**: регистрация компаний, привязка пользователя к tenant ([[concepts/multi-tenancy]])
- Enterprise middleware для row-level изоляции данных

## Routes
- `auth.routes.ts` — register, login, refresh, logout
- `user.routes.ts` — profile, addresses
- `enterprise.routes.ts` — tenant registration/management
  - `POST /:id/staff` (с 2026-09-02) — создание сотрудника с логином и ролью в одной транзакции (`enterprise.service.ts` `createStaffUser`). Права: `super_admin` сквозной, иначе owner/admin именно этой организации — сверка по членству. Email нормализуется в lowercase, иначе сотрудник не войдёт (login ищет по нормализованному адресу).
  - ⚠️ Соседний `POST /:id/users` (привязка существующего пользователя по UUID) такой сверки не делает — `:id` берётся из URL без сравнения с `req.enterpriseId`.

## Ключевые файлы
- `src/middleware/enterprise.middleware.ts` — инжектирует `enterprise_id` в запросы
- `src/services/enterprise.service.ts` — бизнес-логика tenant'ов
- `src/config/index.ts` — JWT secret, токен TTL

## Связи
- [[concepts/auth]] — токен-модель
- [[concepts/multi-tenancy]] — этот сервис владеет enterprise-регистрацией
- Все остальные сервисы проверяют JWT через [[concepts/auth]]

## Открытые вопросы
- Насколько полно пропагируется `enterprise_id` в другие сервисы (event headers? JWT claim?) — проверить при ingest-е [[concepts/events]].
