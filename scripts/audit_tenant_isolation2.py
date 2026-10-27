#!/usr/bin/env python3
"""Детали найденного расхождения: 8 остатков на складе чужого предприятия."""
import subprocess

PG = "food-flow-postgres"


def psql(sql):
    r = subprocess.run(["docker", "exec", "-i", PG, "psql", "-U", "foodflow", "-d", "foodflow", "-c", sql],
                       capture_output=True, text=True)
    return ((r.stdout or "") + (r.stderr or "")).strip()


print("===== Остатки, где склад и позиция принадлежат разным предприятиям =====")
print(psql("""
select s.inventory_item_id, i.name as item, ei.name as item_enterprise,
       w.name as warehouse, ew.name as warehouse_enterprise, s.quantity
  from inventory_stock s
  join warehouses w on w.id = s.warehouse_id
  join inventory_items i on i.id = s.inventory_item_id
  join enterprises ei on ei.id = i.enterprise_id
  join enterprises ew on ew.id = w.enterprise_id
 where w.enterprise_id <> i.enterprise_id
 order by ei.name, i.name
"""))

print("\n===== Все склады с их предприятиями =====")
print(psql("""
select w.id, w.name, e.name as enterprise, w.created_at::date,
       (select count(*) from inventory_stock s where s.warehouse_id = w.id) as stock_rows
  from warehouses w join enterprises e on e.id = w.enterprise_id
 order by e.name, w.name
"""))

print("\n===== Партии: предприятие партии против предприятия склада =====")
print(psql("""
select i.name as item, eb.name as batch_enterprise, ew.name as warehouse_enterprise,
       b.batch_number, b.quantity
  from inventory_batches b
  join inventory_items i on i.id = b.inventory_item_id
  join warehouses w on w.id = b.warehouse_id
  join enterprises eb on eb.id = b.enterprise_id
  join enterprises ew on ew.id = w.enterprise_id
 where b.enterprise_id <> w.enterprise_id
 order by i.name
"""))

print("\n===== Движения: предприятие движения против предприятия склада =====")
print(psql("""
select i.name as item, em.name as movement_enterprise, ew.name as warehouse_enterprise,
       m.movement_type, m.quantity, m.created_at::date
  from stock_movements m
  join inventory_items i on i.id = m.inventory_item_id
  join warehouses w on w.id = m.warehouse_id
  join enterprises em on em.id = m.enterprise_id
  join enterprises ew on ew.id = w.enterprise_id
 where m.enterprise_id <> w.enterprise_id
 order by m.created_at
"""))

print("\n===== 7 пользователей без enterprise_id — кто это =====")
print(psql("""
select id, email, role, created_at::date,
       (select count(*) from enterprise_users eu where eu.user_id = users.id) as enterprise_links
  from users where enterprise_id is null order by created_at
"""))

print("\n===== Есть ли ограничение БД, запрещающее склад чужого предприятия =====")
print(psql("""
select conrelid::regclass as tbl, conname, pg_get_constraintdef(oid)
  from pg_constraint
 where conrelid in ('inventory_stock'::regclass, 'inventory_batches'::regclass, 'stock_movements'::regclass)
 order by 1, 2
"""))
