# FoodFlow Multi-Tenant Architecture Guide

## Обзор

FoodFlow теперь поддерживает мультитенантность (multi-tenancy) на уровне предприятий (enterprises). Каждое предприятие имеет собственное изолированное пространство с пользователями, ресторанами, меню, заказами и другими данными.

## Ключевые концепции

### 1. Предприятия (Enterprises)
Предприятие - это основная единица тенантности в системе. Это может быть:
- Сеть ресторанов
- Отдельный ресторан
- Группа кафе
- Франшиза

### 2. Роли пользователей в предприятии

- **Owner (Владелец)** - полный доступ, может удалять предприятие
- **Admin (Администратор)** - полный доступ к управлению, кроме удаления
- **Manager (Менеджер)** - управление операциями
- **Employee (Сотрудник)** - базовый доступ к функциям
- **Viewer (Наблюдатель)** - только просмотр данных

### 3. Изоляция данных

Все данные изолируются по `enterprise_id`:
- Пользователи
- Рестораны
- Меню (категории и позиции)
- Заказы
- Инвентарь

## Структура базы данных

### Новые таблицы

#### `enterprises`
```sql
id                    UUID PRIMARY KEY
name                  VARCHAR(255)      -- Название предприятия
legal_name            VARCHAR(255)      -- Юридическое название
tax_id                VARCHAR(50)       -- ИНН/КПП
subscription_plan     VARCHAR(50)       -- basic, pro, enterprise
is_active             BOOLEAN
```

#### `enterprise_users`
```sql
id              UUID PRIMARY KEY
enterprise_id   UUID              -- ID предприятия
user_id         UUID              -- ID пользователя
role            VARCHAR(50)       -- owner, admin, manager, employee, viewer
permissions     JSONB             -- Детальные разрешения
is_active       BOOLEAN
```

#### `enterprise_addresses`
```sql
id              UUID PRIMARY KEY
enterprise_id   UUID
address_type    VARCHAR(50)       -- main, billing, warehouse
street_address  VARCHAR(255)
city            VARCHAR(100)
country         VARCHAR(100)
```

### Обновленные таблицы

Все основные таблицы получили поле `enterprise_id`:
- `users` (+ `is_enterprise_admin`)
- `restaurants`
- `orders`
- `menu_categories`
- `menu_items`

## API Endpoints

### Базовый URL
```
http://localhost/api/enterprises
```

### 1. Создание предприятия

```http
POST /api/enterprises
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "Моя сеть ресторанов",
  "legal_name": "ООО \"Вкусно\"",
  "tax_id": "1234567890",
  "phone": "+7 999 123-45-67",
  "email": "info@myrestaurants.ru",
  "subscription_plan": "pro"
}
```

**Ответ:**
```json
{
  "success": true,
  "enterprise": {
    "id": "uuid-here",
    "name": "Моя сеть ресторанов",
    ...
  }
}
```

### 2. Получить предприятия пользователя

```http
GET /api/enterprises/my
Authorization: Bearer <token>
```

**Ответ:**
```json
{
  "success": true,
  "enterprises": [
    {
      "enterprise_id": "uuid-1",
      "enterprise_name": "Ресторан 1",
      "user_role": "owner",
      "is_active": true
    },
    {
      "enterprise_id": "uuid-2",
      "enterprise_name": "Ресторан 2",
      "user_role": "manager",
      "is_active": true
    }
  ]
}
```

### 3. Получить информацию о предприятии

```http
GET /api/enterprises/{id}
Authorization: Bearer <token>
```

### 4. Обновить предприятие

```http
PUT /api/enterprises/{id}
Authorization: Bearer <token>
X-Enterprise-ID: {enterprise-id}
Content-Type: application/json

{
  "name": "Новое название",
  "phone": "+7 999 000-00-00"
}
```

**Требуется роль:** `owner` или `admin`

### 5. Управление пользователями предприятия

#### Получить всех пользователей
```http
GET /api/enterprises/{id}/users
Authorization: Bearer <token>
X-Enterprise-ID: {enterprise-id}
```

#### Добавить пользователя
```http
POST /api/enterprises/{id}/users
Authorization: Bearer <token>
X-Enterprise-ID: {enterprise-id}
Content-Type: application/json

{
  "userId": "user-uuid",
  "role": "employee",
  "permissions": {
    "orders.view": true,
    "orders.create": true,
    "menu.view": true
  }
}
```

**Требуется роль:** `owner` или `admin`

#### Изменить роль пользователя
```http
PUT /api/enterprises/{id}/users/{userId}
Authorization: Bearer <token>
X-Enterprise-ID: {enterprise-id}
Content-Type: application/json

{
  "role": "manager",
  "permissions": {
    "orders.view": true,
    "orders.create": true,
    "orders.update": true,
    "menu.view": true,
    "menu.edit": true
  }
}
```

#### Удалить пользователя из предприятия
```http
DELETE /api/enterprises/{id}/users/{userId}
Authorization: Bearer <token>
X-Enterprise-ID: {enterprise-id}
```

### 6. Статистика предприятия

```http
GET /api/enterprises/{id}/stats
Authorization: Bearer <token>
X-Enterprise-ID: {enterprise-id}
```

**Ответ:**
```json
{
  "success": true,
  "stats": {
    "total_users": 15,
    "total_restaurants": 3,
    "total_orders": 1250,
    "completed_orders": 1100,
    "total_revenue": "2500000.00"
  }
}
```

## Аутентификация и контекст предприятия

### Headers для запросов

При работе с API нужно передавать:

1. **Authorization** - JWT токен пользователя
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

2. **X-Enterprise-ID** - ID предприятия (опционально)
```
X-Enterprise-ID: 550e8400-e29b-41d4-a716-446655440000
```

Если `X-Enterprise-ID` не указан, используется первое активное предприятие пользователя.

### Middleware

Система использует три основных middleware:

1. **`authenticateUser`** - проверка JWT токена
2. **`enterpriseContext`** - установка контекста предприятия
3. **`requireEnterpriseRole`** - проверка роли пользователя

## Row Level Security (RLS)

База данных использует политики RLS для автоматической изоляции данных:

```sql
-- Пример: Пользователь видит только свои предприятия
CREATE POLICY enterprise_isolation_policy ON enterprises
    FOR ALL
    USING (
        id IN (
            SELECT enterprise_id
            FROM enterprise_users
            WHERE user_id = current_setting('app.current_user_id')::UUID
        )
    );
```

## Примеры использования

### Сценарий 1: Создание нового предприятия

```javascript
// 1. Регистрация пользователя
POST /api/auth/register
{
  "email": "owner@restaurant.ru",
  "password": "securepass123",
  "first_name": "Иван",
  "last_name": "Петров"
}

// 2. Вход в систему
POST /api/auth/login
{
  "email": "owner@restaurant.ru",
  "password": "securepass123"
}
// Ответ: { "token": "..." }

// 3. Создание предприятия
POST /api/enterprises
Authorization: Bearer <token>
{
  "name": "Мой ресторан",
  "phone": "+7 999 123-45-67"
}
```

### Сценарий 2: Добавление сотрудника

```javascript
// 1. Регистрация сотрудника
POST /api/auth/register
{
  "email": "employee@restaurant.ru",
  "password": "password123",
  "first_name": "Мария",
  "last_name": "Иванова"
}

// 2. Владелец добавляет сотрудника в предприятие
POST /api/enterprises/{enterprise-id}/users
Authorization: Bearer <owner-token>
X-Enterprise-ID: {enterprise-id}
{
  "userId": "employee-uuid",
  "role": "employee",
  "permissions": {
    "orders.view": true,
    "orders.create": true
  }
}
```

### Сценарий 3: Работа с заказами

```javascript
// Все запросы автоматически фильтруются по enterprise_id
GET /api/orders
Authorization: Bearer <token>
X-Enterprise-ID: {enterprise-id}

// Пользователь видит только заказы своего предприятия
```

## Планы подписки

### Basic
- До 5 пользователей
- 1 ресторан
- Базовая аналитика

### Pro
- До 25 пользователей
- До 5 ресторанов
- Расширенная аналитика
- Поддержка доставки

### Enterprise
- Неограниченно пользователей
- Неограниченно ресторанов
- Полная аналитика
- API доступ
- Приоритетная поддержка

## Безопасность

1. **Изоляция данных** - RLS на уровне базы данных
2. **Проверка прав** - Middleware проверяет доступ к каждому предприятию
3. **Аудит** - Все действия логируются с `enterprise_id`
4. **Шифрование** - Все данные передаются через HTTPS

## Миграция существующих данных

Если у вас уже есть данные без `enterprise_id`:

```sql
-- Создать предприятие для существующих данных
INSERT INTO enterprises (name, is_demo)
VALUES ('Legacy Enterprise', false)
RETURNING id;

-- Обновить существующие записи
UPDATE users SET enterprise_id = '<enterprise-id>' WHERE enterprise_id IS NULL;
UPDATE restaurants SET enterprise_id = '<enterprise-id>' WHERE enterprise_id IS NULL;
UPDATE orders SET enterprise_id = '<enterprise-id>' WHERE enterprise_id IS NULL;
```

## Тестовые предприятия

При применении миграции создаются 2 демо-предприятия:

1. **Demo Restaurant Group** (plan: pro)
2. **Test Cafe Chain** (plan: basic)

## Troubleshooting

### Ошибка: "No enterprise access"
- Убедитесь, что пользователь добавлен в `enterprise_users`
- Проверьте, что `is_active = true`

### Ошибка: "Access denied"
- Проверьте роль пользователя
- Убедитесь, что операция разрешена для вашей роли

### Ошибка: "Enterprise not found"
- Проверьте правильность `enterprise_id`
- Убедитесь, что предприятие не деактивировано

## Дальнейшее развитие

Планируется добавить:
- [ ] Биллинг и оплата подписок
- [ ] Детальные права доступа (permissions) для каждого модуля
- [ ] Аудит лог всех действий
- [ ] Импорт/экспорт данных предприятия
- [ ] Мультиязычность интерфейса по предприятиям
- [ ] Брендинг (логотипы, цвета) для каждого предприятия

## Контакты и поддержка

Для вопросов по мультитенантности:
- Email: support@foodflow.ru
- Документация: https://docs.foodflow.ru/multi-tenant
