-- ============================================================
-- Миграция 058: общий Telegram-бот платформы
-- ============================================================
-- Супер-админ подключает один бот FoodFlow на всю платформу. Организация,
-- у которой нет своего бота, шлёт «пора заказать» через него; свой бот,
-- если подключён, главнее. Токен шифруется ENCRYPTION_KEY user-service.
--
-- Чат в Telegram получает сообщения только от бота, которому человек нажал
-- «Start». Поэтому у привязки получателя запоминаем, через какого бота она
-- сделана (bot_username): при смене бота организации старые привязки
-- не годятся, но и не стираются — вернули бота, вернулись и привязки.

CREATE TABLE IF NOT EXISTS platform_telegram_bot (
    id              BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),  -- ровно одна строка
    bot_token       TEXT NOT NULL,
    bot_username    VARCHAR(64) NOT NULL,
    bot_name        VARCHAR(128),
    -- getUpdates общего бота читается один раз на всю платформу
    updates_offset  BIGINT NOT NULL DEFAULT 0,
    updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE enterprise_telegram_recipients
    ADD COLUMN IF NOT EXISTS bot_username VARCHAR(64);

-- Существующие привязки сделаны через бота своей организации
UPDATE enterprise_telegram_recipients r
   SET bot_username = b.bot_username
  FROM enterprise_telegram_bots b
 WHERE b.enterprise_id = r.enterprise_id
   AND r.chat_id IS NOT NULL AND r.bot_username IS NULL;
