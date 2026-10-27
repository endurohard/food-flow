-- 039: интеграция с ВАТС (коннектор «Простых звонков») на предприятие.
-- Организация в ВАТС одна на предприятие, точек у него может быть несколько,
-- поэтому настройки живут на enterprises, а не на restaurants.

ALTER TABLE enterprises ADD COLUMN IF NOT EXISTS vats_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE enterprises ADD COLUMN IF NOT EXISTS vats_host VARCHAR(255);
ALTER TABLE enterprises ADD COLUMN IF NOT EXISTS vats_password TEXT;
ALTER TABLE enterprises ADD COLUMN IF NOT EXISTS vats_client_type VARCHAR(50) NOT NULL DEFAULT 'foodflow';
ALTER TABLE enterprises ADD COLUMN IF NOT EXISTS vats_protocol_version SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE enterprises ADD COLUMN IF NOT EXISTS vats_last_connected_at TIMESTAMPTZ;
ALTER TABLE enterprises ADD COLUMN IF NOT EXISTS vats_last_error TEXT;

-- Включать интеграцию без адреса и пароля бессмысленно: клиент встанет в
-- бесконечный реконнект, а в журнале будет «нет настроек».
ALTER TABLE enterprises DROP CONSTRAINT IF EXISTS enterprises_vats_enabled_needs_creds;
ALTER TABLE enterprises ADD CONSTRAINT enterprises_vats_enabled_needs_creds
  CHECK (NOT vats_enabled OR (vats_host IS NOT NULL AND vats_host <> ''
                              AND vats_password IS NOT NULL AND vats_password <> ''));

-- Внутренний номер оператора уже есть (users.pbx_extension, миграция 005).
-- Нормализованный телефон: ВАТС отдаёт только цифры (79991234567), а в
-- users.phone формат произвольный (+7 (999) 123-45-67). Без нормализации
-- поиск клиента по входящему звонку не находит никого.
CREATE OR REPLACE FUNCTION normalize_phone(p TEXT) RETURNS TEXT AS $$
  SELECT CASE
    WHEN p IS NULL THEN NULL
    -- 8XXXXXXXXXX и 7XXXXXXXXXX приводим к 7XXXXXXXXXX, 10 цифр — дописываем 7
    WHEN length(regexp_replace(p, '\D', '', 'g')) = 11
      THEN '7' || right(regexp_replace(p, '\D', '', 'g'), 10)
    WHEN length(regexp_replace(p, '\D', '', 'g')) = 10
      THEN '7' || regexp_replace(p, '\D', '', 'g')
    ELSE regexp_replace(p, '\D', '', 'g')
  END;
$$ LANGUAGE sql IMMUTABLE;

CREATE INDEX IF NOT EXISTS idx_users_phone_normalized
  ON users (normalize_phone(phone)) WHERE phone IS NOT NULL;

-- Журнал звонков. Нужен не «на будущее», а прямо сейчас: карточку входящего
-- строим по истории заказов, а дедупликацию событий — по call_id.
CREATE TABLE IF NOT EXISTS vats_calls (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id   UUID NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
  call_id         VARCHAR(128) NOT NULL,
  direction       VARCHAR(10)  NOT NULL CHECK (direction IN ('in', 'out')),
  caller          VARCHAR(32),
  callee          VARCHAR(32),
  extension       VARCHAR(20),
  matched_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'ringing'
                  CHECK (status IN ('ringing', 'answered', 'finished', 'missed')),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at     TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  duration_sec    INTEGER,
  recording_url   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Один звонок = одна запись на предприятие. ВАТС присылает ringing столько
-- раз, сколько у номера живых SIP-регистраций (телефон + софтфон), и без
-- этого ограничения журнал и карточки задвоятся.
CREATE UNIQUE INDEX IF NOT EXISTS idx_vats_calls_unique
  ON vats_calls (enterprise_id, call_id);
CREATE INDEX IF NOT EXISTS idx_vats_calls_recent
  ON vats_calls (enterprise_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_vats_calls_caller
  ON vats_calls (enterprise_id, caller);
