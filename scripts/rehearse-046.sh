#!/usr/bin/env bash
# Репетиция миграции 046 (promotions → enterprise_id) на КОПИИ боевой базы.
# Копия только дампом: TEMPLATE на работающей базе падает.
set -uo pipefail
PG=food-flow-postgres
REH=ff_reh046
SQL=/tmp/046_promotions_enterprise.sql

d() { docker exec "$PG" psql -U foodflow -d "$REH" "$@"; }

echo "===== 0. Копия"
docker exec "$PG" psql -U foodflow -d postgres -c "DROP DATABASE IF EXISTS $REH" >/dev/null 2>&1
docker exec "$PG" psql -U foodflow -d postgres -c "CREATE DATABASE $REH" >/dev/null
docker exec "$PG" sh -c "pg_dump -U foodflow -d foodflow | psql -q -U foodflow -d $REH" >/dev/null 2>&1
echo "копия $REH готова"

echo
echo "===== 1. Схема promotions ДО"
d -c "SELECT column_name FROM information_schema.columns
       WHERE table_name='promotions' AND column_name IN
       ('enterprise_id','restaurant_id','conditions','valid_from','valid_until','used_count','usage_count','start_date','end_date')
       ORDER BY column_name;"
echo "--- строк в таблице:"
d -t -A -c "SELECT count(*) FROM promotions;"

echo
echo "===== 2. Подкладываем строку старого формата: перенос данных обязан сработать"
d -t -A -c "
INSERT INTO promotions (restaurant_id, name, promo_type, discount_value,
                        start_date, end_date, usage_count, usage_limit, promo_code, is_active)
SELECT r.id, 'РЕПЕТИЦИЯ старая акция', 'percentage', 15,
       '2026-01-01', '2026-12-31', 3, 10, 'REH046', true
  FROM restaurants r LIMIT 1
RETURNING id;" | tail -1

echo
echo "===== 3. Накат 046"
docker exec -i "$PG" psql -U foodflow -d "$REH" -v ON_ERROR_STOP=1 < "$SQL" 2>&1 | tail -20
echo "КОД НАКАТА=$?"

echo
echo "===== 4. Схема ПОСЛЕ: нужные колонки появились"
d -c "SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name='promotions' AND column_name IN
       ('enterprise_id','restaurant_id','conditions','valid_from','valid_until','used_count','start_date','end_date')
       ORDER BY column_name;"

echo "===== 5. Данные перенесены: enterprise_id, период и счётчик"
d -c "SELECT name, enterprise_id IS NOT NULL AS тенант_задан,
             valid_from IS NOT NULL AS период_перенесён,
             used_count, usage_count
        FROM promotions WHERE name LIKE 'РЕПЕТИЦИЯ%';"

echo "===== 6. Предприятие совпадает с предприятием точки"
d -c "SELECT (p.enterprise_id = r.enterprise_id) AS совпадает
        FROM promotions p JOIN restaurants r ON r.id = p.restaurant_id
       WHERE p.name LIKE 'РЕПЕТИЦИЯ%';"

echo
echo "===== 7. Ограничения работают"
echo "--- дубль промокода внутри предприятия обязан падать по имени индекса"
d -c "
DO \$\$
DECLARE ent UUID;
BEGIN
  SELECT enterprise_id INTO ent FROM promotions WHERE name LIKE 'РЕПЕТИЦИЯ%' LIMIT 1;
  BEGIN
    INSERT INTO promotions (enterprise_id, name, promo_type, discount_value, promo_code, is_active)
    VALUES (ent, 'РЕПЕТИЦИЯ дубль', 'percentage', 5, 'REH046', true);
    RAISE NOTICE 'ПЛОХО: дубль промокода прошёл';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'ХОРОШО, дубль поймал: %', SQLERRM;
  END;
END \$\$;"

echo "--- тот же код у ДРУГОГО предприятия обязан проходить"
d -c "
DO \$\$
DECLARE other UUID; pid UUID;
BEGIN
  SELECT e.id INTO other FROM enterprises e
   WHERE e.id <> (SELECT enterprise_id FROM promotions WHERE name LIKE 'РЕПЕТИЦИЯ%' LIMIT 1)
   LIMIT 1;
  IF other IS NULL THEN RAISE NOTICE 'ПРОВЕРКА НЕ СОСТОЯЛАСЬ: нет второго предприятия'; RETURN; END IF;
  BEGIN
    INSERT INTO promotions (enterprise_id, name, promo_type, discount_value, promo_code, is_active)
    VALUES (other, 'РЕПЕТИЦИЯ чужое предприятие', 'percentage', 5, 'REH046', true)
    RETURNING id INTO pid;
    RAISE NOTICE 'ХОРОШО: тот же код у другого предприятия разрешён';
    DELETE FROM promotions WHERE id = pid;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'ПЛОХО: код занят глобально: %', SQLERRM;
  END;
END \$\$;"

echo "--- перевёрнутый период обязан падать"
d -c "
DO \$\$
DECLARE ent UUID;
BEGIN
  SELECT enterprise_id INTO ent FROM promotions WHERE name LIKE 'РЕПЕТИЦИЯ%' LIMIT 1;
  BEGIN
    INSERT INTO promotions (enterprise_id, name, promo_type, discount_value, valid_from, valid_until)
    VALUES (ent, 'РЕПЕТИЦИЯ период', 'percentage', 5, '2026-12-31', '2026-01-01');
    RAISE NOTICE 'ПЛОХО: перевёрнутый период прошёл';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'ХОРОШО, период поймал: %', SQLERRM;
  END;
END \$\$;"

echo "--- вставка в формате КОДА (без restaurant_id) обязана проходить"
d -c "
DO \$\$
DECLARE ent UUID; pid UUID;
BEGIN
  SELECT id INTO ent FROM enterprises LIMIT 1;
  BEGIN
    INSERT INTO promotions
      (enterprise_id, name, promo_type, discount_value, conditions, promo_code,
       usage_limit, valid_from, valid_until, is_active)
    VALUES (ent, 'РЕПЕТИЦИЯ из кода', 'percentage', 10, '{}'::jsonb, NULL,
            NULL, NULL, NULL, true)
    RETURNING id INTO pid;
    RAISE NOTICE 'ХОРОШО: вставка в формате кода прошла';
    DELETE FROM promotions WHERE id = pid;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'ПЛОХО: код не может вставить акцию: %', SQLERRM;
  END;
END \$\$;"

echo
echo "===== 8. Повторный накат (идемпотентность)"
docker exec -i "$PG" psql -U foodflow -d "$REH" -v ON_ERROR_STOP=1 < "$SQL" >/dev/null 2>&1
echo "код повторного наката=$?"

echo
echo "===== 9. Уборка"
docker exec "$PG" psql -U foodflow -d postgres -c "DROP DATABASE IF EXISTS $REH" >/dev/null
echo "копия удалена"
