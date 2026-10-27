#!/usr/bin/env python3
"""Репетиция миграции 045 (изоляция склада по предприятиям) на КОПИИ боевой базы.

Копия только дампом: CREATE DATABASE ... TEMPLATE на живой базе всегда падает
из-за активных подключений.

Проверяем:
  - миграция применяется на живых данных и повторный накат проходит;
  - 8 разъехавшихся строк переехали на склад своего предприятия;
  - остатки и партии не потерялись (сумма до == сумма после);
  - триггеры действительно отбивают новые нарушения (по ИМЕНИ ошибки);
  - нормальные вставки в своё предприятие по-прежнему проходят.
"""
import subprocess, sys

PG = "food-flow-postgres"
SRC = "foodflow"
DB = "ff_reh045"
MIG = "/tmp/045_tenant_warehouse_isolation.sql"
_T = ("INSERT ", "UPDATE ", "DELETE ", "SELECT ", "BEGIN", "COMMIT", "ROLLBACK",
      "CREATE ", "DROP ", "ALTER ", "DO")

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  OK   {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {detail}")


def q(sql, db=DB):
    r = subprocess.run(["docker", "exec", "-i", PG, "psql", "-U", "foodflow", "-d", db,
                        "-t", "-A", "-c", sql], capture_output=True, text=True)
    return r.returncode, (r.stdout or "").strip(), (r.stderr or "").strip()


def val(out):
    for line in out.splitlines():
        line = line.strip()
        if line and not any(line.startswith(t) for t in _T):
            return line
    return ""


def one(sql, db=DB):
    return val(q(sql, db)[1])


print("=== копия боевой базы дампом ===")
subprocess.run(["docker", "exec", "-i", PG, "psql", "-U", "foodflow", "-d", "postgres",
                "-c", f"DROP DATABASE IF EXISTS {DB}"], capture_output=True, text=True)
r = subprocess.run(["docker", "exec", "-i", PG, "psql", "-U", "foodflow", "-d", "postgres",
                    "-c", f"CREATE DATABASE {DB}"], capture_output=True, text=True)
if r.returncode != 0:
    print("ПРОВЕРКА НЕ СОСТОЯЛАСЬ: не создалась копия:", r.stderr[:300])
    sys.exit(1)
r = subprocess.run(["docker", "exec", "-i", PG, "sh", "-c",
                    f"pg_dump -U foodflow -d {SRC} | psql -q -U foodflow -d {DB}"],
                   capture_output=True, text=True)
tables = one("select count(*) from information_schema.tables where table_schema='public'")
if not tables or int(tables) < 20:
    print("ПРОВЕРКА НЕ СОСТОЯЛАСЬ: копия пустая, таблиц", tables)
    sys.exit(1)
print(f"  таблиц в копии: {tables}")

# --- состояние ДО
bad_before = int(one("""
select count(*) from inventory_stock s
  join warehouses w on w.id=s.warehouse_id
  join inventory_items i on i.id=s.inventory_item_id
 where w.enterprise_id <> i.enterprise_id""") or 0)
rows_before = int(one("select count(*) from inventory_stock") or 0)
qty_before = one("select coalesce(sum(quantity),0) from inventory_stock")
batches_before = int(one("select count(*) from inventory_batches") or 0)
bqty_before = one("select coalesce(sum(quantity),0) from inventory_batches")
mov_before = int(one("select count(*) from stock_movements") or 0)
print(f"  до миграции: нарушающих строк {bad_before}, остатков {rows_before} ({qty_before}), "
      f"партий {batches_before} ({bqty_before}), движений {mov_before}")
check("в копии действительно есть нарушения (иначе проверка бессмысленна)", bad_before > 0,
      f"-> {bad_before}")

print("\n=== накат миграции ===")
# Файл лежит на ХОСТЕ, а psql работает внутри контейнера: передаём через stdin,
# иначе `-f /tmp/...` ищет путь в файловой системе контейнера и падает.
with open(MIG, "r", encoding="utf-8") as fh:
    MIG_SQL = fh.read()
r = subprocess.run(["docker", "exec", "-i", PG, "psql", "-v", "ON_ERROR_STOP=1",
                    "--single-transaction", "-U", "foodflow", "-d", DB, "-f", "-"],
                   input=MIG_SQL, capture_output=True, text=True)
check("миграция применилась на живых данных", r.returncode == 0,
      (r.stderr or "")[-400:])
if r.returncode != 0:
    print("ПРОВЕРКА НЕ СОСТОЯЛАСЬ: миграция не применилась")
    print(r.stderr[-1500:])
    sys.exit(1)

r2 = subprocess.run(["docker", "exec", "-i", PG, "psql", "-v", "ON_ERROR_STOP=1",
                     "--single-transaction", "-U", "foodflow", "-d", DB, "-f", "-"],
                    input=MIG_SQL, capture_output=True, text=True)
check("повторный накат проходит (идемпотентна)", r2.returncode == 0, (r2.stderr or "")[-300:])

print("\n=== данные после починки ===")
bad_after = int(one("""
select count(*) from inventory_stock s
  join warehouses w on w.id=s.warehouse_id
  join inventory_items i on i.id=s.inventory_item_id
 where w.enterprise_id <> i.enterprise_id""") or 0)
check("разъехавшихся остатков не осталось", bad_after == 0, f"-> {bad_after}")

bb = one("""select count(*) from inventory_batches b
  join warehouses w on w.id=b.warehouse_id
  join inventory_items i on i.id=b.inventory_item_id
 where w.enterprise_id <> i.enterprise_id""")
check("разъехавшихся партий не осталось", bb == "0", f"-> {bb}")

bm = one("""select count(*) from stock_movements m
  join warehouses w on w.id=m.warehouse_id
  join inventory_items i on i.id=m.inventory_item_id
 where w.enterprise_id <> i.enterprise_id""")
check("разъехавшихся движений не осталось", bm == "0", f"-> {bm}")

bmi = one("""select count(*) from stock_movements m
  join inventory_items i on i.id=m.inventory_item_id
 where m.enterprise_id is not null and i.enterprise_id <> m.enterprise_id""")
check("движение и позиция одного предприятия", bmi == "0", f"-> {bmi}")

bsi = one("""select count(*) from supply_invoices si
  join warehouses w on w.id=si.warehouse_id
 where si.enterprise_id is not null and w.enterprise_id <> si.enterprise_id""")
check("накладных на чужом складе не осталось", bsi == "0", f"-> {bsi}")

# --- ничего не потеряли
rows_after = int(one("select count(*) from inventory_stock") or 0)
qty_after = one("select coalesce(sum(quantity),0) from inventory_stock")
batches_after = int(one("select count(*) from inventory_batches") or 0)
bqty_after = one("select coalesce(sum(quantity),0) from inventory_batches")
mov_after = int(one("select count(*) from stock_movements") or 0)
check(f"остатки не потеряны: строк {rows_before}->{rows_after}, количество {qty_before}->{qty_after}",
      rows_after == rows_before and float(qty_after) == float(qty_before))
check(f"партии не потеряны: {batches_before}->{batches_after}, {bqty_before}->{bqty_after}",
      batches_after == batches_before and float(bqty_after) == float(bqty_before))
check(f"движения не потеряны: {mov_before}->{mov_after}", mov_after == mov_before)

print("\n=== куда переехал товар ===")
print(q("""select ew.name as warehouse_enterprise, ei.name as item_enterprise,
       count(*) as rows, sum(s.quantity) as qty
  from inventory_stock s
  join warehouses w on w.id=s.warehouse_id
  join inventory_items i on i.id=s.inventory_item_id
  join enterprises ew on ew.id=w.enterprise_id
  join enterprises ei on ei.id=i.enterprise_id
 group by 1,2 order by 1,2""")[1])

print("\n=== триггеры отбивают НОВЫЕ нарушения ===")
org = one("select id from enterprises where subdomain='organika'")
cof = one("select id from enterprises where subdomain='coffee104'")
wh_cof = one(f"select id from warehouses where enterprise_id='{cof}' limit 1")
wh_org = one(f"select id from warehouses where enterprise_id='{org}' limit 1")
it_org = one(f"select id from inventory_items where enterprise_id='{org}' limit 1")
usr = one(f"select id from users where enterprise_id='{org}' limit 1")
if not all([org, cof, wh_cof, wh_org, it_org]):
    print(f"ПРОВЕРКА НЕ СОСТОЯЛАСЬ: org={org} cof={cof} wh_cof={wh_cof} wh_org={wh_org} it={it_org}")
    sys.exit(1)

rc, _, err = q(f"""insert into inventory_stock (warehouse_id,inventory_item_id,quantity)
 values ('{wh_cof}','{it_org}',7)""")
check("остаток позиции Органики на складе Кофейни ОТБИТ",
      rc != 0 and "warehouse_item_tenant_mismatch" in err, err[-160:])

rc, _, err = q(f"""insert into inventory_batches
 (inventory_item_id,warehouse_id,enterprise_id,batch_number,quantity,cost_price)
 values ('{it_org}','{wh_cof}','{org}','REH-1',5,10)""")
check("партия на чужом складе отбита",
      rc != 0 and "warehouse_item_tenant_mismatch" in err, err[-160:])

rc, _, err = q(f"""insert into stock_movements
 (enterprise_id,warehouse_id,inventory_item_id,movement_type,quantity,cost_price,performed_by)
 values ('{org}','{wh_cof}','{it_org}','receipt',3,10,{f"'{usr}'" if usr else 'null'})""")
check("движение на чужом складе отбито",
      rc != 0 and "warehouse_item_tenant_mismatch" in err, err[-160:])

rc, _, err = q(f"""insert into stock_movements
 (enterprise_id,warehouse_id,inventory_item_id,movement_type,quantity,cost_price,performed_by)
 values ('{cof}','{wh_org}','{it_org}','receipt',3,10,{f"'{usr}'" if usr else 'null'})""")
check("движение с чужим enterprise_id отбито",
      rc != 0 and ("movement_tenant_mismatch" in err or "warehouse_item_tenant_mismatch" in err),
      err[-160:])

rc, _, err = q(f"update inventory_stock set warehouse_id='{wh_cof}' "
               f"where inventory_item_id='{it_org}'")
check("ПЕРЕНОС своего остатка на чужой склад отбит (UPDATE, не только INSERT)",
      rc != 0 and "warehouse_item_tenant_mismatch" in err, err[-160:])

print("\n=== нормальная работа не сломана ===")
it_new = one(f"""insert into inventory_items (enterprise_id,name,unit,cost_price,item_type)
 values ('{org}','REH045-товар','шт',10,'good') returning id""")
rc, _, err = q(f"""insert into inventory_stock (warehouse_id,inventory_item_id,quantity)
 values ('{wh_org}','{it_new}',20)""")
check("остаток на СВОЁМ складе создаётся", rc == 0, err[-200:])
rc, _, err = q(f"""insert into stock_movements
 (enterprise_id,warehouse_id,inventory_item_id,movement_type,quantity,cost_price,performed_by)
 values ('{org}','{wh_org}','{it_new}','receipt',20,10,{f"'{usr}'" if usr else 'null'})""")
check("движение по своему складу пишется", rc == 0, err[-200:])
rc, _, err = q(f"""insert into stock_movements
 (enterprise_id,warehouse_id,inventory_item_id,movement_type,quantity,cost_price,performed_by)
 values ('{org}',null,'{it_new}','write_off',1,10,{f"'{usr}'" if usr else 'null'})""")
# Движение без склада схема запрещает сама: stock_movements.warehouse_id — NOT NULL.
# Это не дефект миграции, а более сильное ограничение, чем ветка NULL в триггере.
# Проверяем, что отказ идёт именно от NOT NULL, а не от моего триггера.
check("движение без склада отбивает схема (NOT NULL), а не триггер",
      rc != 0 and "warehouse_id" in err and "null value" in err.lower()
      and "tenant_mismatch" not in err, err[-200:])

print("\n=== уборка копии ===")
subprocess.run(["docker", "exec", "-i", PG, "psql", "-U", "foodflow", "-d", "postgres",
                "-c", f"DROP DATABASE IF EXISTS {DB}"], capture_output=True, text=True)
left = subprocess.run(["docker", "exec", "-i", PG, "psql", "-U", "foodflow", "-d", "postgres",
                       "-t", "-A", "-c", f"select count(*) from pg_database where datname='{DB}'"],
                      capture_output=True, text=True).stdout.strip()
print(f"  копия удалена: {left == '0'}")

print(f"\nИТОГ: OK {ok}, FAIL {fail}")
sys.exit(0 if fail == 0 else 2)
