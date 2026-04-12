-- Migration 017: Split Bill, Discounts, Stop-list, Reservations
-- Phase C MVP features

-- ============================================================
-- 1. SPLIT BILL
-- ============================================================

CREATE TABLE IF NOT EXISTS order_splits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  child_order_id  UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  split_type      VARCHAR(20) NOT NULL DEFAULT 'by_items' CHECK (split_type IN ('by_items', 'equal', 'custom')),
  amount          DECIMAL(12, 2) NOT NULL,
  paid            BOOLEAN DEFAULT false,
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_splits_parent ON order_splits(parent_order_id);
CREATE INDEX IF NOT EXISTS idx_order_splits_child ON order_splits(child_order_id);

-- ============================================================
-- 2. DISCOUNT RULES
-- ============================================================

CREATE TABLE IF NOT EXISTS discounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id   UUID REFERENCES enterprises(id) ON DELETE CASCADE,
  restaurant_id   UUID REFERENCES restaurants(id) ON DELETE SET NULL,
  name            VARCHAR(255) NOT NULL,
  discount_type   VARCHAR(30) NOT NULL CHECK (discount_type IN ('percentage', 'fixed_amount', 'bogo', 'combo')),
  value           DECIMAL(12, 2) NOT NULL,
  min_order_amount DECIMAL(12, 2) DEFAULT 0,
  max_discount     DECIMAL(12, 2),
  applicable_to   VARCHAR(30) DEFAULT 'order' CHECK (applicable_to IN ('order', 'item', 'category')),
  target_id       UUID,
  is_active       BOOLEAN DEFAULT true,
  valid_from      TIMESTAMP WITH TIME ZONE,
  valid_until     TIMESTAMP WITH TIME ZONE,
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discounts_enterprise ON discounts(enterprise_id, is_active);
CREATE INDEX IF NOT EXISTS idx_discounts_restaurant ON discounts(restaurant_id, is_active);

-- Track which discounts were applied to an order
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount DECIMAL(12, 2) DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS applied_discounts JSONB DEFAULT '[]';

-- ============================================================
-- 3. STOP-LIST (extend menu_items)
-- ============================================================

ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS stop_reason VARCHAR(255);
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS stopped_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS stop_until TIMESTAMP WITH TIME ZONE;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS stopped_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- ============================================================
-- 4. RESERVATIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS reservations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  enterprise_id   UUID REFERENCES enterprises(id) ON DELETE SET NULL,
  table_id        UUID REFERENCES restaurant_tables(id) ON DELETE SET NULL,
  customer_name   VARCHAR(255) NOT NULL,
  customer_phone  VARCHAR(20) NOT NULL,
  customer_email  VARCHAR(255),
  party_size      INTEGER NOT NULL DEFAULT 2,
  reservation_date DATE NOT NULL,
  reservation_time TIME NOT NULL,
  duration_minutes INTEGER DEFAULT 120,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show')),
  deposit_amount  DECIMAL(12, 2) DEFAULT 0,
  deposit_paid    BOOLEAN DEFAULT false,
  notes           TEXT,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reservations_restaurant_date
  ON reservations(restaurant_id, reservation_date, reservation_time);

CREATE INDEX IF NOT EXISTS idx_reservations_enterprise
  ON reservations(enterprise_id, reservation_date);

CREATE INDEX IF NOT EXISTS idx_reservations_phone
  ON reservations(customer_phone);

CREATE TRIGGER trigger_reservations_updated_at
  BEFORE UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
