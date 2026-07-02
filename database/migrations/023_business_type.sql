-- ============================================================
-- Миграция 023: Тип заведения (функционал предприятия)
-- ресторан / кафе / кофейня / производство
-- ============================================================

ALTER TABLE enterprises ADD COLUMN IF NOT EXISTS business_type VARCHAR(20) NOT NULL DEFAULT 'restaurant'
  CHECK (business_type IN ('restaurant', 'cafe', 'coffee_shop', 'production'));
