#!/usr/bin/env python3
"""Что держит 7 дублей «ТЕСТ зерно v033» — только осмотр, без удаления."""
import subprocess

PG = "food-flow-postgres"


def psql(sql):
    r = subprocess.run(["docker", "exec", "-i", PG, "psql", "-U", "foodflow", "-d", "foodflow", "-c", sql],
                       capture_output=True, text=True)
    return (r.stdout or "") + (r.stderr or "")


print(psql("""
with t as (select id from inventory_items where name ilike '%ТЕСТ зерно v033%')
select
  (select count(*) from t) as items,
  (select count(*) from inventory_stock  s  where s.inventory_item_id  in (select id from t)) as stock_rows,
  (select coalesce(sum(s.quantity),0) from inventory_stock s where s.inventory_item_id in (select id from t)) as stock_qty,
  (select count(*) from inventory_batches b where b.inventory_item_id  in (select id from t)) as batches,
  (select count(*) from stock_movements  m  where m.inventory_item_id  in (select id from t)) as movements,
  (select count(*) from tech_card_ingredients i where i.inventory_item_id in (select id from t)) as techcard_rows,
  (select count(*) from supply_invoice_items si where si.inventory_item_id in (select id from t)) as invoice_rows,
  (select count(*) from wholesale_order_items wo where wo.inventory_item_id in (select id from t)) as wholesale_rows
"""))

print("--- техкарты, где эти позиции участвуют ---")
print(psql("""
select tc.id, tc.name, tc.is_active, mi.name as menu_item
  from tech_card_ingredients i
  join tech_cards tc on tc.id = i.tech_card_id
  left join menu_items mi on mi.id = tc.menu_item_id
 where i.inventory_item_id in (select id from inventory_items where name ilike '%ТЕСТ зерно v033%')
"""))

print("--- прочие тестовые хвосты в номенклатуре ---")
print(psql("""
select name, count(*), min(created_at)::date as first, max(created_at)::date as last
  from inventory_items
 where name ~* '(тест|test|проба|LRT|демо)'
 group by name order by 2 desc, 1
"""))

print("--- тестовые техкарты и блюда ---")
print(psql("""
select 'tech_cards' as t, name, created_at::date from tech_cards where name ~* '(тест|test|проба)'
union all
select 'menu_items', name, created_at::date from menu_items where name ~* '(тест|test|проба)'
order by 1, 3
"""))
