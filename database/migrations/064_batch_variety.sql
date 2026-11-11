-- ============================================================
-- Миграция 064: сорт (происхождение) в партии склада
-- ============================================================
-- Кофейня покупает «Кофе в зёрнах» разных сортов: в одной поставке —
-- Колумбия, в следующей — Эфиопия. Заводить на каждый сорт отдельный товар
-- и переписывать техкарты под каждую поставку неудобно, поэтому товар один,
-- а сорт — свойство партии:
--
--   * сорт вписывается в позицию накладной и при приёмке уходит в партию;
--   * без выбора гостя продажа списывает партии по FIFO (что пришло раньше);
--   * модификатор «на Эфиопии» (variety_item_id + variety) просит списать
--     этот ингредиент техкарты из партий выбранного сорта; не хватило —
--     остаток уходит с других партий, и это видно в движении.
--
-- Идемпотентна.

ALTER TABLE supply_invoice_items ADD COLUMN IF NOT EXISTS variety VARCHAR(100);
ALTER TABLE inventory_batches   ADD COLUMN IF NOT EXISTS variety VARCHAR(100);

-- Поиск партий сорта при списании
CREATE INDEX IF NOT EXISTS idx_inventory_batches_variety
    ON inventory_batches (warehouse_id, inventory_item_id, lower(variety))
 WHERE is_depleted = false AND variety IS NOT NULL;

-- Модификатор «выбор сорта»: какой ингредиент блюда и какого сорта списать.
-- Задаются только парой: сорт без ингредиента (или наоборот) не значит ничего.
ALTER TABLE menu_item_modifiers ADD COLUMN IF NOT EXISTS variety_item_id UUID REFERENCES inventory_items(id) ON DELETE SET NULL;
ALTER TABLE menu_item_modifiers ADD COLUMN IF NOT EXISTS variety VARCHAR(100);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'menu_item_modifiers_variety_pair_check') THEN
    -- NULL в CHECK считается выполненным, поэтому условие написано явно
    -- через IS NULL с обеих сторон, а не сравнением значений
    ALTER TABLE menu_item_modifiers ADD CONSTRAINT menu_item_modifiers_variety_pair_check
      CHECK ((variety_item_id IS NULL AND variety IS NULL)
          OR (variety_item_id IS NOT NULL AND variety IS NOT NULL AND btrim(variety) <> ''));
  END IF;
END $$;
