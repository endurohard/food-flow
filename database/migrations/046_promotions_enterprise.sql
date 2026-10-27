-- 046: привести таблицу promotions к тому, что читает crm-service.
--
-- Проблема. Экран «Лояльность» не показывал акции вовсе: GET /api/crm/promotions
-- падал с 500 «column enterprise_id does not exist». Таблица создана ранней
-- миграцией (017) под одну точку — с `restaurant_id`, `start_date`, `end_date`,
-- `usage_count`, а multi-tenant (006) её пропустила. Код же с тех пор работает
-- в терминах предприятия и ждёт `enterprise_id`, `conditions`, `valid_from`,
-- `valid_until`, `used_count`. Акции нельзя было ни создать, ни посмотреть, ни
-- применить промокод — при этом ошибка выглядела как «Internal server error»,
-- по которому непонятно, что именно не так.
--
-- Почему правим схему, а не код. Промокод и акция принадлежат предприятию, а не
-- одной точке: та же акция действует во всех заведениях сети, и фильтр по
-- `restaurant_id` рассёк бы её по точкам. Остальные таблицы CRM
-- (loyalty_programs, loyalty_transactions) уже живут на `enterprise_id` —
-- promotions остаётся единственной выбивающейся.
--
-- Данных в таблице нет (0 строк на проде), поэтому перенос значений не нужен;
-- тем не менее заполняем enterprise_id из точки, если строки появятся позже.

-- ─── 1. Тенант ──────────────────────────────────────────────────────
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS enterprise_id UUID
  REFERENCES enterprises(id) ON DELETE CASCADE;

-- Унаследованные строки (если есть) привязываем к предприятию своей точки
UPDATE promotions p
   SET enterprise_id = r.enterprise_id
  FROM restaurants r
 WHERE p.restaurant_id = r.id
   AND p.enterprise_id IS NULL;

-- restaurant_id больше не обязателен: акция принадлежит предприятию.
-- Колонку не удаляем — она может пригодиться для акции на одну точку,
-- но NOT NULL снимаем, иначе вставка из кода (без точки) падает.
ALTER TABLE promotions ALTER COLUMN restaurant_id DROP NOT NULL;

-- Отбор по предприятию идёт на каждом открытии экрана лояльности
CREATE INDEX IF NOT EXISTS idx_promotions_enterprise ON promotions(enterprise_id);

-- ─── 2. Поля, которые читает и пишет код ────────────────────────────
-- conditions: правила акции в JSON (время действия, категории, состав набора)
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS conditions JSONB NOT NULL DEFAULT '{}'::jsonb;

-- valid_from/valid_until вместо start_date/end_date. Старые колонки NOT NULL,
-- поэтому сначала снимаем ограничение, иначе INSERT из кода (который их не
-- заполняет) падает на NOT NULL, а не на отсутствии колонки — и это выглядит
-- как другая ошибка.
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ;
ALTER TABLE promotions ALTER COLUMN start_date DROP NOT NULL;
ALTER TABLE promotions ALTER COLUMN end_date DROP NOT NULL;

UPDATE promotions SET valid_from = start_date WHERE valid_from IS NULL AND start_date IS NOT NULL;
UPDATE promotions SET valid_until = end_date  WHERE valid_until IS NULL AND end_date  IS NOT NULL;

-- used_count: код увеличивает его при применении промокода, в таблице было
-- usage_count. Переносим значение и оставляем одно имя — два счётчика
-- разошлись бы, и лимит использований перестал бы срабатывать.
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS used_count INTEGER NOT NULL DEFAULT 0;
UPDATE promotions SET used_count = COALESCE(usage_count, 0) WHERE used_count = 0;

-- ─── 3. Ограничения целостности ─────────────────────────────────────
-- Промокод уникален внутри предприятия, а не глобально: две организации
-- вправе завести одинаковый код, и глобальная уникальность мешала бы им.
-- NULL в promo_code (акция без кода) индекс не затрагивает.
CREATE UNIQUE INDEX IF NOT EXISTS idx_promotions_code_per_enterprise
  ON promotions(enterprise_id, promo_code)
  WHERE promo_code IS NOT NULL;

-- Лимит использований не может быть отрицательным, а счётчик — уходить в минус.
-- NULL сквозь CHECK проходит, поэтому NOT NULL проверяем явно.
ALTER TABLE promotions DROP CONSTRAINT IF EXISTS promotions_used_count_non_negative;
ALTER TABLE promotions ADD CONSTRAINT promotions_used_count_non_negative
  CHECK (used_count IS NOT NULL AND used_count >= 0);

ALTER TABLE promotions DROP CONSTRAINT IF EXISTS promotions_usage_limit_positive;
ALTER TABLE promotions ADD CONSTRAINT promotions_usage_limit_positive
  CHECK (usage_limit IS NULL OR usage_limit > 0);

-- Период действия: конец не раньше начала, иначе акция не сработает никогда,
-- а причина будет неочевидна на экране.
ALTER TABLE promotions DROP CONSTRAINT IF EXISTS promotions_valid_period;
ALTER TABLE promotions ADD CONSTRAINT promotions_valid_period
  CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_until >= valid_from);
