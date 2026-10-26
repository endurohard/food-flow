-- 041: номер накладной — обязательный и уникальный в рамках поставщика.
--
-- Без этого невозможно то, ради чего накладные и ведутся: сопоставлять
-- долги. Одна и та же бумага, занесённая дважды, удваивала бы долг
-- поставщику, а накладная без номера не сверяется с его реестром вообще.

-- Уникальность в рамках (предприятие, поставщик): у разных поставщиков
-- номера свободно совпадают, это их собственная нумерация.
CREATE UNIQUE INDEX IF NOT EXISTS idx_supply_invoices_number_unique
  ON supply_invoices (enterprise_id, supplier_id, invoice_number)
  WHERE invoice_number IS NOT NULL AND supplier_id IS NOT NULL;

-- Счётчик для автогенерации номера, когда у накладной нет своего
-- (закупка без документа, внутреннее оприходование).
CREATE TABLE IF NOT EXISTS invoice_number_seq (
  enterprise_id UUID NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
  year          INTEGER NOT NULL,
  last_number   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (enterprise_id, year)
);

-- Выдача следующего номера вида ПР-2026-00001.
-- UPDATE ... RETURNING под блокировкой строки: два одновременных приёма
-- накладных не получат один номер.
CREATE OR REPLACE FUNCTION next_invoice_number(p_enterprise UUID)
RETURNS TEXT AS $$
DECLARE
  y INTEGER := EXTRACT(YEAR FROM CURRENT_DATE);
  n INTEGER;
BEGIN
  INSERT INTO invoice_number_seq (enterprise_id, year, last_number)
  VALUES (p_enterprise, y, 0)
  ON CONFLICT (enterprise_id, year) DO NOTHING;

  UPDATE invoice_number_seq SET last_number = last_number + 1
   WHERE enterprise_id = p_enterprise AND year = y
  RETURNING last_number INTO n;

  RETURN 'ПР-' || y || '-' || lpad(n::text, 5, '0');
END;
$$ LANGUAGE plpgsql;

-- Оплаченная сумма и статус должны пересчитываться автоматически.
-- Ручное обновление paid_amount в коде рано или поздно разъедется с
-- реальными платежами: достаточно одного пути, который забыли обновить.
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
                >= COALESCE(i.total_amount, 0) THEN 'paid'
           ELSE 'partial' END,
         updated_at = NOW()
   WHERE i.id = inv;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_recalc_invoice_payment ON supplier_payments;
CREATE TRIGGER trg_recalc_invoice_payment
  AFTER INSERT OR UPDATE OR DELETE ON supplier_payments
  FOR EACH ROW EXECUTE FUNCTION recalc_invoice_payment();

-- Витрина долгов: что должны поставщикам и по каким накладным.
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
       COALESCE(i.total_amount, 0) - i.paid_amount AS debt,
       i.payment_status
  FROM supply_invoices i
  LEFT JOIN suppliers s ON s.id = i.supplier_id
 WHERE i.status = 'received';

CREATE INDEX IF NOT EXISTS idx_supply_invoices_payment_status
  ON supply_invoices (enterprise_id, payment_status) WHERE status = 'received';
