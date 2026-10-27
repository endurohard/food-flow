#!/usr/bin/env python3
"""Контекст для решения по «ТЕСТ Капучино»: есть ли реальная замена. Осмотр."""
import subprocess

PG = "food-flow-postgres"


def psql(sql):
    r = subprocess.run(["docker", "exec", "-i", PG, "psql", "-U", "foodflow", "-d", "foodflow", "-c", sql],
                       capture_output=True, text=True)
    return (r.stdout or "") + (r.stderr or "")


print("--- продажи блюда «Капучино» ---")
print(psql("""
select count(*) as order_lines, sum(oi.quantity) as qty, max(o.created_at)::date as last_sale
  from order_items oi join orders o on o.id = oi.order_id
 where oi.menu_item_id in (select id from menu_items where name = 'Капучино')
"""))

print("--- номенклатура кофе/зерна у предприятия «Кофейня 104» ---")
print(psql("""
select ii.id, ii.name, ii.unit, ii.cost_price, ii.item_type
  from inventory_items ii
  join enterprises e on e.id = ii.enterprise_id
 where e.name = 'Кофейня 104' and ii.name ~* '(кофе|зерн|молок)'
 order by ii.name
"""))

print("--- сколько всего техкарт и блюд у «Кофейня 104» ---")
print(psql("""
select (select count(*) from menu_items mi join restaurants r on r.id = mi.restaurant_id
          join enterprises e on e.id = r.enterprise_id where e.name='Кофейня 104') as menu_items,
       (select count(*) from tech_cards tc join enterprises e on e.id = tc.enterprise_id
         where e.name='Кофейня 104') as tech_cards,
       (select count(*) from inventory_items ii join enterprises e on e.id = ii.enterprise_id
         where e.name='Кофейня 104') as inventory_items
"""))

print("--- это вообще живое предприятие или демо ---")
print(psql("""
select e.name, e.business_type, e.subdomain, e.created_at::date,
       (select count(*) from users u where u.enterprise_id = e.id) as users,
       (select count(*) from orders o where o.enterprise_id = e.id) as orders
  from enterprises e order by e.created_at
"""))
