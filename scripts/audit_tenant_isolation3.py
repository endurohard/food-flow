#!/usr/bin/env python3
"""Кто и каким путём создал 8 движений на складе чужого предприятия."""
import subprocess

PG = "food-flow-postgres"


def psql(sql):
    r = subprocess.run(["docker", "exec", "-i", PG, "psql", "-U", "foodflow", "-d", "foodflow", "-c", sql],
                       capture_output=True, text=True)
    return ((r.stdout or "") + (r.stderr or "")).strip()


print("===== кто и чем создал эти движения =====")
print(psql("""
select i.name as item, m.movement_type, m.quantity,
       coalesce(m.reference_type,'(нет)') as ref_type,
       coalesce(u.email,'(нет пользователя)') as performed_by,
       coalesce(u.role,'-') as role,
       coalesce(eu.name,'(без предприятия)') as user_enterprise,
       m.created_at
  from stock_movements m
  join inventory_items i on i.id = m.inventory_item_id
  join warehouses w on w.id = m.warehouse_id
  left join users u on u.id = m.performed_by
  left join enterprises eu on eu.id = u.enterprise_id
 where m.enterprise_id <> w.enterprise_id
 order by m.created_at
"""))

print("\n===== эти же позиции: есть ли у «Органика» свой склад и когда создан =====")
print(psql("""
select w.id, w.name, e.name as enterprise, w.created_at
  from warehouses w join enterprises e on e.id = w.enterprise_id order by w.created_at
"""))

print("\n===== остатки по складам: что где лежит =====")
print(psql("""
select ew.name as warehouse_enterprise, ei.name as item_enterprise, count(*) as rows, sum(s.quantity) as qty
  from inventory_stock s
  join warehouses w on w.id = s.warehouse_id
  join inventory_items i on i.id = s.inventory_item_id
  join enterprises ew on ew.id = w.enterprise_id
  join enterprises ei on ei.id = i.enterprise_id
 group by 1,2 order by 1,2
"""))

print("\n===== приходные накладные этих позиций =====")
print(psql("""
select si.id, si.invoice_number, e.name as invoice_enterprise,
       coalesce(w.name,'(нет склада)') as warehouse,
       coalesce(ew.name,'-') as warehouse_enterprise, si.created_at::date
  from supply_invoices si
  left join enterprises e on e.id = si.enterprise_id
  left join warehouses w on w.id = si.warehouse_id
  left join enterprises ew on ew.id = w.enterprise_id
 order by si.created_at desc limit 10
"""))
