-- ============================================================
-- Миграция 021: Telegram-бот водителей
-- Привязка Telegram-аккаунта к пользователю
-- ============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_chat_id ON users(telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;

-- Отметка уведомления водителя о назначении на отгрузку
ALTER TABLE wholesale_orders ADD COLUMN IF NOT EXISTS driver_notified_at TIMESTAMP WITH TIME ZONE;
