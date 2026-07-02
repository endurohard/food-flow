# Driver Bot Service

Telegram-бот для водителей доставки оптовой системы (порт **3015**).

## Возможности

- Авторизация водителя по номеру телефона (кнопка «Отправить контакт», привязка `users.telegram_chat_id`)
- 🚚 **Мои доставки** — заказы со статусом `shipped`, назначенные водителю, карточками с составом
- ✅ **Доставлено** — перевод заказа в `delivered`
- 💰 **Оплата** — приём наличных (`POST /orders/:id/pay`, `method: cash`, водитель = `received_by`)
- ↩️ **Возврат** — оформление возврата по позициям (на склад / списание, мультипозиционный), create + confirm, водитель = `processed_by`
- 📊 **Мой день** — доставлено заказов, наличных собрано, возвратов принято за сегодня
- Поллер уведомлений: каждые `POLL_INTERVAL_MS` находит отгруженные заказы с `driver_notified_at IS NULL` и шлёт водителю уведомление с кнопками

## Архитектура

- Привязка чатов и статистика — напрямую в Postgres (`DATABASE_URL`, pg Pool)
- Бизнес-действия — через HTTP API wholesale-service c межсервисной авторизацией:
  `X-Internal-Token`, `X-User-Id` (uuid водителя), `X-Enterprise-Id` (если есть)

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `DRIVER_BOT_TOKEN` | — | Токен бота; если пуст — бот выключен, работает только `/health` |
| `DATABASE_URL` | `postgresql://foodflow:foodflow@localhost:5432/foodflow` | Postgres |
| `WHOLESALE_SERVICE_URL` | `http://wholesale-service:3013` | API оптовой системы |
| `INTERNAL_TOKEN` | — | Секрет межсервисной авторизации |
| `POLL_INTERVAL_MS` | `30000` | Интервал поллера уведомлений |
| `PORT` | `3015` | HTTP-порт `/health` |

## Запуск

```bash
npm install
npm run build
npm start       # или npm run dev
```
