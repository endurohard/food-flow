# Анализ архитектуры и взаимодействия системы FoodFlow

## Дата создания: 2025-11-10
## Версия: 1.0

---

## 1. Общая архитектура системы

### 1.1 Микросервисная архитектура

FoodFlow построен на микросервисной архитектуре с использованием Docker Compose для оркестрации сервисов:

```
┌─────────────────────────────────────────────────────────────┐
│                         Kong API Gateway                     │
│                        (порт 80/443)                         │
└────────────┬────────────────────────────────────────────────┘
             │
    ┌────────┴────────┐
    │  Load Balancer  │
    │   & Routing     │
    └────────┬────────┘
             │
    ┌────────┴──────────────────────────────────────┐
    │                                                │
┌───▼──────┐  ┌──────────┐  ┌──────────┐  ┌───────▼────┐
│Restaurant│  │   User   │  │  Order   │  │  Yeastar   │
│ Service  │  │ Service  │  │ Service  │  │  Service   │
│  :3001   │  │  :3002   │  │  :3003   │  │   :3008    │
└───┬──────┘  └────┬─────┘  └────┬─────┘  └─────┬──────┘
    │              │              │              │
    └──────────────┴──────────────┴──────────────┘
                          │
            ┌─────────────┴──────────────┐
            │                            │
       ┌────▼─────┐              ┌──────▼────┐
       │PostgreSQL│              │   Redis   │
       │Database  │              │   Cache   │
       │  :5432   │              │   :6379   │
       └──────────┘              └───────────┘
```

### 1.2 Основные компоненты

1. **Kong API Gateway**
   - Единая точка входа для всех API запросов
   - Роутинг запросов к микросервисам
   - CORS, аутентификация, rate limiting

2. **Микросервисы**
   - **restaurant-service** (порт 3001): Управление ресторанами, столами, меню
   - **user-service** (порт 3002): Управление пользователями, аутентификация
   - **order-service** (порт 3003): Обработка заказов
   - **yeastar-service** (порт 3008): Интеграция с PBX телефонией

3. **Хранилища данных**
   - **PostgreSQL**: Основная реляционная БД
   - **Redis**: Кеширование, сессии

4. **Frontend**
   - Single Page Application (SPA)
   - Vanilla JavaScript (без фреймворков)
   - Responsive дизайн

---

## 2. Потоки данных и взаимодействие

### 2.1 Аутентификация и авторизация

```
User → Frontend → Kong Gateway → user-service
                                     │
                    ┌────────────────┴─────────────────┐
                    │                                  │
              ┌─────▼─────┐                     ┌─────▼─────┐
              │PostgreSQL │                     │   Redis   │
              │(users)    │                     │(sessions) │
              └───────────┘                     └───────────┘
```

**Процесс:**
1. Пользователь вводит логин/пароль в `user-profile.html`
2. Frontend отправляет POST `/api/auth/login` через Kong
3. user-service проверяет credentials в PostgreSQL
4. Создается сессия в Redis
5. Возвращается JWT токен
6. Frontend сохраняет токен в localStorage
7. Все последующие запросы содержат токен в заголовке `Authorization`

**Роли и права доступа:**
- **Admin**: Полный доступ ко всем функциям
- **Manager**: Управление заказами, персоналом, отчётами
- **Operator**: Приём заказов, управление столами
- **Chef**: Работа с KDS, остатками
- **Waiter**: Управление столами, заказами

### 2.2 Управление заказами

```
Frontend (orders.html) → Kong → order-service
                                      │
                      ┌───────────────┴────────────────┐
                      │                                │
                ┌─────▼─────┐                   ┌─────▼─────┐
                │PostgreSQL │                   │WebSocket  │
                │(orders)   │                   │(real-time)│
                └───────────┘                   └─────┬─────┘
                                                      │
                                              ┌───────▼──────┐
                                              │KDS Display   │
                                              │(kds.html)    │
                                              └──────────────┘
```

**Процесс создания заказа:**
1. Оператор создает заказ в `orders.html`
2. POST `/api/orders` → order-service
3. order-service сохраняет в PostgreSQL
4. Отправляет WebSocket событие `order:new`
5. KDS экран получает событие и обновляется
6. order-service отправляет в restaurant-service для обновления стола

### 2.3 Телефония (Yeastar PBX)

```
Yeastar PBX ←──AMI──→ yeastar-service ←─HTTP─→ Frontend
  (www.it005.ru:5038)       (Docker)                (calls.html)
        │
    ┌───┴───┐
    │Events:│
    │- Dial │
    │- Hangup
    │- Newstate
    └───────┘
```

**Процесс обработки звонка:**
1. Входящий звонок → Yeastar PBX
2. PBX отправляет AMI событие `Newchannel` на порт 5038
3. yeastar-service получает событие через TCP socket
4. Парсит AMI протокол и создает объект Call
5. Сохраняет в памяти и отправляет в Redis
6. Frontend периодически запрашивает `/api/calls/active`
7. Отображает активные звонки в `calls.html`

**Click-to-Call:**
1. Оператор нажимает "Позвонить" в `calls.html`
2. POST `/api/calls/dial` с номерами from/to
3. yeastar-service отправляет AMI команду `Originate`
4. PBX инициирует звонок
5. Обновляет статус звонка

### 2.4 Управление складом и производством

```
Frontend (inventory.html)
    │
    ├─ Остатки ────────→ GET /api/inventory
    │
    ├─ Производство ───→ GET /api/production
    │   └─ Создание производства
    │       └─ POST /api/production
    │           ├─ Выбор материалов из inventory
    │           ├─ Списание со склада
    │           └─ Добавление готового продукта
    │
    └─ Опт и отгрузка ─→ GET /api/shipments
        └─ Создание отгрузки
            └─ POST /api/shipments
                ├─ Выбор товаров
                ├─ Формирование путевого листа
                ├─ Списание со склада
                └─ Создание документа отгрузки
```

**Процесс производства:**
1. Менеджер создает задание на производство
2. Выбирает материалы из склада (inventory)
3. Система списывает материалы
4. Создается запись в таблице `productions`
5. После завершения производства:
   - Обновляется статус → `completed`
   - Готовый продукт добавляется в inventory
   - Рассчитывается себестоимость

**Процесс оптовой отгрузки:**
1. Создается заказ на отгрузку
2. Выбираются товары из склада
3. Формируется путевой лист (номер ПЛ-XXXXXX)
4. Товары списываются со склада
5. Статус отгрузки: `pending` → `in-transit` → `delivered`
6. Путевой лист можно распечатать

### 2.5 Автозапуск телефонии

```
User Login → index.html
                │
    ┌───────────▼───────────────┐
    │ telephony-autolaunch.js   │
    └───────────┬───────────────┘
                │
    ┌───────────▼────────────┐
    │ loadCurrentUser()       │
    │   ├─ localStorage       │
    │   └─ GET /api/auth/me   │
    └───────────┬────────────┘
                │
    ┌───────────▼────────────┐
    │ hasUserSIPCredentials()?│
    └───────────┬────────────┘
                │
         ┌──────┴──────┐
         │             │
       YES            NO
         │             │
         │       showSetupNotification()
         │
    ┌────▼──────────┐
    │autoLaunchEnabled?│
    └────┬──────────┘
         │
    ┌────┴────┐
    │        │
   YES      NO
    │        │
    │   showLaunchNotification()
    │
┌───▼────────────┐
│launchTelephony()│
│                 │
│ POST /api/pbx/switch-transport
│   └─ {extension, password, server}
│
└────┬───────────┘
     │
┌────▼────────────┐
│showTelephonyStatus()│
│  (connecting...)    │
└────┬────────────┘
     │
┌────▼────────────┐
│checkConnectionStatus()│
│  (after 3 sec)      │
│                     │
│  GET /api/pbx/connection
│                     │
└────┬────────────┘
     │
┌────▼────────────┐
│showTelephonyStatus()│
│  (connected ✅)    │
└─────────────────┘
```

---

## 3. Хранение данных

### 3.1 PostgreSQL схема

```sql
-- Users table
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  role VARCHAR(20), -- admin, manager, operator, chef, waiter
  sip_extension VARCHAR(10),
  sip_password VARCHAR(50),
  sip_server VARCHAR(100),
  sip_port INTEGER DEFAULT 5060,
  sip_enabled BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Restaurants table
CREATE TABLE restaurants (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  address TEXT,
  phone VARCHAR(20),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tables table
CREATE TABLE tables (
  id SERIAL PRIMARY KEY,
  restaurant_id INTEGER REFERENCES restaurants(id),
  table_number VARCHAR(10),
  capacity INTEGER,
  status VARCHAR(20), -- free, occupied, reserved
  position_x INTEGER,
  position_y INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Orders table
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  restaurant_id INTEGER REFERENCES restaurants(id),
  table_id INTEGER REFERENCES tables(id),
  user_id INTEGER REFERENCES users(id),
  total_amount DECIMAL(10,2),
  status VARCHAR(20), -- pending, preparing, ready, completed, cancelled
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

-- Order items
CREATE TABLE order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id),
  menu_item_id INTEGER REFERENCES menu_items(id),
  quantity INTEGER,
  price DECIMAL(10,2),
  notes TEXT
);

-- Menu items
CREATE TABLE menu_items (
  id SERIAL PRIMARY KEY,
  restaurant_id INTEGER REFERENCES restaurants(id),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  price DECIMAL(10,2),
  category VARCHAR(50),
  image_url TEXT,
  available BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Inventory
CREATE TABLE inventory (
  id SERIAL PRIMARY KEY,
  restaurant_id INTEGER REFERENCES restaurants(id),
  name VARCHAR(100) NOT NULL,
  category VARCHAR(50),
  quantity DECIMAL(10,2),
  unit VARCHAR(20),
  min_quantity DECIMAL(10,2),
  cost_price DECIMAL(10,2),
  supplier_id INTEGER REFERENCES suppliers(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Suppliers
CREATE TABLE suppliers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  contact_person VARCHAR(100),
  phone VARCHAR(20),
  email VARCHAR(100),
  address TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Productions
CREATE TABLE productions (
  id SERIAL PRIMARY KEY,
  restaurant_id INTEGER REFERENCES restaurants(id),
  product_name VARCHAR(100),
  quantity DECIMAL(10,2),
  unit VARCHAR(20),
  materials_cost DECIMAL(10,2),
  total_cost DECIMAL(10,2),
  responsible_user_id INTEGER REFERENCES users(id),
  status VARCHAR(20), -- planned, in-progress, completed
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

-- Shipments (wholesale)
CREATE TABLE shipments (
  id SERIAL PRIMARY KEY,
  restaurant_id INTEGER REFERENCES restaurants(id),
  order_number VARCHAR(50) UNIQUE,
  client_name VARCHAR(100),
  client_phone VARCHAR(20),
  total_quantity INTEGER,
  total_amount DECIMAL(10,2),
  waybill_number VARCHAR(50),
  status VARCHAR(20), -- pending, in-transit, delivered, cancelled
  created_at TIMESTAMP DEFAULT NOW(),
  delivered_at TIMESTAMP
);

-- Shipment items
CREATE TABLE shipment_items (
  id SERIAL PRIMARY KEY,
  shipment_id INTEGER REFERENCES shipments(id),
  product_name VARCHAR(100),
  quantity INTEGER,
  price DECIMAL(10,2)
);

-- Call logs
CREATE TABLE call_logs (
  id SERIAL PRIMARY KEY,
  call_id VARCHAR(100) UNIQUE,
  direction VARCHAR(20), -- inbound, outbound
  from_number VARCHAR(20),
  to_number VARCHAR(20),
  extension VARCHAR(10),
  status VARCHAR(20), -- ringing, answered, completed, failed
  duration INTEGER, -- seconds
  recording_url TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  answered_at TIMESTAMP,
  ended_at TIMESTAMP
);
```

### 3.2 Redis структура данных

```
// Session management
session:{sessionId} → {userId, username, role, expiresAt}

// Active calls cache
calls:active:{callId} → {from, to, status, startTime}

// Feature toggles cache
features:{restaurantId} → {tables: true, kds: true, ...}

// Role permissions cache
permissions:{role} → {orders: true, orders-edit: true, ...}

// User SIP credentials cache
sip:{userId} → {extension, server, port, enabled}
```

### 3.3 LocalStorage (Frontend)

```javascript
// User session
currentUser → {
  username: string,
  displayName: string,
  role: string,
  sip: {
    enabled: boolean,
    extension: string,
    password: string,
    server: string,
    port: number,
    transport: 'UDP' | 'TCP' | 'WS' | 'WSS'
  }
}

// Feature toggles
featureSettings → {
  tables: boolean,
  kds: boolean,
  orders: boolean,
  menu: boolean,
  inventory: boolean,
  staff: boolean,
  loyalty: boolean,
  analytics: boolean,
  telephony: boolean,
  printers: boolean
}

// Role permissions
rolePermissions → {
  [roleName]: {
    orders: boolean,
    'orders-edit': boolean,
    'orders-delete': boolean,
    tables: boolean,
    // ...
  }
}

// Telephony settings
telephony_autolaunch → 'true' | 'false'
telephony_show_panel → 'true' | 'false'

// Inventory data (demo mode)
inventory → [...items]
restaurantSuppliers → [...suppliers]
restaurantPurchaseOrders → [...orders]
restaurantProductions → [...productions]
restaurantShipments → [...shipments]
```

---

## 4. API Endpoints

### 4.1 Authentication (`user-service`)

```
POST   /api/auth/login
  Body: {username, password}
  Response: {token, user}

POST   /api/auth/logout
  Headers: Authorization: Bearer {token}

GET    /api/auth/me
  Headers: Authorization: Bearer {token}
  Response: {user with sip credentials}

PUT    /api/users/:id/sip
  Body: {extension, password, server, port, enabled}
```

### 4.2 Orders (`order-service`)

```
GET    /api/orders
  Query: ?status=pending&table_id=5

POST   /api/orders
  Body: {table_id, items: [...], total_amount}

PUT    /api/orders/:id
  Body: {status, ...}

DELETE /api/orders/:id

GET    /api/orders/:id
```

### 4.3 Telephony (`yeastar-service`)

```
GET    /api/calls/active
  Response: {calls: [...]}

POST   /api/calls/dial
  Body: {from, to, autoAnswer}

POST   /api/calls/hangup/:callId

GET    /api/calls/history
  Query: ?from_date=...&to_date=...

GET    /api/pbx/connection
  Response: {connected: boolean, server, extensions: [...]}

POST   /api/pbx/switch-transport
  Body: {
    server, port, transport,
    useWebSocket, websocketUrl,
    users: [{username, password, extension, displayName}]
  }
```

### 4.4 Inventory & Production (`restaurant-service`)

```
GET    /api/inventory
  Response: {items: [...]}

POST   /api/inventory
  Body: {name, category, quantity, unit, ...}

PUT    /api/inventory/:id
  Body: {quantity, ...}

GET    /api/production
  Response: {productions: [...]}

POST   /api/production
  Body: {
    product_name, quantity, unit,
    materials: [{inventory_id, quantity}],
    responsible_user_id
  }

PUT    /api/production/:id/complete

GET    /api/shipments
  Response: {shipments: [...]}

POST   /api/shipments
  Body: {
    client_name, client_phone,
    items: [{product, quantity, price}]
  }

POST   /api/shipments/:id/generate-waybill
  Response: {waybill_number}

PUT    /api/shipments/:id/status
  Body: {status: 'in-transit' | 'delivered'}
```

### 4.5 Tables (`restaurant-service`)

```
GET    /api/tables
  Response: {tables: [...]}

POST   /api/tables
  Body: {table_number, capacity, position_x, position_y}

PUT    /api/tables/:id
  Body: {status: 'free' | 'occupied' | 'reserved'}
```

---

## 5. Ключевые функции и их реализация

### 5.1 Управление ролями и доступом

**Файл:** `frontend/admin-panel/settings.html`

**Функции:**
- `loadRolePermissions()` - Загружает права для выбранной роли
- `saveRolePermissions()` - Сохраняет изменения прав
- `hasPermission(role, permission)` - Проверяет наличие права у роли

**Логика:**
1. Пользователь выбирает роль из выпадающего списка
2. Загружаются сохраненные права из localStorage или defaults
3. Чекбоксы обновляются в соответствии с правами
4. При сохранении права записываются в localStorage
5. При входе пользователя проверяются его права
6. Функционал скрывается/отключается на основе прав

**Пример использования:**
```javascript
// Проверка прав
if (hasPermission(currentUser.role, 'orders-delete')) {
  showDeleteButton();
}

// Скрытие элементов интерфейса
if (!hasPermission(currentUser.role, 'analytics')) {
  document.getElementById('analytics-menu').style.display = 'none';
}
```

### 5.2 Автозапуск телефонии

**Файл:** `frontend/admin-panel/js/telephony-autolaunch.js`

**Класс:** `TelephonyAutoLauncher`

**Основные методы:**
- `init()` - Инициализация при загрузке страницы
- `loadCurrentUser()` - Загрузка данных пользователя
- `hasUserSIPCredentials()` - Проверка наличия SIP данных
- `launchTelephony()` - Запуск телефонии
- `configurePBXService(config)` - Настройка PBX сервиса
- `checkConnectionStatus()` - Проверка подключения
- `showTelephonyStatus(status, message)` - Отображение статуса

**Логика работы:**
1. При загрузке страницы вызывается `init()`
2. Загружаются данные пользователя из localStorage или API
3. Проверяется наличие SIP учетных данных
4. Если есть и autoLaunch включен → запускается телефония
5. Отправляется конфигурация на `/api/pbx/switch-transport`
6. Через 3 секунды проверяется статус подключения
7. Показывается уведомление о статусе
8. При успешном подключении уведомление скрывается через 5 сек

**Интеграция:**
```html
<!-- В каждой странице админки -->
<script src="js/telephony-autolaunch.js"></script>
```

### 5.3 Производство

**Файл:** `frontend/admin-panel/inventory.html`

**Функции:**
- `renderProduction()` - Отрисовка списка производств
- `openNewProductionModal()` - Создание нового производства
- `viewProductionDetails(id)` - Просмотр деталей
- `completeProduction(id)` - Завершение производства

**Процесс:**
1. Менеджер открывает вкладку "Производство"
2. Видит список всех производств с статусами
3. Нажимает "Новое производство"
4. Выбирает продукт и количество
5. Выбирает материалы из склада
6. Указывает ответственного
7. Система рассчитывает стоимость материалов
8. Создается запись со статусом "planned" или "in-progress"
9. После завершения нажимает "Завершить"
10. Статус меняется на "completed"
11. Готовый продукт добавляется в склад

### 5.4 Оптовая отгрузка и путевые листы

**Файл:** `frontend/admin-panel/inventory.html`

**Функции:**
- `renderWholesale()` - Отрисовка списка отгрузок
- `openNewShipmentModal()` - Создание новой отгрузки
- `generateWaybill(id)` - Формирование путевого листа
- `printWaybill(number)` - Печать путевого листа
- `markInTransit(id)` - Отметка "В пути"
- `markDelivered(id)` - Отметка "Доставлено"

**Процесс оформления заказа:**
1. Менеджер создает заказ на отгрузку
2. Заполняет данные клиента (название, телефон)
3. Добавляет товары и количество
4. Система рассчитывает сумму
5. Заказ создается со статусом "pending"
6. Менеджер нажимает "Создать путевой лист"
7. Генерируется номер ПЛ-XXXXXX
8. Можно распечатать путевой лист
9. При отправке нажимает "В путь" → статус "in-transit"
10. При доставке нажимает "Доставлено" → статус "delivered"

**Структура путевого листа:**
- Номер путевого листа
- Дата отгрузки
- Данные клиента
- Список товаров с количеством
- Общая сумма
- Подпись отпустившего
- Подпись получившего

---

## 6. Безопасность

### 6.1 Аутентификация
- JWT токены с истечением через 24 часа
- Пароли хешируются bcrypt
- Secure, httpOnly cookies для session ID

### 6.2 Авторизация
- Role-based access control (RBAC)
- Проверка прав на уровне backend API
- Проверка прав на уровне frontend (UI скрытие)
- Middleware для валидации прав в Kong

### 6.3 Защита API
- Rate limiting через Kong (100 req/min per IP)
- CORS настройки для домена
- Input validation на backend
- SQL injection защита через ORM
- XSS защита через sanitization

### 6.4 PBX Безопасность
- AMI пароли в environment variables
- Whitelist IP адресов для AMI
- SIP credentials encrypted at rest
- TLS для WebSocket соединений

---

## 7. Масштабируемость

### 7.1 Горизонтальное масштабирование
```yaml
services:
  restaurant-service:
    deploy:
      replicas: 3
    environment:
      NODE_ENV: production
```

### 7.2 Кеширование
- Redis для сессий
- Redis для часто запрашиваемых данных (меню, столы)
- Browser cache для статических ресурсов
- CDN для images

### 7.3 Database
- Connection pooling (max 20 connections)
- Read replicas для отчётов
- Indexes на часто запрашиваемые поля
- Partitioning для больших таблиц (orders, call_logs)

---

## 8. Мониторинг и логирование

### 8.1 Логирование
```javascript
// Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});
```

### 8.2 Метрики
- Prometheus для сбора метрик
- Grafana для визуализации
- Метрики: request count, response time, error rate

### 8.3 Healthcheck
```
GET /health
Response: {
  status: 'ok',
  database: 'connected',
  redis: 'connected',
  pbx: 'connected',
  uptime: 3600
}
```

---

## 9. Развертывание

### 9.1 Development
```bash
docker-compose up -d
```

### 9.2 Production
```bash
docker-compose -f docker-compose.prod.yml up -d
```

**Переменные окружения:**
```env
NODE_ENV=production
DATABASE_URL=postgresql://user:pass@host:5432/db
REDIS_URL=redis://host:6379
YEASTAR_HOST=www.it005.ru
YEASTAR_PORT=5038
YEASTAR_USERNAME=1cuser
YEASTAR_PASSWORD=1csecret
JWT_SECRET=your-secret-key
```

---

## 10. Диаграмма последовательности: Создание заказа с производством

```
Оператор    Frontend    Kong    Order-Service    Restaurant-Service    Inventory    PostgreSQL
   │            │         │            │                  │               │            │
   │─создает────>│         │            │                  │               │            │
   │   заказ    │         │            │                  │               │            │
   │            │─POST────>│            │                  │               │            │
   │            │ /orders │            │                  │               │            │
   │            │         │─route──────>│                  │               │            │
   │            │         │            │──проверка────────>│               │            │
   │            │         │            │  наличия         │─проверка──────>│            │
   │            │         │            │  на складе       │  остатков     │            │
   │            │         │            │                  │               │<───SELECT──│
   │            │         │            │                  │<──остатки─────│            │
   │            │         │            │<──недостаточно───│               │            │
   │            │         │            │                  │               │            │
   │            │         │            │──создать─────────>│               │            │
   │            │         │            │  производство    │               │            │
   │            │         │            │                  │─INSERT────────────────────>│
   │            │         │            │                  │  production   │            │
   │            │         │            │                  │<──created─────────────────│
   │            │         │            │<──production_id──│               │            │
   │            │         │            │                  │               │            │
   │            │         │            │──создать заказ───────────────────────────────>│
   │            │         │            │  со статусом     │               │   INSERT   │
   │            │         │            │  pending         │               │   order    │
   │            │         │            │<──order_id───────────────────────────────────│
   │            │         │            │                  │               │            │
   │            │         │<─response──│                  │               │            │
   │            │<─200 OK─│            │                  │               │            │
   │<─заказ─────│         │            │                  │               │            │
   │  создан    │         │            │                  │               │            │
   │            │         │            │                  │               │            │
   │            │         │   [через некоторое время производство завершено]           │
   │            │         │            │                  │               │            │
Повар          │         │            │                  │               │            │
   │────────────────────────────────────завершить производство─────────────────────────>│
   │            │         │            │                  │               │   UPDATE   │
   │            │         │            │                  │               │ production │
   │            │         │            │                  │               │ status=    │
   │            │         │            │                  │               │ completed  │
   │            │         │            │                  │               │            │
   │            │         │            │──добавить────────>│               │            │
   │            │         │            │  продукт         │─UPDATE────────────────────>│
   │            │         │            │  на склад        │  inventory   │            │
   │            │         │            │                  │  +quantity   │            │
   │            │         │            │<──updated────────│               │            │
   │            │         │            │                  │               │            │
   │            │         │            │──обновить статус──────────────────────────────>│
   │            │         │            │  заказа на       │               │   UPDATE   │
   │            │         │            │  preparing       │               │   order    │
   │            │         │            │                  │               │            │
   │            │         │            │──WebSocket event─>│               │            │
   │            │         │            │  order:updated   │               │            │
   │            │         │            │                  │               │            │
Оператор       │         │            │                  │               │            │
   │<────────────────уведомление: заказ готов к приготовлению──────────────            │
   │            │         │            │                  │               │            │
```

---

## Заключение

FoodFlow - это комплексная система управления рестораном с микросервисной архитектурой, обеспечивающая:

✅ **Масштабируемость** через Docker и микросервисы
✅ **Безопасность** через JWT, RBAC, rate limiting
✅ **Гибкость** через модульную архитектуру и feature toggles
✅ **Интеграции** с PBX системами (Yeastar)
✅ **Полный цикл** от приёма заказа до производства и отгрузки
✅ **Управление доступом** на основе ролей
✅ **Real-time** обновления через WebSocket

Система готова к развертыванию и дальнейшему расширению функционала.
