#!/usr/bin/env python3
"""Аудит изоляции предприятий: не расплываются ли данные между организациями.

Только чтение. Ищет три класса утечки:
  1) строки без enterprise_id (видны всем, кто фильтрует по тенанту);
  2) связи, где родитель и ребёнок принадлежат РАЗНЫМ предприятиям;
  3) совпадение имён между предприятиями — это не утечка, но проверяем,
     что одинаковые названия лежат под разными enterprise_id.
"""
import subprocess

PG = "food-flow-postgres"


def psql(sql, tuples=False):
    args = ["docker", "exec", "-i", PG, "psql", "-U", "foodflow", "-d", "foodflow"]
    if tuples:
        args += ["-t", "-A"]
    args += ["-c", sql]
    r = subprocess.run(args, capture_output=True, text=True)
    return ((r.stdout or "") + (r.stderr or "")).strip()


print("===== 1. Строки без enterprise_id (должно быть 0 везде) =====")
print(psql("""
select 'inventory_items' as t, count(*) from inventory_items where enterprise_id is null
union all select 'warehouses', count(*) from warehouses where enterprise_id is null
union all select 'tech_cards', count(*) from tech_cards where enterprise_id is null
union all select 'stock_movements', count(*) from stock_movements where enterprise_id is null
union all select 'inventory_batches', count(*) from inventory_batches where enterprise_id is null
union all select 'counterparties', count(*) from counterparties where enterprise_id is null
union all select 'wholesale_orders', count(*) from wholesale_orders where enterprise_id is null
union all select 'wholesale_returns', count(*) from wholesale_returns where enterprise_id is null
union all select 'users', count(*) from users where enterprise_id is null
union all select 'restaurants', count(*) from restaurants where enterprise_id is null
order by 1
"""))

print("\n===== 2. Связи между РАЗНЫМИ предприятиями (должно быть 0) =====")

print("-- остаток: склад одного предприятия, позиция другого")
print(psql("""
select count(*) as rows
  from inventory_stock s
  join warehouses w on w.id = s.warehouse_id
  join inventory_items i on i.id = s.inventory_item_id
 where w.enterprise_id <> i.enterprise_id
"""))

print("-- партия: предприятие партии не совпадает с предприятием позиции или склада")
print(psql("""
select count(*) filter (where b.enterprise_id <> i.enterprise_id) as vs_item,
       count(*) filter (where b.enterprise_id <> w.enterprise_id) as vs_warehouse
  from inventory_batches b
  join inventory_items i on i.id = b.inventory_item_id
  left join warehouses w on w.id = b.warehouse_id
"""))

print("-- движение склада: предприятие движения против позиции и склада")
print(psql("""
select count(*) filter (where m.enterprise_id <> i.enterprise_id) as vs_item,
       count(*) filter (where w.id is not null and m.enterprise_id <> w.enterprise_id) as vs_warehouse
  from stock_movements m
  join inventory_items i on i.id = m.inventory_item_id
  left join warehouses w on w.id = m.warehouse_id
"""))

print("-- техкарта и её ингредиенты из другого предприятия")
print(psql("""
select count(*) as rows
  from tech_card_ingredients ti
  join tech_cards tc on tc.id = ti.tech_card_id
  join inventory_items i on i.id = ti.inventory_item_id
 where tc.enterprise_id <> i.enterprise_id
"""))

print("-- техкарта привязана к блюду чужого предприятия")
print(psql("""
select count(*) as rows
  from tech_cards tc
  join menu_items mi on mi.id = tc.menu_item_id
  join restaurants r on r.id = mi.restaurant_id
 where tc.enterprise_id <> r.enterprise_id
"""))

print("-- опт: заказ и контрагент/склад/позиция из разных предприятий")
print(psql("""
select count(*) filter (where o.enterprise_id <> cp.enterprise_id) as vs_counterparty,
       count(*) filter (where w.id is not null and o.enterprise_id <> w.enterprise_id) as vs_warehouse,
       count(*) filter (where i.id is not null and o.enterprise_id <> i.enterprise_id) as vs_item
  from wholesale_orders o
  left join counterparties cp on cp.id = o.counterparty_id
  left join warehouses w on w.id = o.warehouse_id
  left join wholesale_order_items oi on oi.order_id = o.id
  left join inventory_items i on i.id = oi.inventory_item_id
"""))

print("-- возврат и его заказ из разных предприятий")
print(psql("""
select count(*) as rows
  from wholesale_returns r join wholesale_orders o on o.id = r.order_id
 where r.enterprise_id <> o.enterprise_id
"""))

print("-- пользователь привязан к точке чужого предприятия")
print(psql("""
select count(*) as rows
  from users u join restaurants r on r.id = u.restaurant_id
 where u.enterprise_id is not null and r.enterprise_id <> u.enterprise_id
"""))

print("\n===== 3. Раскладка номенклатуры по предприятиям =====")
print(psql("""
select e.name as enterprise,
       (select count(*) from inventory_items i where i.enterprise_id = e.id) as items,
       (select count(*) from warehouses w where w.enterprise_id = e.id) as warehouses,
       (select count(*) from tech_cards t where t.enterprise_id = e.id) as tech_cards,
       (select count(*) from counterparties c where c.enterprise_id = e.id) as counterparties
  from enterprises e order by e.created_at
"""))

print("-- одинаковые названия позиций в РАЗНЫХ предприятиях (норма, но смотрим) --")
print(psql("""
select name, count(distinct enterprise_id) as enterprises, count(*) as rows
  from inventory_items group by name having count(distinct enterprise_id) > 1 order by 2 desc, 1 limit 20
"""))
