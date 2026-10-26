-- 038: фасовка ингредиентов и метод списания техкарты (этап C)
--
-- Эталон — iiko: в карточке техкарты есть колонки «Фасовка», «Количество
-- фасовок», «Брутто ед. измерения», «Брутто», а у самой карты — «Метод
-- списания» (списывать ингредиенты либо списывать готовое блюдо).
--
-- ── Почему количество фасовок НЕ хранится ──────────────────────────────────
-- Соблазн — завести packages_count рядом с quantity. Так делать нельзя:
-- получаются два источника истины для одной величины. Любая правка брутто
-- мимо формы (миграция, импорт, правка через API старой версии) оставляет
-- packages_count прежним, и карточка показывает «2 упаковки = 1.5 кг» при
-- фасовке 1 кг. Расхождение тихое — списание берёт quantity и работает
-- верно, а человек читает с экрана неверные упаковки.
--
-- Поэтому источник истины один: quantity (брутто в базовой единице).
-- Количество фасовок — ВЫЧИСЛЯЕМОЕ: quantity / package_size. Форма
-- позволяет вводить в фасовках, но на запись пересчитывает в брутто.
--
-- ── Метод списания ─────────────────────────────────────────────────────────
-- 'ingredients' — обычное поведение: при продаже списывается сырьё.
-- 'finished'    — списывается уже готовая позиция со склада (output_item_id).
--                 Нужно для блюд, которые готовят партиями заранее: сырьё
--                 ушло в момент выпуска, второй раз его списывать нельзя —
--                 это двойной учёт.
--
-- Идемпотентна.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Фасовка ингредиента
-- ---------------------------------------------------------------------------
ALTER TABLE tech_card_ingredients
    -- Название фасовки для человека: «упак», «бутылка», «лоток».
    ADD COLUMN IF NOT EXISTS package_unit VARCHAR(20),
    -- Сколько базовых единиц (кг, л, шт) в одной фасовке.
    ADD COLUMN IF NOT EXISTS package_size DECIMAL(10, 4);

-- Фасовка либо задана целиком, либо не задана вовсе. Размер без названия
-- и название без размера — незаполненная форма, а не валидные данные.
-- Нулевой и отрицательный размер запрещены отдельно: деление quantity на
-- него даёт бесконечность, и карточка показала бы «Infinity упаковок».
ALTER TABLE tech_card_ingredients DROP CONSTRAINT IF EXISTS tech_card_ingredients_package_check;
ALTER TABLE tech_card_ingredients
    ADD CONSTRAINT tech_card_ingredients_package_check CHECK (
        (package_unit IS NULL AND package_size IS NULL)
        OR (package_unit IS NOT NULL AND package_size IS NOT NULL AND package_size > 0)
    );

COMMENT ON COLUMN tech_card_ingredients.package_unit IS
    'Название фасовки для экрана: упак, бутылка, лоток. NULL — ведётся в базовых единицах.';
COMMENT ON COLUMN tech_card_ingredients.package_size IS
    'Сколько базовых единиц в одной фасовке. Количество фасовок НЕ хранится — считается как quantity / package_size.';

-- ---------------------------------------------------------------------------
-- 2. Метод списания техкарты
-- ---------------------------------------------------------------------------
ALTER TABLE tech_cards
    ADD COLUMN IF NOT EXISTS write_off_method VARCHAR(20) NOT NULL DEFAULT 'ingredients';

ALTER TABLE tech_cards DROP CONSTRAINT IF EXISTS tech_cards_write_off_method_check;
ALTER TABLE tech_cards
    ADD CONSTRAINT tech_cards_write_off_method_check
        CHECK (write_off_method IN ('ingredients', 'finished'));

-- «Списывать готовое» без позиции выпуска списывать нечего: такая карта
-- молча не трогала бы склад вообще. Запрещаем на уровне БД, а не кода.
ALTER TABLE tech_cards DROP CONSTRAINT IF EXISTS tech_cards_finished_needs_output;
ALTER TABLE tech_cards
    ADD CONSTRAINT tech_cards_finished_needs_output CHECK (
        write_off_method <> 'finished' OR output_item_id IS NOT NULL
    );

COMMENT ON COLUMN tech_cards.write_off_method IS
    'ingredients — при продаже списывается сырьё; finished — списывается готовая позиция со склада (output_item_id), сырьё ушло при выпуске.';

-- ---------------------------------------------------------------------------
-- 3. Представление для экрана техкарты
-- ---------------------------------------------------------------------------
-- Нетто, выход и количество фасовок считаются в одном месте, а не в каждом
-- клиенте заново: расхождение формул между экранами — источник споров о том,
-- какая цифра правильная.
DROP VIEW IF EXISTS v_tech_card_ingredients;
CREATE VIEW v_tech_card_ingredients AS
    SELECT
        tci.id,
        tci.tech_card_id,
        tci.inventory_item_id,
        ii.name                      AS item_name,
        ii.sku,
        ii.item_type,
        tci.unit,
        tci.package_unit,
        tci.package_size,
        -- Количество фасовок — производная от брутто, не хранимое значение
        CASE WHEN tci.package_size IS NOT NULL AND tci.package_size > 0
             THEN ROUND(tci.quantity / tci.package_size, 4)
        END                          AS packages_count,
        tci.quantity                 AS gross,
        tci.cold_loss_percent,
        -- нетто = брутто × (1 - холодные потери/100)
        ROUND(tci.quantity * (1 - tci.cold_loss_percent / 100), 4) AS net,
        tci.hot_loss_percent,
        -- выход = нетто × (1 - горячие потери/100); потери считаются от РАЗНЫХ
        -- баз, поэтому именно каскад, а не сумма процентов от брутто
        ROUND(tci.quantity * (1 - tci.cold_loss_percent / 100)
                           * (1 - tci.hot_loss_percent / 100), 4)  AS output_weight,
        tci.is_optional,
        ii.cost_price
      FROM tech_card_ingredients tci
      LEFT JOIN inventory_items ii ON ii.id = tci.inventory_item_id;

COMMENT ON VIEW v_tech_card_ingredients IS
    'Строки техкарты с посчитанными нетто, выходом и количеством фасовок. Только для чтения.';

COMMIT;
