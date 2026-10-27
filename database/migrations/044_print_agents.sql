-- ============================================================
-- Миграция 044: агенты печати и очередь заданий
--
-- Зачем. Раньше kitchen-service печатал сам: node-thermal-printer
-- открывал TCP на PRINTER_INTERFACE изнутри контейнера. Это работает
-- только когда сервер стоит в одной локальной сети с принтером.
-- На удалённом проде адрес вида 192.168.x.x недостижим, и печать молча
-- уходила в "simulation mode" — API отвечал успехом, бумаги не было.
--
-- Решение. Сервер больше не печатает, а ставит задание в очередь.
-- На кухне работает агент: он сам подключается к серверу исходящим
-- соединением (публичный IP и проброс портов кухне не нужны), забирает
-- задания своих станций и печатает на принтер в своей сети.
-- ============================================================

-- ─── Агенты печати ──────────────────────────────────────────
-- Один агент = одна машина на точке (кухонный ПК / мини-ПК).
-- Аутентификация по токену; в базе только sha256-хеш, сам токен
-- показывается администратору один раз при создании.
CREATE TABLE IF NOT EXISTS print_agents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id  UUID NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
  restaurant_id  UUID REFERENCES restaurants(id) ON DELETE SET NULL,
  name           VARCHAR(200) NOT NULL,
  token_hash     CHAR(64) NOT NULL,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  -- телеметрия, которую присылает сам агент
  agent_version  VARCHAR(40),
  platform       VARCHAR(40),
  hostname       VARCHAR(200),
  last_seen_at   TIMESTAMP WITH TIME ZONE,
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Токен — единственный ключ входа агента, поиск по нему идёт на каждом
-- опросе очереди: уникальный индекс и защищает от коллизий, и ускоряет.
CREATE UNIQUE INDEX IF NOT EXISTS idx_print_agents_token ON print_agents(token_hash);
CREATE INDEX IF NOT EXISTS idx_print_agents_enterprise ON print_agents(enterprise_id);

-- ─── Привязка станции к агенту ──────────────────────────────
-- Станция без агента остаётся в прежнем режиме (сервер в одной сети
-- с принтером) — миграция не ломает уже настроенные станции.
ALTER TABLE printer_stations
  ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES print_agents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_printer_stations_agent ON printer_stations(agent_id);

-- ─── Очередь заданий печати ─────────────────────────────────
CREATE TABLE IF NOT EXISTS print_jobs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enterprise_id  UUID NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
  station_id     INTEGER REFERENCES printer_stations(id) ON DELETE SET NULL,
  agent_id       UUID REFERENCES print_agents(id) ON DELETE SET NULL,
  order_id       UUID,
  kind           VARCHAR(20) NOT NULL,
  -- готовые байты ESC/POS: формат чека считает сервер, агент только пишет
  -- их в принтер. Иначе логика формата расползлась бы по версиям агентов.
  payload        BYTEA NOT NULL,
  -- текстовый вид того же чека — для диагностики из админки без принтера
  preview        TEXT,
  copies         INTEGER NOT NULL DEFAULT 1,
  status         VARCHAR(20) NOT NULL DEFAULT 'queued',
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_at     TIMESTAMP WITH TIME ZONE,
  printed_at     TIMESTAMP WITH TIME ZONE,
  CONSTRAINT print_jobs_kind_check
    CHECK (kind IN ('kitchen', 'receipt', 'test')),
  CONSTRAINT print_jobs_status_check
    CHECK (status IN ('queued', 'in_progress', 'done', 'failed')),
  -- NULL сквозь CHECK проходит, поэтому NOT NULL проверяем явно
  CONSTRAINT print_jobs_copies_positive
    CHECK (copies IS NOT NULL AND copies > 0),
  CONSTRAINT print_jobs_attempts_non_negative
    CHECK (attempts IS NOT NULL AND attempts >= 0)
);

-- Главный запрос сервиса — «дай очередь этого агента по возрастанию
-- времени»; частичный индекс по ожидающим не растёт вместе с историей.
CREATE INDEX IF NOT EXISTS idx_print_jobs_agent_queued
  ON print_jobs(agent_id, created_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_print_jobs_enterprise_created
  ON print_jobs(enterprise_id, created_at DESC);

-- Зависшие задания (агент забрал и умер) возвращаются в очередь по
-- claimed_at — индекс нужен сторожевому запросу.
CREATE INDEX IF NOT EXISTS idx_print_jobs_in_progress
  ON print_jobs(claimed_at)
  WHERE status = 'in_progress';
