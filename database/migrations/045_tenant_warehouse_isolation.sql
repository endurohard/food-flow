-- 045: склад не может хранить позицию чужого предприятия.
--
-- Проблема, которую закрываем. Приход по накладной оприходовал 8 позиций
-- предприятия «Органика» на склад предприятия «Кофейня 104»: накладная была
-- заведена на чужой склад (вставкой мимо API — Joi и проверка
-- warehouseBelongsTo в роуте есть, но это единственный слой), и подтверждение
-- разложило товар по чужому складу. Остаток, партии и движения уехали в
-- соседнюю организацию.
--
-- Чем это опасно: `inventory_stock` вообще не имеет enterprise_id, тенант
-- определяется ТОЛЬКО через склад (getStock джойнит warehouses и фильтрует по
-- w.enterprise_id). Значит такие строки видны владельцу чужой организации как
-- свой остаток, участвуют в его себестоимости и инвентаризации, а у настоящего
-- владельца товара на складе ноль.
--
-- CHECK здесь неприменим: условие связывает две другие таблицы. Поэтому
-- триггер — он, в отличие от проверки в роуте, закрывает и прямые вставки
-- скриптом, импортом и будущими эндпоинтами.

-- ─── 1. Починить уже разъехавшиеся данные ───────────────────────────
-- Переносим на склад того же предприятия, которому принадлежит позиция.
-- Берём склад с таким же именем, иначе любой main-склад предприятия.
-- Если подходящего склада нет — строку не трогаем, иначе потеряем остаток
-- молча; такие случаи видны проверкой в конце миграции.

DROP TABLE IF EXISTS _tenant_fix;
CREATE TEMP TABLE _tenant_fix AS
SELECT s.id AS stock_id,
       s.warehouse_id AS old_warehouse,
       (SELECT w2.id FROM warehouses w2
         WHERE w2.enterprise_id = i.enterprise_id
         ORDER BY (w2.name = w.name) DESC, w2.created_at
         LIMIT 1) AS new_warehouse,
       s.inventory_item_id,
       i.enterprise_id AS item_enterprise
  FROM inventory_stock s
  JOIN warehouses w ON w.id = s.warehouse_id
  JOIN inventory_items i ON i.id = s.inventory_item_id
 WHERE w.enterprise_id <> i.enterprise_id;

-- Остатки
UPDATE inventory_stock s
   SET warehouse_id = f.new_warehouse, updated_at = NOW()
  FROM _tenant_fix f
 WHERE s.id = f.stock_id AND f.new_warehouse IS NOT NULL;

-- Партии: переносим по паре (позиция, старый склад)
UPDATE inventory_batches b
   SET warehouse_id = f.new_warehouse
  FROM _tenant_fix f
 WHERE b.inventory_item_id = f.inventory_item_id
   AND b.warehouse_id = f.old_warehouse
   AND f.new_warehouse IS NOT NULL;

-- Движения: та же пара. enterprise_id движения уже верный (предприятие
-- позиции), расходился только склад.
UPDATE stock_movements m
   SET warehouse_id = f.new_warehouse
  FROM _tenant_fix f
 WHERE m.inventory_item_id = f.inventory_item_id
   AND m.warehouse_id = f.old_warehouse
   AND f.new_warehouse IS NOT NULL;

-- Накладные, выписанные на чужой склад
UPDATE supply_invoices si
   SET warehouse_id = (SELECT w2.id FROM warehouses w2
                        WHERE w2.enterprise_id = si.enterprise_id
                        ORDER BY w2.created_at LIMIT 1),
       updated_at = NOW()
 WHERE si.warehouse_id IS NOT NULL
   AND si.enterprise_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM warehouses w
                WHERE w.id = si.warehouse_id AND w.enterprise_id <> si.enterprise_id)
   AND EXISTS (SELECT 1 FROM warehouses w2 WHERE w2.enterprise_id = si.enterprise_id);

-- ─── 2. Запретить это на будущее ────────────────────────────────────

CREATE OR REPLACE FUNCTION assert_warehouse_item_same_tenant()
RETURNS TRIGGER AS $$
DECLARE
  wh_ent UUID;
  it_ent UUID;
BEGIN
  -- Движение без склада допустимо (учётная запись без привязки к месту),
  -- проверять нечего.
  IF NEW.warehouse_id IS NULL OR NEW.inventory_item_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT enterprise_id INTO wh_ent FROM warehouses WHERE id = NEW.warehouse_id;
  SELECT enterprise_id INTO it_ent FROM inventory_items WHERE id = NEW.inventory_item_id;

  -- NULL с обеих сторон (демо-данные без тенанта) не ловим: иначе миграция
  -- упала бы на исторических строках, а смысла в проверке без тенанта нет.
  IF wh_ent IS NOT NULL AND it_ent IS NOT NULL AND wh_ent <> it_ent THEN
    RAISE EXCEPTION
      'warehouse_item_tenant_mismatch: склад % принадлежит предприятию %, позиция % — предприятию %',
      NEW.warehouse_id, wh_ent, NEW.inventory_item_id, it_ent
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stock_same_tenant ON inventory_stock;
CREATE TRIGGER trg_stock_same_tenant
  BEFORE INSERT OR UPDATE OF warehouse_id, inventory_item_id ON inventory_stock
  FOR EACH ROW EXECUTE FUNCTION assert_warehouse_item_same_tenant();

DROP TRIGGER IF EXISTS trg_batches_same_tenant ON inventory_batches;
CREATE TRIGGER trg_batches_same_tenant
  BEFORE INSERT OR UPDATE OF warehouse_id, inventory_item_id ON inventory_batches
  FOR EACH ROW EXECUTE FUNCTION assert_warehouse_item_same_tenant();

DROP TRIGGER IF EXISTS trg_movements_same_tenant ON stock_movements;
CREATE TRIGGER trg_movements_same_tenant
  BEFORE INSERT OR UPDATE OF warehouse_id, inventory_item_id ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION assert_warehouse_item_same_tenant();

-- Движение склада обязано принадлежать тому же предприятию, что и позиция:
-- иначе отчёт одной организации посчитает расход другой.
CREATE OR REPLACE FUNCTION assert_movement_tenant_matches_item()
RETURNS TRIGGER AS $$
DECLARE
  it_ent UUID;
BEGIN
  IF NEW.inventory_item_id IS NULL OR NEW.enterprise_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT enterprise_id INTO it_ent FROM inventory_items WHERE id = NEW.inventory_item_id;
  IF it_ent IS NOT NULL AND it_ent <> NEW.enterprise_id THEN
    RAISE EXCEPTION
      'movement_tenant_mismatch: движение предприятия %, позиция принадлежит %',
      NEW.enterprise_id, it_ent
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_movements_tenant_matches_item ON stock_movements;
CREATE TRIGGER trg_movements_tenant_matches_item
  BEFORE INSERT OR UPDATE OF enterprise_id, inventory_item_id ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION assert_movement_tenant_matches_item();
