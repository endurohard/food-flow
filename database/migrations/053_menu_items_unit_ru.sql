-- ============================================================
-- Миграция 053: единица измерения блюда — по-русски и из списка
-- ============================================================
-- У блюд единица хранилась как 'piece' (умолчание из 008) и в «Номенклатуре»
-- показывалась по-английски, а поменять её было негде. У складских позиций
-- список уже ограничен (inventory_items_unit_ru) — приводим блюда к тому же
-- набору, чтобы форма правки предлагала одинаковый выбор.
-- На фискальный чек не влияет: касса передаёт ККТ меру «штука» сама.

UPDATE menu_items SET unit = 'шт' WHERE unit IS NULL OR unit IN ('piece', 'pcs', 'pc');
UPDATE menu_items SET unit = 'порц' WHERE unit IN ('portion', 'serving');
UPDATE menu_items SET unit = 'кг' WHERE unit IN ('kg');
UPDATE menu_items SET unit = 'г' WHERE unit IN ('g', 'gram');
UPDATE menu_items SET unit = 'л' WHERE unit IN ('l', 'liter');
UPDATE menu_items SET unit = 'мл' WHERE unit IN ('ml');
-- Всё, что не распознали, — штуки: иначе ограничение ниже не встанет
UPDATE menu_items SET unit = 'шт'
 WHERE unit NOT IN ('кг', 'г', 'л', 'мл', 'шт', 'упак', 'порц');

ALTER TABLE menu_items ALTER COLUMN unit SET DEFAULT 'шт';
ALTER TABLE menu_items ALTER COLUMN unit SET NOT NULL;
ALTER TABLE menu_items DROP CONSTRAINT IF EXISTS menu_items_unit_ru;
ALTER TABLE menu_items ADD CONSTRAINT menu_items_unit_ru
  CHECK (unit IN ('кг', 'г', 'л', 'мл', 'шт', 'упак', 'порц'));
