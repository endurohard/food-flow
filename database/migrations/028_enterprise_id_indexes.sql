-- Migration: индексы по enterprise_id
-- Description: у 13 таблиц с enterprise_id не было ни одного индекса по нему, хотя
--              каждый запрос к ним скоупится по арендатору (Phase B, миграция 025).
--              Пока организаций единицы — незаметно; с ростом каждая выборка
--              превращается в seq scan по всей таблице.
--              Для «горячих» таблиц индекс композитный: (enterprise_id, <частый фильтр>),
--              чтобы покрывать и скоуп, и сортировку/диапазон по дате.
-- Идемпотентна: CREATE INDEX IF NOT EXISTS.
-- Date: 2026-09-14

-- Часто читаются диапазоном по дате → композитные
CREATE INDEX IF NOT EXISTS idx_cash_operations_enterprise_created
    ON cash_operations (enterprise_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_enterprise_created
    ON stock_movements (enterprise_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fiscal_receipts_enterprise_printed
    ON fiscal_receipts (enterprise_id, printed_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_schedules_enterprise_shift_date
    ON work_schedules (enterprise_id, shift_date);
CREATE INDEX IF NOT EXISTS idx_time_entries_enterprise_clock_in
    ON time_entries (enterprise_id, clock_in DESC);
CREATE INDEX IF NOT EXISTS idx_payroll_enterprise_period
    ON payroll (enterprise_id, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_driver_shifts_enterprise_start
    ON driver_shifts (enterprise_id, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_batches_enterprise_received
    ON inventory_batches (enterprise_id, received_at);

-- Справочники: выбираются целиком в рамках арендатора
CREATE INDEX IF NOT EXISTS idx_warehouses_enterprise
    ON warehouses (enterprise_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_tables_enterprise
    ON restaurant_tables (enterprise_id);
CREATE INDEX IF NOT EXISTS idx_kitchen_stations_enterprise
    ON kitchen_stations (enterprise_id);
CREATE INDEX IF NOT EXISTS idx_delivery_zones_enterprise
    ON delivery_zones (enterprise_id);
CREATE INDEX IF NOT EXISTS idx_tech_cards_enterprise
    ON tech_cards (enterprise_id);
