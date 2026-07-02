-- ============================================================
-- Миграция 020: Оптовый контур (B2B)
-- Контрагенты, оптовые заказы/отгрузки, возвраты, производство
-- по техкартам, оптовые/розничные цены, Z-отчёты касс
-- ============================================================

-- ------------------------------------------------------------
-- 1. Цены и производство на складских позициях
-- ------------------------------------------------------------

-- Оптовая и розничная цена позиции (себестоимость уже есть: cost_price + FIFO-партии)
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS wholesale_price DECIMAL(12, 2);
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS retail_price DECIMAL(12, 2);
-- Признак производимой позиции (готовая продукция / полуфабрикат)
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS is_produced BOOLEAN DEFAULT false;

-- Техкарта может производить складскую позицию (готовую продукцию или полуфабрикат),
-- которая приходуется на склад и может быть ингредиентом другой техкарты
ALTER TABLE tech_cards ADD COLUMN IF NOT EXISTS output_item_id UUID REFERENCES inventory_items(id) ON DELETE SET NULL;
ALTER TABLE tech_cards ADD COLUMN IF NOT EXISTS output_quantity DECIMAL(12, 3) DEFAULT 1;
ALTER TABLE tech_cards ADD COLUMN IF NOT EXISTS name VARCHAR(255);
-- Производственная техкарта может не иметь блюда в меню
ALTER TABLE tech_cards ALTER COLUMN menu_item_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tech_cards_output_item ON tech_cards(output_item_id);

-- ------------------------------------------------------------
-- 2. Контрагенты (оптовые клиенты B2B)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS counterparties (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id          UUID REFERENCES enterprises(id) ON DELETE SET NULL,
  name                   VARCHAR(255) NOT NULL,
  legal_name             VARCHAR(255),
  tax_id                 VARCHAR(50),                -- ИНН
  contact_person         VARCHAR(255),
  phone                  VARCHAR(50),
  whatsapp_phone         VARCHAR(50),                -- куда слать накладные
  email                  VARCHAR(255),
  address                TEXT,
  delivery_address       TEXT,
  manager_id             UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Условия оплаты: предоплата / при доставке / отсрочка
  payment_terms          VARCHAR(20) NOT NULL DEFAULT 'on_delivery'
                         CHECK (payment_terms IN ('prepaid', 'on_delivery', 'deferred')),
  payment_deferral_days  INTEGER DEFAULT 0,
  credit_limit           DECIMAL(12, 2) DEFAULT 0,
  -- Текущий долг контрагента перед нами (положительный = должен нам)
  balance                DECIMAL(12, 2) NOT NULL DEFAULT 0,
  -- По какой цене продаём этому контрагенту по умолчанию
  price_type             VARCHAR(20) NOT NULL DEFAULT 'wholesale'
                         CHECK (price_type IN ('wholesale', 'retail')),
  notes                  TEXT,
  is_active              BOOLEAN DEFAULT true,
  created_at             TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at             TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_counterparties_enterprise ON counterparties(enterprise_id);
CREATE INDEX IF NOT EXISTS idx_counterparties_manager ON counterparties(manager_id);

-- ------------------------------------------------------------
-- 3. Оптовые заказы (отгрузки) и позиции
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wholesale_orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id     UUID REFERENCES enterprises(id) ON DELETE SET NULL,
  counterparty_id   UUID NOT NULL REFERENCES counterparties(id),
  warehouse_id      UUID REFERENCES warehouses(id) ON DELETE SET NULL,
  -- Номер накладной, присваивается при подтверждении: НК-YYYYMMDD-NNN
  invoice_number    VARCHAR(50) UNIQUE,
  status            VARCHAR(20) NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'confirmed', 'assembled', 'shipped', 'delivered', 'closed', 'cancelled')),
  manager_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  driver_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  delivery_date     DATE,
  delivery_address  TEXT,
  total_amount      DECIMAL(12, 2) NOT NULL DEFAULT 0,
  -- Фактическая себестоимость отгрузки (FIFO), заполняется при отгрузке
  total_cost        DECIMAL(12, 2) DEFAULT 0,
  paid_amount       DECIMAL(12, 2) NOT NULL DEFAULT 0,
  payment_status    VARCHAR(20) NOT NULL DEFAULT 'unpaid'
                    CHECK (payment_status IN ('unpaid', 'partial', 'paid')),
  notes             TEXT,
  confirmed_at      TIMESTAMP WITH TIME ZONE,
  shipped_at        TIMESTAMP WITH TIME ZONE,
  delivered_at      TIMESTAMP WITH TIME ZONE,
  created_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wholesale_orders_enterprise ON wholesale_orders(enterprise_id);
CREATE INDEX IF NOT EXISTS idx_wholesale_orders_counterparty ON wholesale_orders(counterparty_id);
CREATE INDEX IF NOT EXISTS idx_wholesale_orders_status ON wholesale_orders(status);
CREATE INDEX IF NOT EXISTS idx_wholesale_orders_driver ON wholesale_orders(driver_id);
CREATE INDEX IF NOT EXISTS idx_wholesale_orders_manager ON wholesale_orders(manager_id);
CREATE INDEX IF NOT EXISTS idx_wholesale_orders_delivery_date ON wholesale_orders(delivery_date);

CREATE TABLE IF NOT EXISTS wholesale_order_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           UUID NOT NULL REFERENCES wholesale_orders(id) ON DELETE CASCADE,
  inventory_item_id  UUID NOT NULL REFERENCES inventory_items(id),
  name               VARCHAR(255) NOT NULL,          -- снапшот названия
  quantity           DECIMAL(12, 3) NOT NULL,
  unit               VARCHAR(20),
  price              DECIMAL(12, 2) NOT NULL,        -- цена продажи за единицу (снапшот)
  total              DECIMAL(12, 2) NOT NULL,
  -- Фактическая себестоимость единицы при отгрузке (FIFO)
  cost_price         DECIMAL(12, 2),
  shipped_quantity   DECIMAL(12, 3),
  returned_quantity  DECIMAL(12, 3) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_wholesale_order_items_order ON wholesale_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_wholesale_order_items_item ON wholesale_order_items(inventory_item_id);

-- ------------------------------------------------------------
-- 4. Оплаты и взаиморасчёты с контрагентами
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS counterparty_payments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id    UUID REFERENCES enterprises(id) ON DELETE SET NULL,
  counterparty_id  UUID NOT NULL REFERENCES counterparties(id),
  order_id         UUID REFERENCES wholesale_orders(id) ON DELETE SET NULL,
  -- payment: оплата от контрагента; refund: возврат денег контрагенту;
  -- credit_note: кредит-нота по возврату товара; adjustment: ручная корректировка долга
  payment_type     VARCHAR(20) NOT NULL DEFAULT 'payment'
                   CHECK (payment_type IN ('payment', 'refund', 'credit_note', 'adjustment')),
  amount           DECIMAL(12, 2) NOT NULL,
  method           VARCHAR(20) CHECK (method IN ('cash', 'card', 'transfer', 'offset')),
  register_id      UUID REFERENCES cash_registers(id) ON DELETE SET NULL,
  received_by      UUID REFERENCES users(id) ON DELETE SET NULL,  -- кто принял деньги (водитель/менеджер)
  notes            TEXT,
  created_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_counterparty_payments_counterparty ON counterparty_payments(counterparty_id);
CREATE INDEX IF NOT EXISTS idx_counterparty_payments_order ON counterparty_payments(order_id);
CREATE INDEX IF NOT EXISTS idx_counterparty_payments_enterprise ON counterparty_payments(enterprise_id);
CREATE INDEX IF NOT EXISTS idx_counterparty_payments_received_by ON counterparty_payments(received_by);

-- ------------------------------------------------------------
-- 5. Возвраты по отгрузкам
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wholesale_returns (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id    UUID REFERENCES enterprises(id) ON DELETE SET NULL,
  order_id         UUID NOT NULL REFERENCES wholesale_orders(id),
  counterparty_id  UUID NOT NULL REFERENCES counterparties(id),
  return_number    VARCHAR(50) UNIQUE,               -- ВЗ-YYYYMMDD-NNN
  status           VARCHAR(20) NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'confirmed', 'cancelled')),
  reason           TEXT,
  total_amount     DECIMAL(12, 2) NOT NULL DEFAULT 0,
  processed_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at     TIMESTAMP WITH TIME ZONE,
  created_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wholesale_returns_order ON wholesale_returns(order_id);
CREATE INDEX IF NOT EXISTS idx_wholesale_returns_counterparty ON wholesale_returns(counterparty_id);
CREATE INDEX IF NOT EXISTS idx_wholesale_returns_enterprise ON wholesale_returns(enterprise_id);

CREATE TABLE IF NOT EXISTS wholesale_return_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id          UUID NOT NULL REFERENCES wholesale_returns(id) ON DELETE CASCADE,
  order_item_id      UUID REFERENCES wholesale_order_items(id) ON DELETE SET NULL,
  inventory_item_id  UUID NOT NULL REFERENCES inventory_items(id),
  quantity           DECIMAL(12, 3) NOT NULL,
  price              DECIMAL(12, 2) NOT NULL,        -- по цене отгрузки
  -- Решение по позиции: restock = вернуть на склад, write_off = списать (порча)
  disposition        VARCHAR(20) NOT NULL DEFAULT 'restock'
                     CHECK (disposition IN ('restock', 'write_off')),
  reason             TEXT
);

CREATE INDEX IF NOT EXISTS idx_wholesale_return_items_return ON wholesale_return_items(return_id);

-- ------------------------------------------------------------
-- 6. Производство по техкартам
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id   UUID REFERENCES enterprises(id) ON DELETE SET NULL,
  tech_card_id    UUID NOT NULL REFERENCES tech_cards(id),
  output_item_id  UUID NOT NULL REFERENCES inventory_items(id),
  warehouse_id    UUID NOT NULL REFERENCES warehouses(id),
  quantity        DECIMAL(12, 3) NOT NULL,           -- произведено единиц продукции
  -- Фактическая себестоимость выпуска = сумма FIFO-стоимости списанных ингредиентов
  total_cost      DECIMAL(12, 2),
  unit_cost       DECIMAL(12, 2),
  status          VARCHAR(20) NOT NULL DEFAULT 'completed'
                  CHECK (status IN ('completed', 'cancelled')),
  produced_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  notes           TEXT,
  produced_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_production_runs_enterprise ON production_runs(enterprise_id);
CREATE INDEX IF NOT EXISTS idx_production_runs_output_item ON production_runs(output_item_id);
CREATE INDEX IF NOT EXISTS idx_production_runs_produced_at ON production_runs(produced_at);

CREATE TABLE IF NOT EXISTS production_run_ingredients (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_run_id  UUID NOT NULL REFERENCES production_runs(id) ON DELETE CASCADE,
  inventory_item_id  UUID NOT NULL REFERENCES inventory_items(id),
  quantity           DECIMAL(12, 3) NOT NULL,        -- списано со склада
  cost               DECIMAL(12, 2)                  -- фактическая FIFO-стоимость списанного
);

CREATE INDEX IF NOT EXISTS idx_production_run_ingredients_run ON production_run_ingredients(production_run_id);

-- ------------------------------------------------------------
-- 7. Z-отчёты касс (снапшот смены при закрытии)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cash_daily_reports (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id     UUID REFERENCES enterprises(id) ON DELETE SET NULL,
  register_id       UUID NOT NULL REFERENCES cash_registers(id) ON DELETE CASCADE,
  report_date       DATE NOT NULL,
  opened_at         TIMESTAMP WITH TIME ZONE,
  closed_at         TIMESTAMP WITH TIME ZONE,
  opening_balance   DECIMAL(12, 2) NOT NULL DEFAULT 0,
  total_sales       DECIMAL(12, 2) NOT NULL DEFAULT 0,
  total_refunds     DECIMAL(12, 2) NOT NULL DEFAULT 0,
  total_cash_in     DECIMAL(12, 2) NOT NULL DEFAULT 0,
  total_cash_out    DECIMAL(12, 2) NOT NULL DEFAULT 0,
  total_encashment  DECIMAL(12, 2) NOT NULL DEFAULT 0,
  -- Расчётный остаток по операциям vs фактический при пересчёте
  expected_balance  DECIMAL(12, 2) NOT NULL DEFAULT 0,
  actual_balance    DECIMAL(12, 2),
  discrepancy       DECIMAL(12, 2),
  closed_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  notes             TEXT,
  created_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cash_daily_reports_register ON cash_daily_reports(register_id);
CREATE INDEX IF NOT EXISTS idx_cash_daily_reports_date ON cash_daily_reports(report_date);
CREATE INDEX IF NOT EXISTS idx_cash_daily_reports_enterprise ON cash_daily_reports(enterprise_id);

-- ------------------------------------------------------------
-- 8. Счётчики номеров документов (накладные, возвраты)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wholesale_doc_counters (
  enterprise_id  UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  doc_type       VARCHAR(20) NOT NULL,               -- invoice | return
  doc_date       DATE NOT NULL,
  counter        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (enterprise_id, doc_type, doc_date)
);

-- ------------------------------------------------------------
-- 9. Связь расходов с приходными накладными поставщиков
-- ------------------------------------------------------------
-- Категории расходов и расходы могут быть глобальными (без предприятия)
ALTER TABLE expense_categories ALTER COLUMN enterprise_id DROP NOT NULL;
ALTER TABLE expenses ALTER COLUMN enterprise_id DROP NOT NULL;

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS supply_invoice_id UUID REFERENCES supply_invoices(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_supplier ON expenses(supplier_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_supply_invoice ON expenses(supply_invoice_id) WHERE supply_invoice_id IS NOT NULL;
