-- ============================================================
-- Миграция 068: оплаты поставщику «в счёт долга» — по накладным
-- ============================================================
-- Кнопка «Оплатить» в карточке поставщика проводила оплату без накладной:
-- долг поставщика уменьшался, а у накладных оплата оставалась нулевой —
-- в списке накладных висел «долг», которого уже нет.
--
-- Свободные оплаты распределяются по принятым накладным этого поставщика
-- от старых к новым (как теперь делает сервис). Оплата делится на строки с
-- invoice_id; остаток сверх долга (предоплата) остаётся без привязки.
-- paid_amount и статус оплаты пересчитывает триггер из миграции 041.
-- Повторный запуск безопасен: трогаются только непривязанные оплаты.

DO $$
DECLARE
  p RECORD; inv RECORD; left_amt NUMERIC; take NUMERIC; first_row BOOLEAN;
BEGIN
  FOR p IN SELECT * FROM supplier_payments WHERE invoice_id IS NULL AND amount > 0 ORDER BY created_at, id LOOP
    left_amt := p.amount;
    first_row := TRUE;
    FOR inv IN
      SELECT i.id,
             i.total_amount - COALESCE((SELECT SUM(x.amount) FROM supplier_payments x WHERE x.invoice_id = i.id), 0) AS due
        FROM supply_invoices i
       WHERE i.supplier_id = p.supplier_id AND i.status = 'received' AND COALESCE(i.total_amount, 0) > 0
       ORDER BY COALESCE(i.received_at, i.created_at), i.created_at
    LOOP
      EXIT WHEN left_amt <= 0.005;
      CONTINUE WHEN inv.due <= 0.005;
      take := LEAST(inv.due, left_amt);
      IF first_row THEN
        UPDATE supplier_payments SET invoice_id = inv.id, amount = take WHERE id = p.id;
        first_row := FALSE;
      ELSE
        INSERT INTO supplier_payments (enterprise_id, supplier_id, invoice_id, amount, method, register_id, paid_by, notes, created_at)
        VALUES (p.enterprise_id, p.supplier_id, inv.id, take, p.method, NULL, p.paid_by, p.notes, p.created_at);
      END IF;
      left_amt := left_amt - take;
    END LOOP;
    IF NOT first_row AND left_amt > 0.005 THEN
      INSERT INTO supplier_payments (enterprise_id, supplier_id, invoice_id, amount, method, register_id, paid_by, notes, created_at)
      VALUES (p.enterprise_id, p.supplier_id, NULL, left_amt, p.method, NULL, p.paid_by, p.notes, p.created_at);
    END IF;
  END LOOP;
END $$;
