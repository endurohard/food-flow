#!/usr/bin/env bash
# ============================================================
# Проверка техкарт и автосписания на боевом сервере
# ============================================================
# ТОЛЬКО ЧТЕНИЕ. Скрипт ничего не меняет: ни остатков, ни заказов,
# ни схемы. Безопасно запускать на работающем проде в любое время.
#
# Проверяет по порядку:
#   1. схема готова (миграции применены)
#   2. техкарты заполнены и связаны с меню
#   3. автосписание включено и настроено
#   4. списания реально происходят (по журналу движений)
#
# Использование:
#   ./scripts/check-techcards-prod.sh                      # через docker
#   PG_CONTAINER=food-flow-postgres ./scripts/check-techcards-prod.sh
#   DATABASE_URL=postgresql://... ./scripts/check-techcards-prod.sh
# ============================================================
set -uo pipefail

PG_USER="${POSTGRES_USER:-foodflow}"
PG_DB="${POSTGRES_DB:-foodflow}"

if [[ -n "${DATABASE_URL:-}" ]]; then
  q() { psql "$DATABASE_URL" -t -A -F'|' -c "$1" 2>&1; }
  TARGET="DATABASE_URL"
else
  CONTAINER="${PG_CONTAINER:-food-flow-postgres}"
  if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    echo "ОШИБКА: контейнер $CONTAINER не запущен." >&2
    echo "Укажите PG_CONTAINER=<имя> или DATABASE_URL=<строка>." >&2
    exit 1
  fi
  q() { docker exec -i "$CONTAINER" psql -t -A -F'|' -U "$PG_USER" -d "$PG_DB" -c "$1" 2>&1; }
  TARGET="контейнер $CONTAINER"
fi

echo "Проверяю техкарты: $TARGET"
echo

PROBLEMS=0
note() { echo "   $1"; }
bad()  { echo "   [ПРОБЛЕМА] $1"; PROBLEMS=$((PROBLEMS+1)); }
ok()   { echo "   [ок] $1"; }

# ── 1. Схема ────────────────────────────────────────────────
echo "1. СХЕМА"

for t in tech_cards tech_card_ingredients inventory_items inventory_batches; do
  n=$(q "SELECT count(*) FROM information_schema.tables WHERE table_name='$t'")
  [[ "$n" == "1" ]] && ok "таблица $t есть" || bad "таблица $t ОТСУТСТВУЕТ — миграции не применены"
done

# Миграция 020 сняла NOT NULL с menu_item_id: без этого полуфабрикаты невозможны
nullable=$(q "SELECT is_nullable FROM information_schema.columns
              WHERE table_name='tech_cards' AND column_name='menu_item_id'")
if [[ "$nullable" == "YES" ]]; then
  ok "menu_item_id допускает NULL (полуфабрикаты поддерживаются)"
elif [[ -z "$nullable" ]]; then
  bad "колонки tech_cards.menu_item_id нет"
else
  bad "menu_item_id NOT NULL — миграция 020 не применена, свой соус как ингредиент невозможен"
fi

for c in output_item_id output_quantity; do
  n=$(q "SELECT count(*) FROM information_schema.columns
         WHERE table_name='tech_cards' AND column_name='$c'")
  [[ "$n" == "1" ]] && ok "tech_cards.$c есть" || bad "tech_cards.$c нет — производство полуфабрикатов не работает"
done

echo
echo "   применённые миграции (последние 5):"
q "SELECT filename FROM migration_history ORDER BY filename DESC LIMIT 5" | sed 's/^/     /'
total_mig=$(q "SELECT count(*) FROM migration_history")
note "всего учтено миграций: $total_mig"
echo

# ── 2. Данные техкарт ───────────────────────────────────────
echo "2. ТЕХКАРТЫ"

tc=$(q "SELECT count(*) FROM tech_cards")
note "всего техкарт: $tc"
if [[ "$tc" == "0" ]]; then
  bad "техкарт нет вообще — списывать нечего по определению"
fi

q "SELECT
     'блюд с техкартой: '||count(*) FILTER (WHERE menu_item_id IS NOT NULL),
     'полуфабрикатов: '||count(*) FILTER (WHERE output_item_id IS NOT NULL)
   FROM tech_cards" | tr '|' '\n' | sed 's/^/   /'

empty=$(q "SELECT count(*) FROM tech_cards tc
           WHERE NOT EXISTS (SELECT 1 FROM tech_card_ingredients i WHERE i.tech_card_id = tc.id)")
if [[ "$empty" == "0" ]]; then
  ok "техкарт без ингредиентов нет"
else
  bad "техкарт без ингредиентов: $empty — при продаже не спишется ничего"
  q "SELECT '     пустая: '||coalesce(name,id::text) FROM tech_cards tc
     WHERE NOT EXISTS (SELECT 1 FROM tech_card_ingredients i WHERE i.tech_card_id = tc.id)
     LIMIT 5"
fi

# Блюда, которые продаются, но техкарты не имеют: тихая утечка себестоимости
no_tc=$(q "SELECT count(*) FROM menu_items m
           WHERE m.is_available = true
             AND NOT EXISTS (SELECT 1 FROM tech_cards tc WHERE tc.menu_item_id = m.id)")
if [[ "$no_tc" == "0" ]]; then
  ok "у всех доступных блюд есть техкарта"
else
  note "доступных блюд без техкарты: $no_tc (их продажа склад не уменьшает)"
  q "SELECT '     без техкарты: '||name FROM menu_items m
     WHERE m.is_available = true
       AND NOT EXISTS (SELECT 1 FROM tech_cards tc WHERE tc.menu_item_id = m.id)
     LIMIT 5"
fi

# Склад пуст целиком — техкарты строить не на чем. Проверяем до остальных
# выводов, иначе «все ингредиенты в наличии» звучит как успех на пустой базе.
items_total=$(q "SELECT count(*) FROM inventory_items")
wh_total=$(q "SELECT count(*) FROM warehouses")
if [[ "$wh_total" == "0" ]]; then
  bad "складов не создано ни одного — приёмка и списание невозможны"
elif [[ "$items_total" == "0" ]]; then
  bad "номенклатуры на складе нет — техкарту составлять не из чего"
else
  note "складов: $wh_total, номенклатуры: $items_total"
fi

# Ингредиент есть в техкарте, но на складе его нет ни одной партией
no_stock=$(q "SELECT count(DISTINCT i.inventory_item_id)
              FROM tech_card_ingredients i
              WHERE coalesce(i.is_optional,false) = false
                AND NOT EXISTS (
                  SELECT 1 FROM inventory_batches b
                  WHERE b.inventory_item_id = i.inventory_item_id
                    AND b.is_depleted = false AND b.quantity > 0)")
ing_total=$(q "SELECT count(*) FROM tech_card_ingredients")
if [[ "$ing_total" == "0" ]]; then
  note "ингредиентов в техкартах нет — проверять наличие нечего"
elif [[ "$no_stock" == "0" ]]; then
  ok "все обязательные ингредиенты есть в наличии"
else
  bad "обязательных ингредиентов без остатка: $no_stock — продажа упрётся в нехватку"
  q "SELECT '     нет на складе: '||ii.name
     FROM tech_card_ingredients i
     JOIN inventory_items ii ON ii.id = i.inventory_item_id
     WHERE coalesce(i.is_optional,false) = false
       AND NOT EXISTS (
         SELECT 1 FROM inventory_batches b
         WHERE b.inventory_item_id = i.inventory_item_id
           AND b.is_depleted = false AND b.quantity > 0)
     LIMIT 5"
fi

# Партии без себестоимости: FIFO посчитает прибыль неверно
zero_cost=$(q "SELECT count(*) FROM inventory_batches
               WHERE is_depleted = false AND (cost_price IS NULL OR cost_price = 0)")
batches_total=$(q "SELECT count(*) FROM inventory_batches WHERE is_depleted = false")
if [[ "$batches_total" == "0" ]]; then
  note "активных партий нет — себестоимость проверять не на чем"
elif [[ "$zero_cost" == "0" ]]; then
  ok "у всех активных партий задана себестоимость"
else
  bad "активных партий с нулевой себестоимостью: $zero_cost — прибыль считается неверно"
fi
echo

# ── 3. Настройка автосписания ───────────────────────────────
echo "3. АВТОСПИСАНИЕ"

if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -qx order-service; then
  for v in AUTO_DEDUCT_STOCK INVENTORY_SERVICE_URL; do
    val=$(docker exec order-service printenv "$v" 2>/dev/null)
    if [[ -z "$val" ]]; then
      [[ "$v" == "AUTO_DEDUCT_STOCK" ]] \
        && note "$v не задан (по умолчанию включено)" \
        || bad "$v не задан — order-service не найдёт склад"
    else
      ok "$v = $val"
    fi
  done
  # Значение секрета не печатаем, только факт наличия
  if docker exec order-service printenv INTERNAL_TOKEN 2>/dev/null | grep -q .; then
    ok "INTERNAL_TOKEN задан"
  else
    bad "INTERNAL_TOKEN ПУСТ — списание молча не работает, в логах только warning"
  fi
  if docker exec inventory-service printenv INTERNAL_TOKEN 2>/dev/null | grep -q .; then
    ok "INTERNAL_TOKEN задан и в inventory-service"
  else
    bad "в inventory-service INTERNAL_TOKEN пуст — запрос списания будет отклонён"
  fi
else
  note "контейнеры сервисов недоступны отсюда — проверьте вручную:"
  note "  docker exec order-service printenv AUTO_DEDUCT_STOCK INVENTORY_SERVICE_URL"
  note "  docker exec order-service printenv INTERNAL_TOKEN | head -c 4"
fi
echo

# ── 4. Списания происходят на самом деле ────────────────────
echo "4. ФАКТИЧЕСКИЕ СПИСАНИЯ (за 7 дней)"

closed=$(q "SELECT count(*) FROM orders
            WHERE status IN ('completed','delivered') AND created_at > NOW() - INTERVAL '7 days'")
note "закрытых заказов: $closed"

# Списание по техкарте пишет в stock_movements тип 'sale' с reference_type='order'
moves=$(q "SELECT count(*) FROM stock_movements
           WHERE movement_type = 'sale' AND reference_type = 'order'
             AND created_at > NOW() - INTERVAL '7 days'")
note "списаний по заказам: $moves"

# Сколько именно заказов реально отразилось на складе
covered=$(q "SELECT count(DISTINCT reference_id) FROM stock_movements
             WHERE movement_type = 'sale' AND reference_type = 'order'
               AND created_at > NOW() - INTERVAL '7 days'")
note "заказов, затронувших склад: $covered из $closed"

if [[ "$closed" != "0" && "$moves" == "0" ]]; then
  # Разделяем две совершенно разные причины: сломанное списание и
  # отсутствие техкарт. Иначе проверка врёт на новой базе.
  with_tc=$(q "SELECT count(DISTINCT o.id)
               FROM orders o
               JOIN order_items oi ON oi.order_id = o.id
               JOIN tech_cards tc ON tc.menu_item_id = oi.menu_item_id
               WHERE o.status IN ('completed','delivered')
                 AND o.created_at > NOW() - INTERVAL '7 days'")
  if [[ "$with_tc" == "0" ]]; then
    note "ни в одном закрытом заказе не было блюд с техкартой"
    note "списывать было нечего — это не поломка, а отсутствие техкарт"
  else
    bad "закрыто $with_tc заказов с блюдами по техкартам, а склад не двигался — списание НЕ работает"
  fi
elif [[ "$closed" != "0" && "$covered" != "$closed" ]]; then
  note "часть заказов склад не затронула — нормально, если в них блюда без техкарт"
  ok "автосписание работает ($covered заказов списано)"
elif [[ "$closed" != "0" ]]; then
  ok "заказы закрываются и склад двигается"
else
  note "закрытых заказов за период нет — вывод сделать нельзя"
fi

echo
echo "   последние 5 списаний:"
q "SELECT '     '||to_char(sm.created_at,'DD.MM HH24:MI')||'  '||ii.name||'  -'||sm.quantity||' '||coalesce(ii.unit,'')
   FROM stock_movements sm
   JOIN inventory_items ii ON ii.id = sm.inventory_item_id
   WHERE sm.movement_type = 'sale' AND sm.reference_type = 'order'
   ORDER BY sm.created_at DESC LIMIT 5"
echo

echo "─────────────────────────────────────────────"
if [[ "$PROBLEMS" == "0" ]]; then
  echo "ИТОГ: проблем не найдено."
else
  echo "ИТОГ: проблем найдено — $PROBLEMS (см. пометки [ПРОБЛЕМА] выше)."
fi
echo
echo "Ничего не изменено: скрипт только читает."
exit 0
