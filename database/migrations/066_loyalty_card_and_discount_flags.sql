-- ============================================================
-- Миграция 066: два разрешения скидок у блюда и карта клиента
-- ============================================================
-- 1. Вместо одной галочки «Без скидки» (065, menu_items.no_discount) —
--    два независимых разрешения:
--      loyalty_discount_allowed — действует ли скидка по карте лояльности;
--      promo_discount_allowed   — действуют ли акции (discounts).
--    Позиции, помеченные «без скидки», переносятся как «обе запрещены».
--    no_discount больше не читается кодом; колонка остаётся, пока на
--    кассах могут работать сборки, которые её читают.
-- 2. Карта клиента для веб-страницы по ссылке:
--      card_number — номер карты для кассира (печатается в QR, ищется в
--                    поиске клиента); 8 цифр из общей последовательности;
--      card_token  — секрет ссылки /card/?t=…: 64 hex-символа из двух
--                    gen_random_uuid (≈244 бита случайности). Номер карты
--                    в ссылке не используется — по номеру чужую карту не
--                    открыть.
-- Новые профили получают оба значения по умолчанию. Идемпотентна.

ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS loyalty_discount_allowed BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS promo_discount_allowed   BOOLEAN NOT NULL DEFAULT true;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'menu_items' AND column_name = 'no_discount') THEN
    UPDATE menu_items
       SET loyalty_discount_allowed = false, promo_discount_allowed = false, no_discount = false
     WHERE no_discount = true;
  END IF;
END $$;

CREATE SEQUENCE IF NOT EXISTS loyalty_card_number_seq START WITH 10000001 MINVALUE 10000001 MAXVALUE 99999999;

ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS card_number VARCHAR(12);
ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS card_token  VARCHAR(64);

UPDATE customer_profiles SET card_number = nextval('loyalty_card_number_seq')::text WHERE card_number IS NULL;
UPDATE customer_profiles
   SET card_token = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
 WHERE card_token IS NULL;

ALTER TABLE customer_profiles ALTER COLUMN card_number SET DEFAULT nextval('loyalty_card_number_seq')::text;
ALTER TABLE customer_profiles ALTER COLUMN card_token  SET DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
ALTER TABLE customer_profiles ALTER COLUMN card_number SET NOT NULL;
ALTER TABLE customer_profiles ALTER COLUMN card_token  SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_profiles_card_number ON customer_profiles (card_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_profiles_card_token  ON customer_profiles (card_token);
