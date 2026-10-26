-- 042: себестоимость заготовки, которую ещё не производили.
--
-- Заготовку не покупают, поэтому цены прихода у неё нет, а партии появятся
-- только после первой варки. До этого inventory_items.cost_price = 0, и
-- строка заготовки в техкарте блюда показывала стоимость 0,00 — то есть
-- себестоимость любого блюда с заготовкой была занижена на её стоимость.
--
-- Порядок источников цены (как в iiko):
--   1) средневзвешенная по непогашенным партиям — фактическая;
--   2) справочная cost_price, если задана;
--   3) ПЛАНОВАЯ по техкарте выпуска — пока не произвели ни разу.

CREATE OR REPLACE FUNCTION item_effective_cost(p_item UUID, p_depth INT DEFAULT 0)
RETURNS NUMERIC AS $$
DECLARE
  v NUMERIC;
  tc RECORD;
BEGIN
  -- Потолок глубины: цикл запрещён при сохранении карты, но на грязных
  -- данных рекурсия положила бы базу.
  IF p_depth > 5 THEN RETURN 0; END IF;

  -- 1. Фактическая: средневзвешенная по остатку.
  SELECT SUM(b.quantity * b.cost_price) / NULLIF(SUM(b.quantity), 0) INTO v
    FROM inventory_batches b
   WHERE b.inventory_item_id = p_item
     AND b.is_depleted = false AND b.quantity > 0 AND b.cost_price IS NOT NULL;
  IF v IS NOT NULL AND v > 0 THEN RETURN v; END IF;

  -- 2. Справочная.
  SELECT i.cost_price INTO v FROM inventory_items i WHERE i.id = p_item;
  IF v IS NOT NULL AND v > 0 THEN RETURN v; END IF;

  -- 3. Плановая по действующей техкарте выпуска.
  SELECT t.id, t.output_quantity INTO tc
    FROM tech_cards t
   WHERE t.output_item_id = p_item AND t.is_active = true
     AND t.effective_from <= CURRENT_DATE
     AND (t.effective_to IS NULL OR t.effective_to >= CURRENT_DATE)
   ORDER BY t.effective_from DESC LIMIT 1;

  IF tc.id IS NULL OR COALESCE(tc.output_quantity, 0) <= 0 THEN RETURN 0; END IF;

  SELECT COALESCE(SUM(ing.quantity * item_effective_cost(ing.inventory_item_id, p_depth + 1)), 0)
    INTO v
    FROM tech_card_ingredients ing
   WHERE ing.tech_card_id = tc.id;

  RETURN ROUND(v / tc.output_quantity, 4);
END;
$$ LANGUAGE plpgsql STABLE;

-- Представление отдаёт цену через функцию: формула в одном месте, иначе
-- карточка и список техкарт начнут спорить о цифрах.
--
-- DROP, а не CREATE OR REPLACE: тип колонки меняется с numeric(10,2) на
-- numeric, а REPLACE смену типа не умеет («cannot change data type of view
-- column»). Зависимых объектов у представления нет — проверено.
DROP VIEW IF EXISTS v_tech_card_ingredients;
CREATE VIEW v_tech_card_ingredients AS
SELECT tci.id,
       tci.tech_card_id,
       tci.inventory_item_id,
       ii.name AS item_name,
       ii.sku,
       ii.item_type,
       tci.unit,
       tci.package_unit,
       tci.package_size,
       CASE WHEN tci.package_size IS NOT NULL AND tci.package_size > 0
            THEN round(tci.quantity / tci.package_size, 4) END AS packages_count,
       tci.quantity AS gross,
       tci.cold_loss_percent,
       round(tci.quantity * (1 - tci.cold_loss_percent / 100), 4) AS net,
       tci.hot_loss_percent,
       round(tci.quantity * (1 - tci.cold_loss_percent / 100)
                          * (1 - tci.hot_loss_percent / 100), 4) AS output_weight,
       tci.is_optional,
       round(item_effective_cost(tci.inventory_item_id), 2) AS cost_price,
       -- Откуда взялась цена: видно, расчёт по складу или плановый.
       CASE
         WHEN EXISTS (SELECT 1 FROM inventory_batches b
                       WHERE b.inventory_item_id = tci.inventory_item_id
                         AND b.is_depleted = false AND b.quantity > 0
                         AND b.cost_price IS NOT NULL) THEN 'stock_avg'
         WHEN COALESCE(ii.cost_price, 0) > 0 THEN 'last_purchase'
         WHEN EXISTS (SELECT 1 FROM tech_cards t
                       WHERE t.output_item_id = tci.inventory_item_id
                         AND t.is_active = true) THEN 'planned'
         ELSE 'none'
       END AS cost_source
  FROM tech_card_ingredients tci
  LEFT JOIN inventory_items ii ON ii.id = tci.inventory_item_id;
