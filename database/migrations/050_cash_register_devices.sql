-- ============================================================
-- Миграция 050: планшеты, привязанные к кассе (вход кассира по PIN)
-- ============================================================
-- Кассир входит на планшете одним PIN, без логина и пароля. Четыре цифры
-- перебираются за минуты, поэтому PIN принимается только с устройства,
-- которое владелец заранее привязал к кассе: планшет хранит случайный токен,
-- в базе лежит только его sha256. Неверные PIN считаются по устройству,
-- после серии ошибок устройство временно блокируется.

CREATE TABLE IF NOT EXISTS cash_register_devices (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    enterprise_id    UUID NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
    register_id      UUID NOT NULL REFERENCES cash_registers(id) ON DELETE CASCADE,
    name             VARCHAR(100) NOT NULL DEFAULT 'Планшет',
    token_hash       VARCHAR(64) NOT NULL UNIQUE,
    created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    failed_attempts  INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    locked_until     TIMESTAMP WITH TIME ZONE,
    last_used_at     TIMESTAMP WITH TIME ZONE,
    revoked_at       TIMESTAMP WITH TIME ZONE,
    created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cash_register_devices_enterprise
    ON cash_register_devices(enterprise_id) WHERE revoked_at IS NULL;

COMMENT ON TABLE cash_register_devices IS
    'Планшеты режима кассы: только с привязанного устройства кассир входит по PIN';
