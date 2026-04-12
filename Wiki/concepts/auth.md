---
type: concept
status: stable
last_verified: 2026-04-11
sources:
  - services/user-service/src/routes/auth.routes.ts
  - services/user-service/src/config/index.ts
  - database/migrations/007_add_refresh_tokens.sql
  - frontend/admin-panel/js/auth.js
---

# Auth

JWT + refresh токены, RBAC.

## Модель
- **Access token**: JWT, короткоживущий. Secret и TTL — в `services/user-service/src/config/index.ts`.
- **Refresh token**: добавлен миграцией `007_add_refresh_tokens.sql` — хранится в БД, позволяет rotate access-токенов без повторного логина.
- **Роли**: `customer`, `restaurant_owner`, `driver`, `admin` (из `ARCHITECTURE.md`; возможно расширены под HR/POS).

## Endpoints (user-service)
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`

## Клиент
- `frontend/admin-panel/js/auth.js` — хранение токенов на фронте, авто-refresh
- `frontend/admin-panel/login.html` — форма входа

## Multi-tenant
JWT должен нести `enterprise_id` → см. [[concepts/multi-tenancy]]. Проверить наличие claim'а и учёт его во всех downstream-сервисах.

## Ответы (аудит 2026-04-11)
См. [[../decisions/2026-04-11-deep-audit]].

- **JWT проверяется в каждом сервисе**, не в Kong. `kong/kong.yml` содержит только CORS и rate-limit плагины, **jwt-плагина нет**.
- **Одинаковый hardcoded fallback секрет** во всех 9 сервисах: `'your-jwt-secret-key-change-in-production'`. Утечка одного = все скомпрометированы.
- **Refresh-токены**: сделаны корректно. SHA256 хеш в БД (007 migration), rotate со ссылкой `auth.service.ts:188-191`, 30-дневный TTL, проверка revocation.
- **Password**: bcrypt 10 rounds, `password_hash` не логируется и удаляется перед возвратом юзера.
- **Открытые endpoint'ы без auth** (критично): `GET /api/users` (возвращает PBX creds), `GET /api/orders/:id`, KDS endpoint'ы, delivery tracking.
- **CORS** настроен опасно: `origins=*` + `credentials=true` (`kong/kong.yml:156-157`).
