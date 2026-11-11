-- ============================================================
-- Миграция 063: инвентаризация (пересчёт склада)
-- ============================================================
-- Раньше расхождение можно было внести только «Корректировкой ±» по
-- одному товару, и итог «недостача на N ₽» нигде не сохранялся.
--
-- Документ инвентаризации: черновик (вводим факт, можно в несколько
-- заходов) → проведён. При проведении расхождение считается от остатка
-- на момент проведения — продажи во время пересчёта не дают ложной
-- недостачи — и пишется корректировками склада со ссылкой на документ.

CREATE TABLE IF NOT EXISTS inventory_counts (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    enterprise_id  UUID NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
    warehouse_id   UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    count_number   VARCHAR(40) NOT NULL,
    status         VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'cancelled')),
    category       VARCHAR(100),
    notes          TEXT,
    created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    posted_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    posted_at      TIMESTAMPTZ,
    -- итоги на момент проведения
    shortage_value DECIMAL(14, 2),
    surplus_value  DECIMAL(14, 2),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (enterprise_id, count_number)
);
CREATE INDEX IF NOT EXISTS idx_inventory_counts_enterprise ON inventory_counts (enterprise_id, created_at DESC);

CREATE TABLE IF NOT EXISTS inventory_count_items (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    count_id           UUID NOT NULL REFERENCES inventory_counts(id) ON DELETE CASCADE,
    inventory_item_id  UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    counted_qty        DECIMAL(12, 3) CHECK (counted_qty IS NULL OR counted_qty >= 0),
    -- заполняются при проведении
    expected_qty       DECIMAL(12, 3),
    diff_qty           DECIMAL(12, 3),
    unit_cost          DECIMAL(12, 4),
    diff_value         DECIMAL(14, 2),
    counted_at         TIMESTAMPTZ,
    UNIQUE (count_id, inventory_item_id)
);

CREATE TABLE IF NOT EXISTS inventory_count_number_seq (
    enterprise_id UUID NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
    year          INTEGER NOT NULL,
    last_number   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (enterprise_id, year)
);

CREATE OR REPLACE FUNCTION next_inventory_count_number(p_enterprise UUID)
RETURNS TEXT AS $$
DECLARE
  y INTEGER := EXTRACT(YEAR FROM CURRENT_DATE);
  n INTEGER;
BEGIN
  INSERT INTO inventory_count_number_seq (enterprise_id, year, last_number)
  VALUES (p_enterprise, y, 0)
  ON CONFLICT (enterprise_id, year) DO NOTHING;

  UPDATE inventory_count_number_seq SET last_number = last_number + 1
   WHERE enterprise_id = p_enterprise AND year = y
  RETURNING last_number INTO n;

  RETURN 'ИН-' || y || '-' || lpad(n::text, 5, '0');
END;
$$ LANGUAGE plpgsql;
