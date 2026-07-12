-- ============================================================
-- Миграция 026: принтерные станции и настройки по предприятиям
-- Раньше kitchen printer.routes хранил станции/настройки в process-global
-- in-memory массивах, общих для ВСЕХ предприятий (cross-tenant leak).
-- Переносим в PostgreSQL со scope по enterprise_id.
-- ============================================================

CREATE TABLE IF NOT EXISTS printer_stations (
  id            SERIAL PRIMARY KEY,
  enterprise_id UUID NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
  name          VARCHAR(200) NOT NULL,
  type          VARCHAR(20)  NOT NULL,
  address       VARCHAR(200),
  device        VARCHAR(200),
  bluetooth     VARCHAR(100),
  categories    JSONB NOT NULL DEFAULT '[]'::jsonb,
  copies        INTEGER NOT NULL DEFAULT 1,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  status        VARCHAR(20) NOT NULL DEFAULT 'offline',
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_printer_stations_enterprise ON printer_stations(enterprise_id);

CREATE TABLE IF NOT EXISTS printer_settings (
  enterprise_id  UUID PRIMARY KEY REFERENCES enterprises(id) ON DELETE CASCADE,
  auto_print     BOOLEAN NOT NULL DEFAULT true,
  default_copies INTEGER NOT NULL DEFAULT 1,
  font_size      INTEGER NOT NULL DEFAULT 12,
  paper_width    INTEGER NOT NULL DEFAULT 80,
  encoding       VARCHAR(20) NOT NULL DEFAULT 'SLOVENIA',
  print_logo     BOOLEAN NOT NULL DEFAULT true,
  updated_at     TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
