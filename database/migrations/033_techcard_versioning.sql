-- ============================================================
-- Миграция 033: Версионность техкарт по дате
-- ============================================================
-- Проблема: техкарта одна на блюдо, правка затирает прежнюю рецептуру.
-- Как только меняется состав или норма закладки, ВСЕ прошлые заказы
-- начинают пересчитываться по новой карте — себестоимость задним числом
-- становится враньём, отчёты за закрытые периоды «едут».
--
-- Стало: у карты есть срок действия, как в iiko («Активная с 10.10.2026»).
--   effective_from — с какой даты действует (включительно)
--   effective_to   — по какую (включительно), NULL = бессрочно
--
-- Заказ списывается по версии, действовавшей НА ДАТУ ЗАКАЗА, а не на
-- сегодня. Поэтому прошлые продажи сохраняют свою себестоимость навсегда.
--
-- ВАЖНО, почему EXCLUDE, а не обычный UNIQUE:
-- списание ищет карту по menu_item_id. Если на одну дату окажется две
-- действующие версии, запрос вернёт ингредиенты ОБЕИХ и спишет двойной
-- комплект продуктов. Обычным UNIQUE пересечение интервалов не поймать,
-- поэтому стоит ограничение на пересечение диапазонов дат.
--
-- Идемпотентна: безопасно запускать повторно.
-- Date: 2026-10-21

-- Нужно для EXCLUDE по (uuid =, daterange &&): btree_gist учит GiST
-- работать с обычным равенством по скалярным типам.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ── 1. Срок действия ────────────────────────────────────────────────────────
ALTER TABLE tech_cards
    ADD COLUMN IF NOT EXISTS effective_from DATE NOT NULL DEFAULT CURRENT_DATE;

ALTER TABLE tech_cards
    ADD COLUMN IF NOT EXISTS effective_to DATE;

COMMENT ON COLUMN tech_cards.effective_from IS
    'Дата начала действия версии (включительно).';
COMMENT ON COLUMN tech_cards.effective_to IS
    'Дата окончания действия (включительно). NULL — действует бессрочно.';

-- Период не может быть вывернут наизнанку
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'tech_cards_effective_period_check'
          AND conrelid = 'tech_cards'::regclass
    ) THEN
        ALTER TABLE tech_cards
            ADD CONSTRAINT tech_cards_effective_period_check
            CHECK (effective_to IS NULL OR effective_to >= effective_from);
    END IF;
END $$;

-- ── 2. Запрет пересечения версий ────────────────────────────────────────────
-- Две действующие одновременно версии одного блюда — это двойное списание.
-- Ограничение только для активных карт с привязкой к блюду: архивные
-- (is_active = false) не мешают, производственные карты блюду не принадлежат.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'tech_cards_no_overlap_per_menu_item'
          AND conrelid = 'tech_cards'::regclass
    ) THEN
        ALTER TABLE tech_cards
            ADD CONSTRAINT tech_cards_no_overlap_per_menu_item
            EXCLUDE USING gist (
                menu_item_id WITH =,
                daterange(effective_from, effective_to, '[]') WITH &&
            )
            WHERE (menu_item_id IS NOT NULL AND is_active = true);
    END IF;
END $$;

-- ── 3. Индекс под выборку действующей версии ────────────────────────────────
-- Списание на каждый заказ ищет карту по блюду и дате — без индекса это
-- последовательное сканирование на горячем пути продажи.
CREATE INDEX IF NOT EXISTS idx_tech_cards_effective
    ON tech_cards (menu_item_id, effective_from DESC)
    WHERE menu_item_id IS NOT NULL AND is_active = true;

-- ── 4. Существующие карты действуют с момента создания ──────────────────────
-- Дефолт CURRENT_DATE проставил сегодняшнюю дату всем старым картам.
-- Это сделало бы их «не действовавшими» для вчерашних заказов, поэтому
-- отматываем на дату создания карты.
UPDATE tech_cards
SET effective_from = created_at::date
WHERE created_at IS NOT NULL
  AND effective_from = CURRENT_DATE
  AND created_at::date < CURRENT_DATE;
