-- ============================================================
-- Миграция 025: hardening изоляции — enterprise_id NOT NULL
-- DB-level защита от untenanted строк. enterprise_id добавляется
-- миграцией 006 уже ПОСЛЕ 02-seed, поэтому демо-данные (рестораны,
-- меню) остаются с NULL — сначала backfill, затем SET NOT NULL.
-- Идемпотентно и безопасно: NOT NULL ставится только там, где колонка
-- есть и не осталось NULL (иначе пропуск с NOTICE).
-- ============================================================

-- 1) Демо-предприятие для orphan seed-данных (без своего enterprise)
INSERT INTO enterprises (id, name, business_type, subscription_plan)
  VALUES ('00000000-0000-0000-0000-000000000001', 'Demo (seed)', 'restaurant', 'basic')
  ON CONFLICT (id) DO NOTHING;

-- 2) Backfill orphan seed-строк
UPDATE restaurants SET enterprise_id = '00000000-0000-0000-0000-000000000001'
  WHERE enterprise_id IS NULL;
UPDATE menu_categories mc SET enterprise_id = r.enterprise_id
  FROM restaurants r WHERE mc.restaurant_id = r.id AND mc.enterprise_id IS NULL;
UPDATE menu_items mi SET enterprise_id = r.enterprise_id
  FROM restaurants r WHERE mi.restaurant_id = r.id AND mi.enterprise_id IS NULL;

-- 3) SET NOT NULL на tenant-таблицах (безопасно: только где колонка есть и нет NULL)
DO $$
DECLARE
  t text;
  nulls int;
  tenant_tables text[] := ARRAY[
    'restaurants','menu_categories','menu_items','menu_item_modifiers',
    'reservations','discounts','orders','kitchen_stations',
    'inventory_items','warehouses','stock_movements','inventory_batches',
    'suppliers','supply_invoices','supplier_payments','tech_cards','production_runs',
    'customer_profiles','loyalty_programs','promotions','loyalty_transactions',
    'staff_profiles','work_schedules','time_entries','payroll',
    'wholesale_orders','counterparties',
    'cash_registers','cash_operations','cash_daily_reports','payments',
    'expenses','expense_categories','fiscal_receipts',
    'driver_shifts','delivery_zones'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = t AND column_name = 'enterprise_id'
    ) THEN
      EXECUTE format('SELECT count(*) FROM %I WHERE enterprise_id IS NULL', t) INTO nulls;
      IF nulls = 0 THEN
        EXECUTE format('ALTER TABLE %I ALTER COLUMN enterprise_id SET NOT NULL', t);
        RAISE NOTICE 'NOT NULL enterprise_id: %', t;
      ELSE
        RAISE NOTICE 'SKIP % — % NULL enterprise_id rows', t, nulls;
      END IF;
    END IF;
  END LOOP;
END $$;
