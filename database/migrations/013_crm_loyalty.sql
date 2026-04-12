-- Миграция 013: CRM-модуль — профили клиентов, программы лояльности, акции, транзакции баллов

-- ========== 1. ПРОФИЛИ КЛИЕНТОВ ==========
CREATE TABLE IF NOT EXISTS customer_profiles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enterprise_id   UUID REFERENCES enterprises(id) ON DELETE SET NULL,

  -- Статистика покупок
  total_orders        INTEGER     NOT NULL DEFAULT 0,
  total_spent         DECIMAL(12,2) NOT NULL DEFAULT 0,
  average_order_value DECIMAL(12,2) NOT NULL DEFAULT 0,
  last_order_date     TIMESTAMP WITH TIME ZONE,

  -- Лояльность
  loyalty_points  INTEGER     NOT NULL DEFAULT 0,
  loyalty_tier    VARCHAR(50) NOT NULL DEFAULT 'bronze',  -- bronze / silver / gold / platinum

  -- Персональные данные
  birthday        DATE,
  preferences     JSONB       NOT NULL DEFAULT '{}',
  tags            VARCHAR(100)[],
  source          VARCHAR(100),   -- web / app / pos / referral / ...
  notes           TEXT,

  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_profiles_user        ON customer_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_customer_profiles_enterprise  ON customer_profiles(enterprise_id);
CREATE INDEX IF NOT EXISTS idx_customer_profiles_tier        ON customer_profiles(loyalty_tier);

-- Автообновление updated_at
CREATE OR REPLACE FUNCTION update_customer_profiles_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS trg_customer_profiles_updated_at ON customer_profiles;
CREATE TRIGGER trg_customer_profiles_updated_at
  BEFORE UPDATE ON customer_profiles
  FOR EACH ROW EXECUTE FUNCTION update_customer_profiles_updated_at();

-- ========== 2. ПРОГРАММЫ ЛОЯЛЬНОСТИ ==========
CREATE TABLE IF NOT EXISTS loyalty_programs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id       UUID NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,

  name                VARCHAR(200) NOT NULL,
  -- points / cashback / discount / stamp_card
  program_type        VARCHAR(50)  NOT NULL,

  points_per_currency DECIMAL(10,4) NOT NULL DEFAULT 1,   -- баллов за 1 единицу валюты
  redemption_rate     DECIMAL(10,4) NOT NULL DEFAULT 0.01, -- стоимость 1 балла в валюте

  -- Пороги уровней, например: {"silver":10000,"gold":50000,"platinum":150000}
  tier_thresholds     JSONB NOT NULL DEFAULT '{}',
  -- Дополнительные правила начисления (двойные баллы в день рождения и т.п.)
  rules               JSONB NOT NULL DEFAULT '{}',

  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_programs_enterprise ON loyalty_programs(enterprise_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_programs_active     ON loyalty_programs(is_active);

CREATE OR REPLACE FUNCTION update_loyalty_programs_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS trg_loyalty_programs_updated_at ON loyalty_programs;
CREATE TRIGGER trg_loyalty_programs_updated_at
  BEFORE UPDATE ON loyalty_programs
  FOR EACH ROW EXECUTE FUNCTION update_loyalty_programs_updated_at();

-- ========== 3. АКЦИИ И ПРОМОКОДЫ ==========
CREATE TABLE IF NOT EXISTS promotions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id   UUID NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,

  name            VARCHAR(200) NOT NULL,
  -- percentage / fixed_amount / bogo / combo / happy_hour
  promo_type      VARCHAR(50)  NOT NULL,

  discount_value  DECIMAL(10,2) NOT NULL DEFAULT 0,
  -- Условия применения (минимальная сумма, категории блюд и т.п.)
  conditions      JSONB NOT NULL DEFAULT '{}',

  promo_code      VARCHAR(50) UNIQUE,
  usage_limit     INTEGER,       -- NULL = безлимитно
  used_count      INTEGER NOT NULL DEFAULT 0,

  valid_from      TIMESTAMP WITH TIME ZONE,
  valid_until     TIMESTAMP WITH TIME ZONE,
  is_active       BOOLEAN NOT NULL DEFAULT true,

  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promotions_enterprise  ON promotions(enterprise_id);
CREATE INDEX IF NOT EXISTS idx_promotions_promo_code  ON promotions(promo_code) WHERE promo_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_promotions_active      ON promotions(is_active);
CREATE INDEX IF NOT EXISTS idx_promotions_valid_until ON promotions(valid_until) WHERE valid_until IS NOT NULL;

CREATE OR REPLACE FUNCTION update_promotions_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS trg_promotions_updated_at ON promotions;
CREATE TRIGGER trg_promotions_updated_at
  BEFORE UPDATE ON promotions
  FOR EACH ROW EXECUTE FUNCTION update_promotions_updated_at();

-- ========== 4. ТРАНЗАКЦИИ БАЛЛОВ ==========
CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_profile_id UUID NOT NULL REFERENCES customer_profiles(id) ON DELETE CASCADE,
  enterprise_id       UUID REFERENCES enterprises(id) ON DELETE SET NULL,
  order_id            UUID,  -- внешний ключ к orders не задаём жёстко (сервисы независимы)

  -- earn / redeem / adjust / expire
  transaction_type    VARCHAR(20) NOT NULL,
  points              INTEGER     NOT NULL,  -- положительные = начисление, отрицательные = списание
  description         TEXT,

  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_tx_customer    ON loyalty_transactions(customer_profile_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_tx_enterprise  ON loyalty_transactions(enterprise_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_tx_order       ON loyalty_transactions(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_loyalty_tx_type        ON loyalty_transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_loyalty_tx_created     ON loyalty_transactions(created_at DESC);
