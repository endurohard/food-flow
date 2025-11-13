# Быстрый старт: Мультитенантность FoodFlow

## ✅ Что сделано

Система FoodFlow теперь поддерживает **мультитенантность на уровне предприятий** (enterprises). Каждое предприятие имеет полную изоляцию данных.

### Реализованные функции:

1. ✅ **База данных**
   - Таблица `enterprises` для хранения предприятий
   - Таблица `enterprise_users` для управления доступом пользователей
   - Таблица `enterprise_addresses` для адресов предприятий
   - Поля `enterprise_id` во всех основных таблицах
   - Row Level Security (RLS) для автоматической изоляции данных

2. ✅ **Backend сервисы**
   - `EnterpriseService` - бизнес-логика управления предприятиями
   - `enterpriseContext` - middleware для установки контекста предприятия
   - `requireEnterpriseRole` - middleware для проверки ролей
   - API endpoints для управления предприятиями

3. ✅ **Роли и права доступа**
   - Owner (владелец)
   - Admin (администратор)
   - Manager (менеджер)
   - Employee (сотрудник)
   - Viewer (наблюдатель)

## 🚀 Как использовать

### 1. Доступ через API

Все запросы теперь требуют указания предприятия через header:

```bash
# Получить список предприятий пользователя
curl http://localhost/api/enterprises/my \
  -H "Authorization: Bearer YOUR_TOKEN"

# Работа с конкретным предприятием
curl http://localhost/api/orders \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "X-Enterprise-ID: 7617c1eb-4144-4f63-b67d-a73dba75ae0b"
```

### 2. Создание нового предприятия

```bash
curl -X POST http://localhost/api/enterprises \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Моя сеть ресторанов",
    "legal_name": "ООО \"Вкусно\"",
    "phone": "+7 999 123-45-67",
    "email": "info@restaurant.ru"
  }'
```

### 3. Добавление пользователя в предприятие

```bash
curl -X POST http://localhost/api/enterprises/ENTERPRISE_ID/users \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "X-Enterprise-ID: ENTERPRISE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "USER_UUID",
    "role": "employee",
    "permissions": {
      "orders.view": true,
      "orders.create": true
    }
  }'
```

## 📊 Доступные endpoints

| Метод | URL | Описание | Роль |
|-------|-----|----------|------|
| POST | `/api/enterprises` | Создать предприятие | - |
| GET | `/api/enterprises/my` | Мои предприятия | - |
| GET | `/api/enterprises/:id` | Инфо о предприятии | - |
| PUT | `/api/enterprises/:id` | Обновить предприятие | owner, admin |
| DELETE | `/api/enterprises/:id` | Удалить предприятие | owner |
| GET | `/api/enterprises/:id/users` | Пользователи | - |
| POST | `/api/enterprises/:id/users` | Добавить пользователя | owner, admin |
| PUT | `/api/enterprises/:id/users/:userId` | Изменить роль | owner, admin |
| DELETE | `/api/enterprises/:id/users/:userId` | Удалить пользователя | owner, admin |
| GET | `/api/enterprises/:id/stats` | Статистика | - |

## 🗄️ Демо-предприятия

В базе данных созданы 2 демо-предприятия для тестирования:

```sql
SELECT * FROM enterprises;

                  id                  |         name          | subscription_plan
--------------------------------------+-----------------------+-------------------
 7617c1eb-4144-4f63-b67d-a73dba75ae0b | Demo Restaurant Group | pro
 751a9626-a1ee-4c46-8759-2bd1add326e9 | Test Cafe Chain       | basic
```

## 🔐 Автоматическая изоляция

Все запросы автоматически фильтруются по `enterprise_id`:

```javascript
// Пример: Получение заказов
GET /api/orders
// Вернет только заказы текущего предприятия

// Пример: Создание меню
POST /api/menu-items
// Автоматически привяжется к enterprise_id пользователя
```

## 📁 Структура файлов

```
services/user-service/src/
├── services/
│   └── enterprise.service.ts        # Бизнес-логика предприятий
├── middleware/
│   └── enterprise.middleware.ts     # Проверка доступа и контекста
├── routes/
│   └── enterprise.routes.ts         # API endpoints
└── index.ts                         # Подключение роутов

database/migrations/
└── 006_add_enterprises_multi_tenant.sql  # SQL миграция

docs/
├── MULTI_TENANT_GUIDE.md           # Полная документация
└── MULTI_TENANT_QUICK_START.md     # Этот файл
```

## 🔄 Следующие шаги

Для интеграции с существующими сервисами нужно:

1. **Обновить каждый сервис** для фильтрации по `enterprise_id`:
   ```typescript
   // Пример для restaurant-service
   app.get('/api/restaurants', enterpriseContext, async (req, res) => {
     const restaurants = await db.query(
       'SELECT * FROM restaurants WHERE enterprise_id = $1',
       [req.enterpriseId]
     );
     res.json(restaurants);
   });
   ```

2. **Добавить enterprise_id при создании записей**:
   ```typescript
   app.post('/api/restaurants', enterpriseContext, async (req, res) => {
     await db.query(
       'INSERT INTO restaurants (name, enterprise_id) VALUES ($1, $2)',
       [req.body.name, req.enterpriseId]
     );
   });
   ```

3. **Обновить frontend** для выбора предприятия и передачи `X-Enterprise-ID`

## 💡 Примеры использования

### JavaScript/TypeScript

```typescript
// Утилита для API запросов с enterprise context
const api = {
  request: async (url: string, options: RequestInit = {}) => {
    const token = localStorage.getItem('token');
    const enterpriseId = localStorage.getItem('current_enterprise_id');

    return fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Enterprise-ID': enterpriseId,
        'Content-Type': 'application/json',
        ...options.headers
      }
    });
  }
};

// Использование
const orders = await api.request('/api/orders').then(r => r.json());
```

### React компонент для выбора предприятия

```tsx
import { useState, useEffect } from 'react';

function EnterpriseSelector() {
  const [enterprises, setEnterprises] = useState([]);
  const [current, setCurrent] = useState(null);

  useEffect(() => {
    fetch('/api/enterprises/my', {
      headers: { 'Authorization': `Bearer ${token}` }
    })
      .then(r => r.json())
      .then(data => {
        setEnterprises(data.enterprises);
        setCurrent(data.enterprises[0]?.enterprise_id);
        localStorage.setItem('current_enterprise_id', data.enterprises[0]?.enterprise_id);
      });
  }, []);

  const handleChange = (enterpriseId) => {
    setCurrent(enterpriseId);
    localStorage.setItem('current_enterprise_id', enterpriseId);
    window.location.reload(); // Перезагрузить данные
  };

  return (
    <select value={current} onChange={(e) => handleChange(e.target.value)}>
      {enterprises.map(e => (
        <option key={e.enterprise_id} value={e.enterprise_id}>
          {e.enterprise_name} ({e.user_role})
        </option>
      ))}
    </select>
  );
}
```

## ⚠️ Важные замечания

1. **Всегда передавайте X-Enterprise-ID** в запросах к API
2. **Проверяйте роли** перед выполнением критичных операций
3. **Используйте RLS** для автоматической изоляции на уровне БД
4. **Логируйте все действия** с привязкой к enterprise_id

## 📞 Поддержка

- Документация: `/docs/MULTI_TENANT_GUIDE.md`
- Issues: GitHub Issues
- Email: support@foodflow.ru

## 🎯 Roadmap

- [ ] Биллинг и тарифные планы
- [ ] Детальные permissions для модулей
- [ ] Audit log всех действий
- [ ] Брендинг предприятий (логотипы, цвета)
- [ ] Импорт/экспорт данных
- [ ] Приглашения пользователей по email
