#!/usr/bin/env python3
"""Чем опасны тестовые техкарты «ТЕСТ Капучино» — осмотр без изменений."""
import subprocess

PG = "food-flow-postgres"


def psql(sql):
    r = subprocess.run(["docker", "exec", "-i", PG, "psql", "-U", "foodflow", "-d", "foodflow", "-c", sql],
                       capture_output=True, text=True)
    return (r.stdout or "") + (r.stderr or "")


print("--- ВСЕ техкарты блюда «Капучино»: какая действует сейчас ---")
print(psql("""
select tc.id, tc.name, tc.is_active, tc.effective_from, tc.effective_to,
       e.name as enterprise, mi.name as menu_item
  from tech_cards tc
  left join menu_items mi on mi.id = tc.menu_item_id
  left join enterprises e on e.id = tc.enterprise_id
 where tc.menu_item_id in (select menu_item_id from tech_cards where name ilike '%ТЕСТ Капучино%')
 order by tc.effective_from nulls first, tc.created_at
"""))

print("--- состав тестовых техкарт ---")
print(psql("""
select tc.name as card, ii.name as ingredient, i.quantity, i.unit
  from tech_card_ingredients i
  join tech_cards tc on tc.id = i.tech_card_id
  join inventory_items ii on ii.id = i.inventory_item_id
 where tc.name ilike '%ТЕСТ Капучино%'
 order by tc.name, ii.name
"""))

print("--- есть ли у блюда «Капучино» НЕтестовая активная карта ---")
print(psql("""
select count(*) filter (where name not ilike '%ТЕСТ%' and is_active) as real_active,
       count(*) filter (where name ilike '%ТЕСТ%' and is_active) as test_active
  from tech_cards
 where menu_item_id in (select menu_item_id from tech_cards where name ilike '%ТЕСТ Капучино%')
"""))

print("--- продавалось ли это блюдо (списания по тестовым картам) ---")
print(psql("""
select m.movement_type, count(*), sum(m.quantity) as qty, max(m.created_at) as last
  from stock_movements m
 where m.inventory_item_id in (select id from inventory_items where name ilike '%ТЕСТ зерно%')
 group by 1 order by 1
"""))

print("--- остаток LRT-товар (хвост прошлой сессии) ---")
print(psql("""
select ii.id, ii.name, ii.created_at,
       (select count(*) from inventory_stock s where s.inventory_item_id = ii.id) as stock_rows,
       (select coalesce(sum(s.quantity),0) from inventory_stock s where s.inventory_item_id = ii.id) as qty,
       (select count(*) from inventory_batches b where b.inventory_item_id = ii.id) as batches,
       (select count(*) from stock_movements m where m.inventory_item_id = ii.id) as movements,
       (select count(*) from wholesale_order_items w where w.inventory_item_id = ii.id) as wholesale_rows,
       (select count(*) from tech_card_ingredients t where t.inventory_item_id = ii.id) as techcard_rows
  from inventory_items ii where ii.name ilike 'LRT%'
"""))

print("--- тестовые контрагенты/заказы/возвраты ---")
print(psql("""
select 'counterparties' as t, name, created_at::date from counterparties where name ~* '(LRT|тест|test|проба)'
union all
select 'wholesale_orders', coalesce(notes,'(нет)'), created_at::date from wholesale_orders where notes ~* '(LRT|тест|test|проба)'
union all
select 'wholesale_returns', coalesce(reason,'(нет)'), created_at::date from wholesale_returns where reason ~* '(LRT|тест|test|проба)'
order by 1
"""))
