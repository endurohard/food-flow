-- ============================================================
-- Миграция 069: возврат поставщику
-- ============================================================
-- Привезли брак, пересорт или лишнее, а накладная уже принята: товар можно
-- только списать в убыток, долг поставщику при этом не уменьшался.
--
-- Возврат — документ по принятой накладной: товар уходит со склада
-- (сначала из партий этой накладной), долг поставщику и долг по накладной
-- уменьшаются на сумму возврата по цене накладной.

ALTER TABLE supply_invoices ADD COLUMN IF NOT EXISTS returned_amount DECIMAL(12, 2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS supplier_returns (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    enterprise_id  UUID NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
    supplier_id    UUID REFERENCES suppliers(id) ON DELETE SET NULL,
    invoice_id     UUID NOT NULL REFERENCES supply_invoices(id) ON DELETE CASCADE,
    warehouse_id   UUID REFERENCES warehouses(id) ON DELETE SET NULL,
    return_number  VARCHAR(40) NOT NULL,
    total_amount   DECIMAL(12, 2) NOT NULL DEFAULT 0,
    reason         VARCHAR(40),
    notes          TEXT,
    created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (enterprise_id, return_number)
);
CREATE INDEX IF NOT EXISTS idx_supplier_returns_invoice ON supplier_returns (invoice_id);
CREATE INDEX IF NOT EXISTS idx_supplier_returns_supplier ON supplier_returns (supplier_id, created_at);

CREATE TABLE IF NOT EXISTS supplier_return_items (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    return_id          UUID NOT NULL REFERENCES supplier_returns(id) ON DELETE CASCADE,
    invoice_item_id    UUID REFERENCES supply_invoice_items(id) ON DELETE SET NULL,
    inventory_item_id  UUID REFERENCES inventory_items(id) ON DELETE SET NULL,
    name               VARCHAR(255),
    quantity           DECIMAL(12, 3) NOT NULL CHECK (quantity > 0),
    price              DECIMAL(12, 4) NOT NULL DEFAULT 0,
    total              DECIMAL(12, 2) NOT NULL DEFAULT 0,
    -- себестоимость ушедшего со склада (по партиям) — для отчётов
    stock_cost         DECIMAL(12, 2)
);
CREATE INDEX IF NOT EXISTS idx_supplier_return_items_invoice_item ON supplier_return_items (invoice_item_id);

CREATE TABLE IF NOT EXISTS supplier_return_number_seq (
    enterprise_id UUID NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
    year          INTEGER NOT NULL,
    last_number   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (enterprise_id, year)
);

CREATE OR REPLACE FUNCTION next_supplier_return_number(p_enterprise UUID)
RETURNS TEXT AS $$
DECLARE
  y INTEGER := EXTRACT(YEAR FROM CURRENT_DATE);
  n INTEGER;
BEGIN
  INSERT INTO supplier_return_number_seq (enterprise_id, year, last_number)
  VALUES (p_enterprise, y, 0)
  ON CONFLICT (enterprise_id, year) DO NOTHING;
  UPDATE supplier_return_number_seq SET last_number = last_number + 1
   WHERE enterprise_id = p_enterprise AND year = y
  RETURNING last_number INTO n;
  RETURN 'ВЗ-' || y || '-' || lpad(n::text, 5, '0');
END;
$$ LANGUAGE plpgsql;

-- Статус оплаты считается от суммы к оплате: накладная минус возвраты
CREATE OR REPLACE FUNCTION recalc_invoice_payment() RETURNS TRIGGER AS $$
DECLARE
  inv UUID := COALESCE(NEW.invoice_id, OLD.invoice_id);
BEGIN
  IF inv IS NULL THEN RETURN NULL; END IF;
  UPDATE supply_invoices i
     SET paid_amount = COALESCE((SELECT sum(p.amount) FROM supplier_payments p WHERE p.invoice_id = inv), 0),
         payment_status = CASE
           WHEN COALESCE((SELECT sum(p.amount) FROM supplier_payments p WHERE p.invoice_id = inv), 0) <= 0 THEN 'unpaid'
           WHEN COALESCE((SELECT sum(p.amount) FROM supplier_payments p WHERE p.invoice_id = inv), 0)
                >= COALESCE(i.total_amount, 0) - COALESCE(i.returned_amount, 0) - 0.005 THEN 'paid'
           ELSE 'partial' END,
         updated_at = NOW()
   WHERE i.id = inv;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE VIEW v_supplier_debts AS
SELECT i.enterprise_id,
       i.supplier_id,
       s.name AS supplier_name,
       i.id AS invoice_id,
       i.invoice_number,
       i.invoice_date,
       i.status,
       COALESCE(i.total_amount, 0) AS total_amount,
       i.paid_amount,
       COALESCE(i.total_amount, 0) - COALESCE(i.returned_amount, 0) - i.paid_amount AS debt,
       i.payment_status
  FROM supply_invoices i
  LEFT JOIN suppliers s ON s.id = i.supplier_id
 WHERE i.status = 'received';
