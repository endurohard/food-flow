# URL доступа к FoodFlow

## Основные адреса

### 🌐 Клиентское приложение
```
http://localhost/customer-app/
```
Приложение для клиентов ресторана

---

### 👨‍💼 Админ панель
```
http://localhost/admin-panel/
```

**Страницы админки:**
- **Главная / Принтеры:** `http://localhost/admin-panel/index.html`
- **Заказы:** `http://localhost/admin-panel/orders.html`
- **Столы:** `http://localhost/admin-panel/tables.html`
- **Дизайнер зала:** `http://localhost/admin-panel/hall-designer.html`
- **KDS (Кухня):** `http://localhost/admin-panel/kds.html`
- **Меню:** `http://localhost/admin-panel/menu.html`
- **Склад:** `http://localhost/admin-panel/inventory.html`
  - Вкладка "🏭 Производство"
  - Вкладка "📤 Опт и отгрузка"
- **Персонал:** `http://localhost/admin-panel/staff.html`
- **Программа лояльности:** `http://localhost/admin-panel/loyalty.html`
- **Аналитика:** `http://localhost/admin-panel/analytics.html`
- **📞 Звонки (Телефония):** `http://localhost/admin-panel/calls.html`
- **👤 Профиль пользователя:** `http://localhost/admin-panel/user-profile.html`
- **⚙️ Настройки:** `http://localhost/admin-panel/settings.html`
  - Вкладка "Общие"
  - Вкладка "Функционал"
  - Вкладка "👥 Роли и доступ" (НОВОЕ)
  - Вкладка "Настройки АТС"
  - Вкладка "Пользователи АТС"
  - Вкладка "Интеграции"

---

### 👨‍🍳 Kitchen Display System (KDS)
```
http://localhost/kds/
```
Экран для кухни

---

### 🚗 Панель доставки
```
http://localhost/delivery-dashboard/
```
Панель для курьеров

---

## API Endpoints

### 🔐 Аутентификация
```
POST   http://localhost/api/auth/login
POST   http://localhost/api/auth/logout
GET    http://localhost/api/auth/me
```

### 👥 Пользователи
```
GET    http://localhost/api/users
POST   http://localhost/api/users
GET    http://localhost/api/users/:id
PUT    http://localhost/api/users/:id
PUT    http://localhost/api/users/:id/sip
```

### 🍽️ Рестораны и меню
```
GET    http://localhost/api/restaurants
GET    http://localhost/api/menus
POST   http://localhost/api/menus
```

### 📦 Заказы
```
GET    http://localhost/api/orders
POST   http://localhost/api/orders
GET    http://localhost/api/orders/:id
PUT    http://localhost/api/orders/:id
DELETE http://localhost/api/orders/:id
```

### 📞 Телефония (Yeastar)
```
GET    http://localhost/api/calls/active
POST   http://localhost/api/calls/dial
POST   http://localhost/api/calls/hangup/:callId
GET    http://localhost/api/calls/history
GET    http://localhost/api/pbx/connection
POST   http://localhost/api/pbx/switch-transport
```

### 🚚 Доставка
```
GET    http://localhost/api/deliveries
POST   http://localhost/api/deliveries
GET    http://localhost/api/tracking/:orderId
```

### 👨‍🍳 Кухня
```
GET    http://localhost/api/kitchen/orders
PUT    http://localhost/api/kitchen/orders/:id/status
GET    http://localhost/api/printers
```

---

## Kong Admin API

### 🔧 Kong Administration
```
http://localhost:8001/
```
Kong Admin API (не для публичного доступа)

**Проверка конфигурации:**
```bash
# Список сервисов
curl http://localhost:8001/services

# Список роутов
curl http://localhost:8001/routes

# Статус Kong
curl http://localhost:8001/status
```

---

## Прямой доступ к микросервисам (внутри Docker)

⚠️ **Внимание:** Эти порты доступны только внутри Docker сети или через `docker exec`

| Сервис | Внутренний URL | Порт |
|--------|---------------|------|
| Frontend Service | http://frontend-service:3000 | 3000 |
| User Service | http://user-service:3001 | 3001 |
| Restaurant Service | http://restaurant-service:3002 | 3002 |
| Order Service | http://order-service:3003 | 3003 |
| Delivery Service | http://delivery-service:3004 | 3004 |
| Kitchen Service | http://kitchen-service:3005 | 3005 |
| Yeastar Service | http://yeastar-service:3008 | 3008 |
| PJSIP Service | http://pjsip-service:3009 | 3009 |

---

## Проверка работоспособности

### ✅ Быстрая проверка
```bash
# Проверка главной страницы
curl http://localhost/

# Проверка админ панели
curl http://localhost/admin-panel/

# Проверка API
curl http://localhost/api/orders

# Проверка Kong
curl http://localhost:8001/status
```

### ✅ Проверка всех сервисов
```bash
# Статус контейнеров
docker-compose ps

# Логи всех сервисов
docker-compose logs --tail=20

# Логи конкретного сервиса
docker-compose logs --tail=50 yeastar-service
```

---

## Тестовые данные

### 👤 Демо пользователь (для тестирования)
```javascript
{
  username: 'operator1',
  displayName: 'Оператор 1',
  role: 'operator',
  sip: {
    enabled: true,
    extension: '7779',
    password: '5TQNF_Srld',
    server: 'www.it005.ru',
    port: 5060,
    transport: 'UDP'
  }
}
```

### 📞 SIP данные для Yeastar
```
AMI Host: www.it005.ru
AMI Port: 5038
AMI Username: 1cuser
AMI Password: 1csecret

Локальный сервер (работает):
AMI Host: 192.168.5.150
AMI Port: 5038
```

---

## Устранение проблем

### ❌ Ошибка "Cannot GET /api/..."
**Причина:** Сервис не запущен или Kong не настроен

**Решение:**
```bash
# Перезапустить сервисы
docker-compose restart

# Проверить логи Kong
docker-compose logs kong

# Применить конфигурацию Kong
docker-compose restart kong
```

---

### ❌ Ошибка 404 на админ панели
**Причина:** Файлы не найдены

**Решение:**
```bash
# Проверить frontend-service
docker-compose logs frontend-service

# Перезапустить
docker-compose restart frontend-service
```

---

### ❌ CORS ошибки
**Причина:** CORS не настроен в Kong

**Решение:**
CORS уже настроен в `kong/kong.yml`:
```yaml
plugins:
  - name: cors
    config:
      origins: ["*"]
      credentials: true
```

---

### ❌ "The server is configured with a public base URL of /dashboard/"
**Причина:** Это ошибка от Kong Manager UI или другого приложения

**Решение:**
- Наш проект использует `/` и `/admin-panel/`
- `/dashboard/` не используется
- Это может быть из другого открытого приложения в браузере
- Или из Kong Manager (порт 8002, но он не открыт)

---

## Полезные команды

### 🔄 Перезапуск
```bash
# Все сервисы
docker-compose restart

# Конкретный сервис
docker-compose restart kong
docker-compose restart yeastar-service

# С пересборкой
docker-compose up -d --build
```

### 📊 Мониторинг
```bash
# Статус
docker-compose ps

# Логи в реальном времени
docker-compose logs -f

# Логи конкретного сервиса
docker-compose logs -f yeastar-service

# Использование ресурсов
docker stats
```

### 🧹 Очистка
```bash
# Остановить все
docker-compose down

# Остановить и удалить volumes
docker-compose down -v

# Полная очистка
docker-compose down -v --remove-orphans
docker system prune -a
```

---

## Порты

| Порт | Сервис | Описание |
|------|--------|----------|
| **80** | Kong Gateway | HTTP (главный вход) |
| **443** | Kong Gateway | HTTPS |
| 8001 | Kong Admin API | Управление Kong |
| 5432 | PostgreSQL | База данных |
| 6379 | Redis | Кеш |
| 5672 | RabbitMQ | Очередь сообщений |
| 15672 | RabbitMQ Management | Админка RabbitMQ |
| **5060/udp** | PJSIP | SIP (UDP) |
| **5700-5750/udp** | PJSIP | RTP (аудио) |

**Жирным** выделены порты, открытые наружу (0.0.0.0)

---

## 🚀 Быстрый старт

1. **Запустить проект:**
```bash
cd /Users/bagamedovyusup/work/food-flow
docker-compose up -d
```

2. **Дождаться запуска (30-60 сек):**
```bash
docker-compose ps
```

3. **Открыть в браузере:**
- Клиентское приложение: http://localhost/customer-app/
- Админ панель: http://localhost/admin-panel/

4. **Проверить телефонию:**
- Открыть: http://localhost/admin-panel/calls.html
- Или: http://localhost/admin-panel/user-profile.html

---

**Обновлено:** 2025-11-11
**Версия:** 1.1
