-- ============================================================
-- Миграция 034: Модификаторы со складским учётом
-- ============================================================
-- Проблема: модификатор («доп. сироп», «доп. сыр», соус своего
-- производства) влиял ТОЛЬКО на цену в чеке. Со складом он не был связан
-- никак: ни колонки с позицией склада, ни техкарты. Продали 50 кофе с
-- сиропом — деньги в кассе есть, сироп на складе как стоял, так и стоит.
-- Остаток расходится с реальностью тем сильнее, чем больше продано, и
-- себестоимость блюда с модификатором занижена.
--
-- Стало: модификатор может списывать со склада одним из двух способов.
--
--   1. Простой расход: inventory_item_id + quantity
--      «доп. сыр 20 г» — берётся напрямую одна позиция склада.
--
--   2. По техкарте: tech_card_id
--      «соус Цезарь» — наш полуфабрикат со своей рецептурой. Техкарта
--      уже умеет выпускать позицию склада (tech_cards.output_item_id) и
--      вкладываться в другие карты, так что модификатор просто ссылается
--      на готовую карту, а не дублирует её состав.
--
-- Способы взаимоисключающие: одновременно заданные дали бы двойное
-- списание за один выбор в чеке. Проверяется CHECK'ом, а не кодом —
-- ограничение не обойти ни гонкой, ни ошибкой в логике сервиса.
--
-- Идемпотентна: безопасно запускать повторно.
-- Date: 2026-10-25

-- ── 1. Связь модификатора со складом ────────────────────────────────────────
ALTER TABLE menu_item_modifiers
    ADD COLUMN IF NOT EXISTS inventory_item_id UUID REFERENCES inventory_items(id);

ALTER TABLE menu_item_modifiers
    ADD COLUMN IF NOT EXISTS tech_card_id UUID REFERENCES tech_cards(id);

-- Брутто расхода на ОДИН выбор модификатора: столько уходит со склада.
-- Как и в техкарте, это именно брутто — то, что физически взяли.
ALTER TABLE menu_item_modifiers
    ADD COLUMN IF NOT EXISTS quantity DECIMAL(12, 4);

COMMENT ON COLUMN menu_item_modifiers.inventory_item_id IS
    'Позиция склада для простого расхода. Взаимоисключающа с tech_card_id.';
COMMENT ON COLUMN menu_item_modifiers.tech_card_id IS
    'Техкарта (свой полуфабрикат) вместо прямой позиции склада.';
COMMENT ON COLUMN menu_item_modifiers.quantity IS
    'Брутто расхода на один выбор модификатора. Для техкарты — число порций/циклов.';

-- ── 2. Два способа списания не могут быть заданы разом ──────────────────────
-- Иначе один выбор в чеке списал бы и позицию напрямую, и всю рецептуру.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'menu_item_modifiers_single_source_check'
          AND conrelid = 'menu_item_modifiers'::regclass
    ) THEN
        ALTER TABLE menu_item_modifiers
            ADD CONSTRAINT menu_item_modifiers_single_source_check
            CHECK (inventory_item_id IS NULL OR tech_card_id IS NULL);
    END IF;
END $$;

-- Расход задан — значит, задан и его источник, и наоборот.
-- Иначе модификатор молча не спишет ничего (источник без количества)
-- или спишет неизвестно что (количество без источника).
--
-- ВАЖНО про NULL: `quantity > 0` при пустом quantity даёт не FALSE, а NULL,
-- а CHECK со значением NULL Postgres считает ВЫПОЛНЕННЫМ. Без явного
-- `quantity IS NOT NULL` строка «источник задан, расход пуст» проходила
-- проверку — и такой модификатор молча не списывал ничего.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'menu_item_modifiers_quantity_pairing_check'
          AND conrelid = 'menu_item_modifiers'::regclass
    ) THEN
        ALTER TABLE menu_item_modifiers
            ADD CONSTRAINT menu_item_modifiers_quantity_pairing_check
            CHECK (
                (inventory_item_id IS NULL AND tech_card_id IS NULL AND quantity IS NULL)
                OR (
                    (inventory_item_id IS NOT NULL OR tech_card_id IS NOT NULL)
                    AND quantity IS NOT NULL AND quantity > 0
                )
            );
    END IF;
END $$;

-- ── 3. Индексы для списания и для поиска «где используется» ────────────────
CREATE INDEX IF NOT EXISTS idx_menu_item_modifiers_inventory_item
    ON menu_item_modifiers(inventory_item_id) WHERE inventory_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_menu_item_modifiers_tech_card
    ON menu_item_modifiers(tech_card_id) WHERE tech_card_id IS NOT NULL;

-- ── 4. Проданные модификаторы ищутся по заказу ──────────────────────────────
-- Списание идёт по order_id: нужен путь order_items -> order_item_modifiers.
-- Без этого индекса каждое списание читало бы таблицу целиком.
CREATE INDEX IF NOT EXISTS idx_order_item_modifiers_modifier
    ON order_item_modifiers(modifier_id);

-- ── 5. Перенос данных не требуется ──────────────────────────────────────────
-- Все существующие модификаторы остаются без складской связи
-- (три колонки NULL) и ведут себя в точности как раньше — влияют только
-- на цену. Учёт включается осознанно, по одному модификатору.
