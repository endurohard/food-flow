-- ============================================================
-- Миграция 014: Финансовые таблицы
-- Кассы, операции, платежи, фискальные чеки, расходы
-- ============================================================

-- Кассы (POS-терминалы / кассовые аппараты ресторана)
CREATE TABLE IF NOT EXISTS cash_registers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id     UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  enterprise_id     UUID REFERENCES enterprises(id) ON DELETE SET NULL,
  name              VARCHAR(255) NOT NULL,
  fiscal_number     VARCHAR(100),
  status            VARCHAR(20) NOT NULL DEFAULT 'closed' CHECK (status IN ('open', 'closed')),
  opened_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  opened_at         TIMESTAMP WITH TIME ZONE,
  opening_balance   DECIMAL(12, 2) DEFAULT 0,
  current_balance   DECIMAL(12, 2) DEFAULT 0,
  created_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Кассовые операции (движение денег через кассу)
CREATE TABLE IF NOT EXISTS cash_operations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  register_id     UUID NOT NULL REFERENCES cash_registers(id) ON DELETE CASCADE,
  enterprise_id   UUID REFERENCES enterprises(id) ON DELETE SET NULL,
  -- Тип операции: продажа, возврат, внесение, изъятие, инкассация
  operation_type  VARCHAR(50) NOT NULL CHECK (operation_type IN ('sale', 'refund', 'cash_in', 'cash_out', 'encashment')),
  amount          DECIMAL(12, 2) NOT NULL,
  payment_method  VARCHAR(50) NOT NULL,
  order_id        UUID REFERENCES orders(id) ON DELETE SET NULL,
  performed_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  description     TEXT,
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Платежи по заказам (транзакции через эквайринг / наличные)
CREATE TABLE IF NOT EXISTS payments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  enterprise_id    UUID REFERENCES enterprises(id) ON DELETE SET NULL,
  amount           DECIMAL(12, 2) NOT NULL,
  payment_method   VARCHAR(50) NOT NULL,
  -- Платёжный шлюз: stripe, yookassa, sberbank, cash и т.д.
  payment_gateway  VARCHAR(100),
  -- Внешний идентификатор транзакции от платёжного шлюза
  external_id      VARCHAR(255),
  status           VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  refund_amount    DECIMAL(12, 2) DEFAULT 0,
  -- Произвольные мета-данные: детали транзакции, комиссии и т.д.
  metadata         JSONB DEFAULT '{}',
  created_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Фискальные чеки (ОФД: Контур, Такском и т.д.)
CREATE TABLE IF NOT EXISTS fiscal_receipts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  register_id             UUID REFERENCES cash_registers(id) ON DELETE SET NULL,
  enterprise_id           UUID REFERENCES enterprises(id) ON DELETE SET NULL,
  -- Номер чека в рамках смены
  receipt_number          VARCHAR(100) NOT NULL,
  -- Фискальный признак документа
  fiscal_sign             VARCHAR(255),
  -- Номер фискального документа
  fiscal_document_number  VARCHAR(100),
  -- Ссылка на электронный чек в ОФД
  ofd_url                 VARCHAR(500),
  receipt_type            VARCHAR(20) NOT NULL DEFAULT 'sale' CHECK (receipt_type IN ('sale', 'refund')),
  total_amount            DECIMAL(12, 2) NOT NULL,
  vat_amount              DECIMAL(12, 2) DEFAULT 0,
  printed_at              TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Категории расходов (иерархические: Продукты > Мясо, Зарплата > Кухня и т.д.)
CREATE TABLE IF NOT EXISTS expense_categories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id UUID NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  -- Ссылка на родительскую категорию (NULL = корневая категория)
  parent_id     UUID REFERENCES expense_categories(id) ON DELETE SET NULL,
  is_active     BOOLEAN NOT NULL DEFAULT true
);

-- Расходы предприятия
CREATE TABLE IF NOT EXISTS expenses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id UUID NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE SET NULL,
  category_id   UUID REFERENCES expense_categories(id) ON DELETE SET NULL,
  amount        DECIMAL(12, 2) NOT NULL,
  description   TEXT,
  expense_date  DATE NOT NULL,
  recorded_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  -- URL скана чека / накладной
  receipt_url   VARCHAR(500),
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- Индексы для быстрых выборок по частым паттернам
-- ============================================================

-- Кассы: поиск по ресторану и статусу (открытие/закрытие смены)
CREATE INDEX IF NOT EXISTS idx_cash_registers_restaurant_status
  ON cash_registers(restaurant_id, status);

CREATE INDEX IF NOT EXISTS idx_cash_registers_enterprise
  ON cash_registers(enterprise_id);

-- Кассовые операции: история по кассе и дате
CREATE INDEX IF NOT EXISTS idx_cash_operations_register
  ON cash_operations(register_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cash_operations_order
  ON cash_operations(order_id);

-- Платежи: выборки по заказу, предприятию и статусу
CREATE INDEX IF NOT EXISTS idx_payments_order
  ON payments(order_id);

CREATE INDEX IF NOT EXISTS idx_payments_enterprise_status
  ON payments(enterprise_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payments_external_id
  ON payments(external_id) WHERE external_id IS NOT NULL;

-- Фискальные чеки: поиск по заказу и кассе
CREATE INDEX IF NOT EXISTS idx_fiscal_receipts_order
  ON fiscal_receipts(order_id);

CREATE INDEX IF NOT EXISTS idx_fiscal_receipts_register
  ON fiscal_receipts(register_id);

-- Расходы: отчёты по периоду и предприятию
CREATE INDEX IF NOT EXISTS idx_expenses_enterprise_date
  ON expenses(enterprise_id, expense_date DESC);

CREATE INDEX IF NOT EXISTS idx_expenses_restaurant_date
  ON expenses(restaurant_id, expense_date DESC);

CREATE INDEX IF NOT EXISTS idx_expense_categories_enterprise
  ON expense_categories(enterprise_id, is_active);

-- ============================================================
-- Триггер: автоматически обновляем updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_cash_registers_updated_at
  BEFORE UPDATE ON cash_registers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trigger_payments_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
