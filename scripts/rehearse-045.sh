#!/usr/bin/env bash
# Репетиция миграции 045 на КОПИИ боевой базы.
#
# Миграция правит боевые остатки (переносит товар с чужого склада на свой),
# поэтому накат вслепую недопустим: сначала повторяем всё на копии и смотрим,
# что остатки не потерялись, не склеились и не упёрлись в уникальный индекс.
#
# Копия только дампом: CREATE DATABASE ... TEMPLATE на работающей базе всегда
# падает с «source database is being accessed by other users».
set -uo pipefail

PG=food-flow-postgres
REH=ff_reh045
SQL=~/food-flow/database/migrations/045_tenant_warehouse_isolation.sql

d() { docker exec "$PG" psql -U foodflow -d "$1" -v ON_ERROR_STOP=0 "${@:2}"; }

echo "===== 0. Чистая копия"
docker exec "$PG" psql -U foodflow -d postgres -c "DROP DATABASE IF EXISTS $REH" >/dev/null
docker exec "$PG" psql -U foodflow -d postgres -c "CREATE DATABASE $REH" >/dev/null
docker exec "$PG" sh -c "pg_dump -U foodflow -d foodflow | psql -q -U foodflow -d $REH" >/dev/null 2>&1
echo "копия $REH создана"

echo
echo "===== 1. Состояние ДО: чужие строки и остатки обеих сторон"
d $REH -c "
SELECT 'остатки на чужом складе' AS что, count(*) AS строк, sum(s.quantity) AS количество
  FROM inventory_stock s JOIN warehouses w ON w.id=s.warehouse_id
  JOIN inventory_items i ON i.id=s.inventory_item_id
 WHERE w.enterprise_id <> i.enterprise_id;"

d $REH -c "
SELECT e.name AS предприятие, count(*) AS позиций, round(sum(s.quantity),3) AS всего
  FROM inventory_stock s
  JOIN inventory_items i ON i.id=s.inventory_item_id
  JOIN enterprises e ON e.id=i.enterprise_id
 GROUP BY 1 ORDER BY 1;"

echo "--- итоги по предприятию ПО СКЛАДУ (то, что видит владелец на экране)"
d $REH -c "
SELECT e.name AS владелец_склада, count(*) AS позиций, round(sum(s.quantity),3) AS всего
  FROM inventory_stock s
  JOIN warehouses w ON w.id=s.warehouse_id
  JOIN enterprises e ON e.id=w.enterprise_id
 GROUP BY 1 ORDER BY 1;"

echo
echo "===== 2. РИСК: уникальные индексы, в которые может упереться перенос"
d $REH -c "
SELECT tablename, indexname, indexdef FROM pg_indexes
 WHERE tablename IN ('inventory_stock','inventory_batches')
   AND indexdef ILIKE '%UNIQUE%';"

echo "--- столкновения: у владельца УЖЕ есть строка по той же позиции на целевом складе?"
d $REH -c "
WITH f AS (
  SELECT s.id, s.inventory_item_id,
         (SELECT w2.id FROM warehouses w2
           WHERE w2.enterprise_id = i.enterprise_id
           ORDER BY (w2.name = w.name) DESC, w2.created_at LIMIT 1) AS new_wh
    FROM inventory_stock s
    JOIN warehouses w ON w.id=s.warehouse_id
    JOIN inventory_items i ON i.id=s.inventory_item_id
   WHERE w.enterprise_id <> i.enterprise_id)
SELECT count(*) AS столкновений
  FROM f JOIN inventory_stock s2
    ON s2.inventory_item_id = f.inventory_item_id
   AND s2.warehouse_id = f.new_wh
   AND s2.id <> f.id;"

echo
echo "===== 3. Накат миграции 045 на копию"
docker exec -i "$PG" psql -U foodflow -d $REH -v ON_ERROR_STOP=1 < "$SQL" 2>&1 | tail -25
echo "КОД НАКАТА=$?"

echo
echo "===== 4. Состояние ПОСЛЕ"
echo "--- чужих строк должно остаться 0"
d $REH -c "
SELECT (SELECT count(*) FROM inventory_stock s JOIN warehouses w ON w.id=s.warehouse_id
         JOIN inventory_items i ON i.id=s.inventory_item_id WHERE w.enterprise_id<>i.enterprise_id) AS остатки,
       (SELECT count(*) FROM inventory_batches b JOIN warehouses w ON w.id=b.warehouse_id
         JOIN inventory_items i ON i.id=b.inventory_item_id WHERE w.enterprise_id<>i.enterprise_id) AS партии,
       (SELECT count(*) FROM stock_movements m JOIN warehouses w ON w.id=m.warehouse_id
         JOIN inventory_items i ON i.id=m.inventory_item_id WHERE w.enterprise_id<>i.enterprise_id) AS движения;"

echo "--- количество товара по предприятию НЕ изменилось (ничего не потеряно)"
d $REH -c "
SELECT e.name AS предприятие, count(*) AS позиций, round(sum(s.quantity),3) AS всего
  FROM inventory_stock s
  JOIN inventory_items i ON i.id=s.inventory_item_id
  JOIN enterprises e ON e.id=i.enterprise_id
 GROUP BY 1 ORDER BY 1;"

echo "--- а вот итоги ПО СКЛАДУ обязаны измениться: чужой товар ушёл к владельцу"
d $REH -c "
SELECT e.name AS владелец_склада, count(*) AS позиций, round(sum(s.quantity),3) AS всего
  FROM inventory_stock s
  JOIN warehouses w ON w.id=s.warehouse_id
  JOIN enterprises e ON e.id=w.enterprise_id
 GROUP BY 1 ORDER BY 1;"

echo
echo "===== 5. Триггеры на месте"
d $REH -c "
SELECT tgname, relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
 WHERE NOT tgisinternal AND tgname LIKE '%same_tenant%' OR tgname LIKE '%tenant_matches%'
 ORDER BY relname, tgname;"

echo
echo "===== 6. Триггер ЛОВИТ новую попытку положить чужое (ожидаем ошибку по имени)"
d $REH -c "
DO \$\$
DECLARE wh UUID; it UUID;
BEGIN
  SELECT w.id INTO wh FROM warehouses w
    JOIN inventory_items i ON i.enterprise_id <> w.enterprise_id
   WHERE w.enterprise_id IS NOT NULL AND i.enterprise_id IS NOT NULL LIMIT 1;
  SELECT i.id INTO it FROM inventory_items i
    JOIN warehouses w ON w.id = wh
   WHERE i.enterprise_id <> w.enterprise_id LIMIT 1;
  IF wh IS NULL OR it IS NULL THEN
    RAISE NOTICE 'ПРОВЕРКА НЕ СОСТОЯЛАСЬ: не нашлось пары чужих склада и позиции';
  ELSE
    BEGIN
      INSERT INTO inventory_stock (warehouse_id, inventory_item_id, quantity)
      VALUES (wh, it, 1);
      RAISE NOTICE 'ПЛОХО: вставка чужого прошла, триггер НЕ сработал';
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'ХОРОШО, триггер поймал: %', SQLERRM;
    END;
  END IF;
END \$\$;"

echo "--- своё на свой склад по-прежнему можно (триггер не мешает работе)"
d $REH -c "
DO \$\$
DECLARE wh UUID; it UUID; sid UUID;
BEGIN
  SELECT w.id, i.id INTO wh, it FROM warehouses w
    JOIN inventory_items i ON i.enterprise_id = w.enterprise_id
   WHERE w.enterprise_id IS NOT NULL LIMIT 1;
  IF wh IS NULL THEN RAISE NOTICE 'ПРОВЕРКА НЕ СОСТОЯЛАСЬ: нет пары своих'; RETURN; END IF;
  BEGIN
    INSERT INTO inventory_stock (warehouse_id, inventory_item_id, quantity)
    VALUES (wh, it, 1) RETURNING id INTO sid;
    RAISE NOTICE 'ХОРОШО: своя вставка прошла';
    DELETE FROM inventory_stock WHERE id = sid;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'ПЛОХО: своя вставка не прошла: %', SQLERRM;
  END;
END \$\$;"

echo
echo "===== 7. Повторный накат миграции (идемпотентность)"
docker exec -i "$PG" psql -U foodflow -d $REH -v ON_ERROR_STOP=1 < "$SQL" >/dev/null 2>&1
echo "повторный накат, код=$?"

echo
echo "===== 8. Уборка копии"
docker exec "$PG" psql -U foodflow -d postgres -c "DROP DATABASE IF EXISTS $REH" >/dev/null
echo "копия удалена"
