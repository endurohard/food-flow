-- ============================================================
-- Миграция 035: тип заведения «Доставка»
-- Кухня без зала: заказы с сайта, телефона и агрегаторов, курьеры.
-- ============================================================

ALTER TABLE enterprises DROP CONSTRAINT IF EXISTS enterprises_business_type_check;

ALTER TABLE enterprises ADD CONSTRAINT enterprises_business_type_check
  CHECK (business_type IN ('restaurant', 'cafe', 'coffee_shop', 'delivery', 'production'));
