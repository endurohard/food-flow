-- ============================================================
-- Миграция 049: сессии режима кассы (PIN-блокировка)
-- ============================================================
-- Одна сессия = вход кассира в режим кассы после ввода PIN.
-- Статус 'active' — продажи разрешены, 'locked' — касса в режиме
-- ожидания ввода PIN, продажи отключены.

CREATE TABLE IF NOT EXISTS cash_register_sessions (
    id            UUID PRIMARY KEY,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    register_id   UUID NOT NULL REFERENCES cash_registers(id) ON DELETE RESTRICT,
    status        VARCHAR(20) NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'locked')),
    locked_at     TIMESTAMP WITH TIME ZONE,
    expires_at    TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cash_register_sessions_user
    ON cash_register_sessions(user_id);
