-- ============================================================
-- Миграция 022: Взаиморасчёты с поставщиками
-- Долг поставщику, оплаты накладных, статус оплаты
-- ============================================================

-- Наш долг поставщику (положительный = мы должны)
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS balance DECIMAL(12, 2) NOT NULL DEFAULT 0;

ALTER TABLE supply_invoices ADD COLUMN IF NOT EXISTS paid_amount DECIMAL(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE supply_invoices ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid'
  CHECK (payment_status IN ('unpaid', 'partial', 'paid'));

-- Оплаты поставщикам (по накладной или погашение долга/аванс)
CREATE TABLE IF NOT EXISTS supplier_payments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id  UUID REFERENCES enterprises(id) ON DELETE SET NULL,
  supplier_id    UUID NOT NULL REFERENCES suppliers(id),
  invoice_id     UUID REFERENCES supply_invoices(id) ON DELETE SET NULL,
  amount         DECIMAL(12, 2) NOT NULL,
  method         VARCHAR(20) CHECK (method IN ('cash', 'transfer', 'card', 'offset')),
  register_id    UUID REFERENCES cash_registers(id) ON DELETE SET NULL,
  paid_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  notes          TEXT,
  created_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_supplier_payments_supplier ON supplier_payments(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_invoice ON supplier_payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_enterprise ON supplier_payments(enterprise_id);

-- Бэкфилл: долг по уже принятым накладным
UPDATE suppliers s
SET balance = COALESCE((
  SELECT SUM(si.total_amount) FROM supply_invoices si
  WHERE si.supplier_id = s.id AND si.status = 'received'
), 0);
