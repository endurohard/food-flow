-- Проверка: триггеры изоляции не мешают нормальной работе.
--
-- Прошлый прогон дал ложное «ПЛОХО»: вставлялась пара (склад, позиция),
-- которая уже есть в inventory_stock, и упиралась в уникальный индекс
-- inventory_stock_warehouse_id_inventory_item_id_key, а не в триггер.
-- Берём пару, которой ещё нет.

DO $$
DECLARE wh UUID; it UUID; sid UUID;
BEGIN
  SELECT w.id, i.id INTO wh, it
    FROM warehouses w
    JOIN inventory_items i ON i.enterprise_id = w.enterprise_id
   WHERE w.enterprise_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM inventory_stock s
                      WHERE s.warehouse_id = w.id AND s.inventory_item_id = i.id)
   LIMIT 1;
  IF wh IS NULL THEN
    RAISE NOTICE 'ПРОВЕРКА НЕ СОСТОЯЛАСЬ: нет свободной пары своих';
    RETURN;
  END IF;
  BEGIN
    INSERT INTO inventory_stock (warehouse_id, inventory_item_id, quantity)
    VALUES (wh, it, 1) RETURNING id INTO sid;
    RAISE NOTICE 'ХОРОШО: своя вставка прошла, триггер работе не мешает';
    DELETE FROM inventory_stock WHERE id = sid;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'ПЛОХО: своя вставка не прошла: %', SQLERRM;
  END;
END $$;

-- Движение склада своего предприятия обязано проходить
DO $$
DECLARE wh UUID; it UUID; ent UUID; uid UUID; mid UUID;
BEGIN
  SELECT w.id, i.id, w.enterprise_id INTO wh, it, ent
    FROM warehouses w JOIN inventory_items i ON i.enterprise_id = w.enterprise_id
   WHERE w.enterprise_id IS NOT NULL LIMIT 1;
  SELECT id INTO uid FROM users WHERE enterprise_id = ent LIMIT 1;
  IF uid IS NULL THEN
    RAISE NOTICE 'ПРОВЕРКА НЕ СОСТОЯЛАСЬ: нет пользователя предприятия (performed_by — FK)';
    RETURN;
  END IF;
  BEGIN
    INSERT INTO stock_movements
      (enterprise_id, warehouse_id, inventory_item_id, movement_type, quantity, performed_by)
    VALUES (ent, wh, it, 'in', 1, uid) RETURNING id INTO mid;
    RAISE NOTICE 'ХОРОШО: своё движение прошло';
    DELETE FROM stock_movements WHERE id = mid;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'ПЛОХО: своё движение не прошло: %', SQLERRM;
  END;
END $$;

-- Движение с чужим тенантом обязано падать по имени ограничения
DO $$
DECLARE wh UUID; it UUID; other_ent UUID; uid UUID;
BEGIN
  SELECT w.id, i.id, w.enterprise_id INTO wh, it, other_ent
    FROM warehouses w JOIN inventory_items i ON i.enterprise_id <> w.enterprise_id
   WHERE w.enterprise_id IS NOT NULL AND i.enterprise_id IS NOT NULL LIMIT 1;
  SELECT id INTO uid FROM users WHERE enterprise_id = other_ent LIMIT 1;
  IF wh IS NULL OR uid IS NULL THEN
    RAISE NOTICE 'ПРОВЕРКА НЕ СОСТОЯЛАСЬ: не нашлось чужой пары';
    RETURN;
  END IF;
  BEGIN
    INSERT INTO stock_movements
      (enterprise_id, warehouse_id, inventory_item_id, movement_type, quantity, performed_by)
    VALUES (other_ent, wh, it, 'in', 1, uid);
    RAISE NOTICE 'ПЛОХО: движение с чужой позицией прошло, триггер НЕ сработал';
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'ХОРОШО, триггер поймал движение: %', SQLERRM;
  END;
END $$;
