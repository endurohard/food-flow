-- ============================================================
-- Миграция 060: заказы поставщикам
-- ============================================================
-- Раньше закупка начиналась сразу с накладной: что заказали — нигде не
-- записывалось, и сверить «заказали 10 кг — привезли 8» было не с чем.
--
-- Заказ: черновик → отправлен → частично получен / получен (или отменён).
-- По заказу создаётся черновик накладной с остатком к получению; при
-- приёмке накладной полученное количество записывается в заказ, и статус
-- пересчитывается сам.

CREATE TABLE IF NOT EXISTS purchase_orders (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    enterprise_id  UUID NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
    supplier_id    UUID REFERENCES suppliers(id) ON DELETE SET NULL,
    warehouse_id   UUID REFERENCES warehouses(id) ON DELETE SET NULL,
    order_number   VARCHAR(40) NOT NULL,
    status         VARCHAR(20) NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'sent', 'partially_received', 'received', 'cancelled')),
    expected_date  DATE,
    notes          TEXT,
    created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    sent_at        TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (enterprise_id, order_number)
);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_enterprise_status ON purchase_orders (enterprise_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS purchase_order_items (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id           UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    inventory_item_id  UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    quantity           DECIMAL(12, 3) NOT NULL CHECK (quantity > 0),
    price_per_unit     DECIMAL(12, 2),
    received_quantity  DECIMAL(12, 3) NOT NULL DEFAULT 0,
    UNIQUE (order_id, inventory_item_id)
);

ALTER TABLE supply_invoices ADD COLUMN IF NOT EXISTS purchase_order_id UUID REFERENCES purchase_orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_supply_invoices_purchase_order ON supply_invoices (purchase_order_id) WHERE purchase_order_id IS NOT NULL;

-- Номер заказа ЗК-2026-00001 — так же, как номер накладной (041):
-- счётчик под блокировкой строки, два заказа не получат один номер.
CREATE TABLE IF NOT EXISTS purchase_order_number_seq (
    enterprise_id UUID NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
    year          INTEGER NOT NULL,
    last_number   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (enterprise_id, year)
);

CREATE OR REPLACE FUNCTION next_purchase_order_number(p_enterprise UUID)
RETURNS TEXT AS $$
DECLARE
  y INTEGER := EXTRACT(YEAR FROM CURRENT_DATE);
  n INTEGER;
BEGIN
  INSERT INTO purchase_order_number_seq (enterprise_id, year, last_number)
  VALUES (p_enterprise, y, 0)
  ON CONFLICT (enterprise_id, year) DO NOTHING;

  UPDATE purchase_order_number_seq SET last_number = last_number + 1
   WHERE enterprise_id = p_enterprise AND year = y
  RETURNING last_number INTO n;

  RETURN 'ЗК-' || y || '-' || lpad(n::text, 5, '0');
END;
$$ LANGUAGE plpgsql;
