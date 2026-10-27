#!/usr/bin/env bash
# Накат миграции 045 (изоляция складов по предприятиям) на БОЕВУЮ базу.
#
# Миграция переносит боевые остатки с чужого склада на склад владельца.
# Перед накатом — отдельный бэкап: обычный выкат мог быть давно.
# Все проверки «до» и «после» в одном прогоне, чтобы было с чем сравнить.
set -uo pipefail
PG=food-flow-postgres
TS="$(date +%F_%H%M%S)"
cd ~/food-flow

q() { docker exec "$PG" psql -U foodflow -d foodflow "$@"; }

echo "===== 0. Бэкап перед правкой остатков"
mkdir -p ~/backups/food-flow
docker exec "$PG" pg_dump -U foodflow -d foodflow --clean --if-exists \
  > ~/backups/food-flow/pre_045_${TS}.sql || { echo "ПРОВАЛ: бэкап не снят"; exit 1; }
ls -l ~/backups/food-flow/pre_045_${TS}.sql

echo
echo "===== 1. Состояние ДО"
q -c "SELECT e.name AS предприятие, count(*) AS позиций, round(sum(s.quantity),3) AS всего
        FROM inventory_stock s
        JOIN inventory_items i ON i.id=s.inventory_item_id
        JOIN enterprises e ON e.id=i.enterprise_id
       GROUP BY 1 ORDER BY 1;"
q -c "SELECT e.name AS владелец_склада, count(*) AS позиций, round(sum(s.quantity),3) AS всего
        FROM inventory_stock s
        JOIN warehouses w ON w.id=s.warehouse_id
        JOIN enterprises e ON e.id=w.enterprise_id
       GROUP BY 1 ORDER BY 1;"

echo
echo "===== 2. Накат через штатный раннер (с записью в журнал миграций)"
PG_CONTAINER="$PG" bash scripts/migrate.sh --docker 2>&1 | tail -20

echo
echo "===== 3. Миграция учтена в журнале"
q -t -A -c "SELECT filename FROM migration_history ORDER BY applied_at DESC LIMIT 3;"

echo
echo "===== 4. Состояние ПОСЛЕ"
echo "--- чужих строк должно быть 0"
q -c "SELECT
  (SELECT count(*) FROM inventory_stock s JOIN warehouses w ON w.id=s.warehouse_id
    JOIN inventory_items i ON i.id=s.inventory_item_id WHERE w.enterprise_id<>i.enterprise_id) AS остатки,
  (SELECT count(*) FROM inventory_batches b JOIN warehouses w ON w.id=b.warehouse_id
    JOIN inventory_items i ON i.id=b.inventory_item_id WHERE w.enterprise_id<>i.enterprise_id) AS партии,
  (SELECT count(*) FROM stock_movements m JOIN warehouses w ON w.id=m.warehouse_id
    JOIN inventory_items i ON i.id=m.inventory_item_id WHERE w.enterprise_id<>i.enterprise_id) AS движения;"

echo "--- товар по предприятию НЕ изменился (ничего не потеряно)"
q -c "SELECT e.name AS предприятие, count(*) AS позиций, round(sum(s.quantity),3) AS всего
        FROM inventory_stock s
        JOIN inventory_items i ON i.id=s.inventory_item_id
        JOIN enterprises e ON e.id=i.enterprise_id
       GROUP BY 1 ORDER BY 1;"

echo "--- по складу: чужой товар ушёл к владельцу"
q -c "SELECT e.name AS владелец_склада, count(*) AS позиций, round(sum(s.quantity),3) AS всего
        FROM inventory_stock s
        JOIN warehouses w ON w.id=s.warehouse_id
        JOIN enterprises e ON e.id=w.enterprise_id
       GROUP BY 1 ORDER BY 1;"

echo
echo "===== 5. Триггеры на боевой базе"
q -c "SELECT tgname, relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
       WHERE NOT tgisinternal AND (tgname LIKE '%same_tenant%' OR tgname LIKE '%tenant_matches%')
       ORDER BY relname, tgname;"

echo "===== ГОТОВО"
