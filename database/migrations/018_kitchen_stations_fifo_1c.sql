-- Migration 018: Kitchen Stations, FIFO Inventory Batches, 1C Export Log
-- Phase D growth features

-- ============================================================
-- 1. KITCHEN STATIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS kitchen_stations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  enterprise_id   UUID REFERENCES enterprises(id) ON DELETE SET NULL,
  name            VARCHAR(100) NOT NULL,
  station_type    VARCHAR(50) DEFAULT 'general',
  display_order   INTEGER DEFAULT 0,
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kitchen_stations_restaurant
  ON kitchen_stations(restaurant_id, is_active);

-- Link menu items to stations (many-to-many: one dish may go through multiple stations)
CREATE TABLE IF NOT EXISTS menu_item_stations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_item_id    UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  station_id      UUID NOT NULL REFERENCES kitchen_stations(id) ON DELETE CASCADE,
  preparation_order INTEGER DEFAULT 1,
  UNIQUE(menu_item_id, station_id)
);

CREATE INDEX IF NOT EXISTS idx_menu_item_stations_item ON menu_item_stations(menu_item_id);
CREATE INDEX IF NOT EXISTS idx_menu_item_stations_station ON menu_item_stations(station_id);

-- Track per-item-per-station status in orders
CREATE TABLE IF NOT EXISTS order_item_station_status (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id   UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  station_id      UUID NOT NULL REFERENCES kitchen_stations(id) ON DELETE CASCADE,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'in_progress', 'done', 'recalled')),
  started_at      TIMESTAMP WITH TIME ZONE,
  completed_at    TIMESTAMP WITH TIME ZONE,
  cook_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(order_item_id, station_id)
);

CREATE INDEX IF NOT EXISTS idx_oiss_station_status
  ON order_item_station_status(station_id, status);

-- ============================================================
-- 2. FIFO INVENTORY BATCHES
-- ============================================================

CREATE TABLE IF NOT EXISTS inventory_batches (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  warehouse_id      UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  enterprise_id     UUID REFERENCES enterprises(id) ON DELETE SET NULL,
  batch_number      VARCHAR(100),
  quantity          DECIMAL(12, 4) NOT NULL,
  cost_price        DECIMAL(12, 2),
  received_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expiry_date       DATE,
  supplier_id       UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  invoice_id        UUID REFERENCES supply_invoices(id) ON DELETE SET NULL,
  is_depleted       BOOLEAN DEFAULT false,
  created_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inventory_batches_item_warehouse
  ON inventory_batches(inventory_item_id, warehouse_id, is_depleted);

CREATE INDEX IF NOT EXISTS idx_inventory_batches_expiry
  ON inventory_batches(expiry_date) WHERE expiry_date IS NOT NULL AND is_depleted = false;

-- ============================================================
-- 3. 1C EXPORT LOG
-- ============================================================

CREATE TABLE IF NOT EXISTS export_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id   UUID REFERENCES enterprises(id) ON DELETE SET NULL,
  export_type     VARCHAR(50) NOT NULL,
  period_start    DATE NOT NULL,
  period_end      DATE NOT NULL,
  status          VARCHAR(20) DEFAULT 'completed',
  records_count   INTEGER DEFAULT 0,
  file_url        VARCHAR(500),
  exported_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_export_log_enterprise
  ON export_log(enterprise_id, export_type, created_at DESC);
