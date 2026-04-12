---
type: service
status: stable
last_verified: 2026-04-11
sources:
  - services/telegram-bot-service/
  - docs/IMPLEMENTED_FEATURES.md
---

# telegram-bot-service

Telegram-бот для приёма и обработки накладных от поставщиков.

- **Порт**: 3007
- **Хранилище**: **MongoDB** (не PostgreSQL! — единственный сервис с MongoDB; факт из `docs/IMPLEMENTED_FEATURES.md`). Сохраняет фото и метаданные накладных.

## Пайплайн обработки накладной

1. **Приём**: фото или документ (PDF/image) через Telegram.
2. **OCR**: Tesseract.js (русский + английский).
3. **Предобработка изображения**: Sharp — resize, greyscale, normalize, sharpen.
4. **Парсинг**: двухуровневый
   - **Первичный**: OpenAI GPT-4 (опционально, если включён ключ API) — извлекает поставщика, номер, дату, позиции товаров с количеством и ценами.
   - **Fallback**: regex-based парсинг.
5. **Загрузка в склад**: через [[services/inventory-service]] API
   - Создание прихода
   - Обновление остатков
   - Обновление цен закупки

## Команды бота
- `/start` — приветствие и инструкции
- `/help` — справка
- `/invoices` — список накладных
- `/get <id>` — просмотр конкретной накладной

## Контроль доступа
Только авторизованные пользователи (администратор/владелец). Механизм привязки — уточнить при следующем ingest-е (вероятно whitelist Telegram user_id или проверка против [[services/user-service]]).

## Зависимости (stack)
- Telegraf — Telegram Bot framework
- Tesseract.js — OCR
- Sharp — image processing
- OpenAI SDK — опциональный GPT-4 парсер

## Связи
- [[services/inventory-service]] — получатель распознанных позиций
- Это фактически UI-free канал ingress для склада параллельно админ-панели (`frontend/admin-panel/inventory.html`).
