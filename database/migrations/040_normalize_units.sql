-- 040: единый словарь единиц измерения.
--
-- В колонке unit сосуществовали два словаря: формы админки сохраняют
-- русские «кг/л/шт/упак», а часть строк заведена английскими kg/pcs.
-- Фронт показывает значение как есть, поэтому в одном списке встречались
-- и «0,3 кг», и «0,3 kg», а сравнение единиц между позициями ломалось.

UPDATE inventory_items SET unit = CASE lower(unit)
  WHEN 'kg'  THEN 'кг'   WHEN 'kgs' THEN 'кг'
  WHEN 'pcs' THEN 'шт'   WHEN 'pc'  THEN 'шт'
  WHEN 'l'   THEN 'л'    WHEN 'lt'  THEN 'л'  WHEN 'liter' THEN 'л'
  WHEN 'pack' THEN 'упак' WHEN 'g'  THEN 'г'
  ELSE unit END
WHERE lower(unit) IN ('kg','kgs','pcs','pc','l','lt','liter','pack','g');

UPDATE tech_card_ingredients SET unit = CASE lower(unit)
  WHEN 'kg'  THEN 'кг'   WHEN 'kgs' THEN 'кг'
  WHEN 'pcs' THEN 'шт'   WHEN 'pc'  THEN 'шт'
  WHEN 'l'   THEN 'л'    WHEN 'lt'  THEN 'л'  WHEN 'liter' THEN 'л'
  WHEN 'pack' THEN 'упак' WHEN 'g'  THEN 'г'
  ELSE unit END
WHERE unit IS NOT NULL AND lower(unit) IN ('kg','kgs','pcs','pc','l','lt','liter','pack','g');

-- Сторож: не даём снова завести английскую единицу. Без него любой скрипт
-- или импорт вернёт расхождение, и поймаем мы его опять только глазами.
ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_unit_ru;
ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_unit_ru
  CHECK (unit IS NULL OR unit IN ('кг','г','л','мл','шт','упак','порц'));
