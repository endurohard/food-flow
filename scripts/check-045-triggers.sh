#!/usr/bin/env bash
# Проверка триггеров изоляции 045 на копии боевой базы.
# Запускается НА СЕРВЕРЕ. Копия только дампом (TEMPLATE на живой базе падает).
set -uo pipefail
PG=food-flow-postgres
REH=ff_reh045c

docker exec "$PG" psql -U foodflow -d postgres -c "DROP DATABASE IF EXISTS $REH" >/dev/null 2>&1
docker exec "$PG" psql -U foodflow -d postgres -c "CREATE DATABASE $REH" >/dev/null
docker exec "$PG" sh -c "pg_dump -U foodflow -d foodflow | psql -q -U foodflow -d $REH" >/dev/null 2>&1
echo "копия $REH готова"

docker exec -i "$PG" psql -U foodflow -d "$REH" -v ON_ERROR_STOP=1 \
  < /tmp/045_tenant_warehouse_isolation.sql >/dev/null 2>&1
echo "миграция 045 накачена, код=$?"

echo
echo "===== Проверка триггеров"
docker exec -i "$PG" psql -U foodflow -d "$REH" < /tmp/check-045-triggers.sql 2>&1

echo
docker exec "$PG" psql -U foodflow -d postgres -c "DROP DATABASE IF EXISTS $REH" >/dev/null
echo "копия удалена"
