-- ============================================================
-- Миграция 067: карта гостя в Apple Wallet
-- ============================================================
-- Файл карты (.pkpass) подписывается сертификатом Pass Type ID организации-
-- эмитента (FoodFlow). Телефон с картой регистрируется в нашем сервисе
-- обновлений и после начисления баллов получает от Apple push, по которому
-- сам забирает новую версию карты.
--
-- * wallet_auth_token — секрет, который Apple кладёт в карту и присылает
--   обратно в заголовке «Authorization: ApplePass …». Отдельный от
--   card_token: утечка одного не открывает другое.
-- * wallet_updated_at — когда менялось то, что видно на карте. Ставит сама
--   база триггером, поэтому любое начисление — через API, событие заказа
--   или ручную правку — попадает в обновление карты без правок в коде.
-- * wallet_pushed_at — до какого изменения push уже разослан.
-- * wallet_registrations — телефоны, на которых лежит карта.
-- Идемпотентна.

ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS wallet_auth_token VARCHAR(64);
UPDATE customer_profiles
   SET wallet_auth_token = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
 WHERE wallet_auth_token IS NULL;
ALTER TABLE customer_profiles ALTER COLUMN wallet_auth_token SET DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
ALTER TABLE customer_profiles ALTER COLUMN wallet_auth_token SET NOT NULL;

ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS wallet_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS wallet_pushed_at  TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION customer_profiles_wallet_touch() RETURNS trigger AS $$
BEGIN
  -- Только то, что видно на карте: баллы, уровень, ссылка на страницу карты
  IF NEW.loyalty_points IS DISTINCT FROM OLD.loyalty_points
     OR NEW.loyalty_tier IS DISTINCT FROM OLD.loyalty_tier
     OR NEW.total_spent IS DISTINCT FROM OLD.total_spent
     OR NEW.card_token IS DISTINCT FROM OLD.card_token THEN
    -- clock_timestamp, а не now(): now() — время начала транзакции, и два
    -- изменения в одной транзакции дали бы одну метку, второе не ушло бы в push
    NEW.wallet_updated_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_customer_profiles_wallet_touch ON customer_profiles;
CREATE TRIGGER trg_customer_profiles_wallet_touch
  BEFORE UPDATE ON customer_profiles
  FOR EACH ROW EXECUTE FUNCTION customer_profiles_wallet_touch();

CREATE TABLE IF NOT EXISTS wallet_registrations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_library_id   VARCHAR(128) NOT NULL,
  push_token          VARCHAR(256) NOT NULL,
  pass_type_id        VARCHAR(255) NOT NULL,
  serial_number       VARCHAR(64)  NOT NULL,
  customer_profile_id UUID NOT NULL REFERENCES customer_profiles(id) ON DELETE CASCADE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (device_library_id, pass_type_id, serial_number)
);
CREATE INDEX IF NOT EXISTS idx_wallet_registrations_profile ON wallet_registrations (customer_profile_id);
