-- ============================================================
-- Миграция 052: Telegram-бот организации и уведомления «пора заказать»
-- ============================================================
-- Владелец подключает своего бота в «Настройки → Интеграции» (токен от
-- @BotFather). Владелец и админы привязывают к нему свой Telegram по ссылке
-- t.me/<бот>?start=<код>. Когда остаток позиции на складе опускается до
-- минимального (inventory_items.min_stock), открывается предупреждение:
-- колокольчик в админке и сообщение в Telegram. Пока остаток не пополнен,
-- предупреждение одно — повторно о том же не пишем.

CREATE TABLE IF NOT EXISTS enterprise_telegram_bots (
    enterprise_id   UUID PRIMARY KEY REFERENCES enterprises(id) ON DELETE CASCADE,
    -- Токен шифруется ENCRYPTION_KEY user-service (enc:v1:…), наружу не отдаётся
    bot_token       TEXT NOT NULL,
    bot_username    VARCHAR(64) NOT NULL,
    bot_name        VARCHAR(128),
    -- Смещение getUpdates: обработанные /start больше не перечитываются
    updates_offset  BIGINT NOT NULL DEFAULT 0,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS enterprise_telegram_recipients (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    enterprise_id     UUID NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id           BIGINT,
    telegram_username VARCHAR(64),
    link_code         VARCHAR(40),
    link_expires_at   TIMESTAMPTZ,
    linked_at         TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (enterprise_id, user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_telegram_link_code
    ON enterprise_telegram_recipients (link_code) WHERE link_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS stock_alerts (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    enterprise_id      UUID NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
    warehouse_id       UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    inventory_item_id  UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    quantity           DECIMAL(12, 3) NOT NULL,
    min_stock          DECIMAL(12, 3) NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at        TIMESTAMPTZ,
    telegram_sent_at   TIMESTAMPTZ,
    telegram_attempts  INT NOT NULL DEFAULT 0,
    telegram_error     TEXT
);
-- Одно открытое предупреждение на позицию склада: без спама при каждой продаже
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_alerts_open
    ON stock_alerts (warehouse_id, inventory_item_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_stock_alerts_enterprise_open
    ON stock_alerts (enterprise_id) WHERE resolved_at IS NULL;
