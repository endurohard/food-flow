#!/usr/bin/env python3
"""Живой прогон этапа 1 на проде через боевой API wholesale-service.

Сценарий: готовим товар, партию, контрагента и отгруженный заказ ->
POST /api/wholesale/orders/:id/returns с двумя строками (3 restock + 2 write_off)
-> POST /api/wholesale/returns/:id/confirm -> сверяем движения склада и остаток.
Уборка в начале и в конце. Все проверки ДО уборки.
"""
import subprocess, sys, json, base64, hmac, hashlib, time
import urllib.request, urllib.error

PG = "food-flow-postgres"
_T = ("INSERT ", "UPDATE ", "DELETE ", "SELECT ", "BEGIN", "COMMIT", "ROLLBACK")


def q(sql):
    r = subprocess.run(
        ["docker", "exec", "-i", PG, "psql", "-U", "foodflow", "-d", "foodflow", "-t", "-A", "-c", sql],
        capture_output=True, text=True)
    return r.returncode, (r.stdout or "").strip(), (r.stderr or "").strip()


def val(out):
    for line in out.splitlines():
        line = line.strip()
        if line and not any(line.startswith(t) for t in _T):
            return line
    return ""


def one(sql):
    return val(q(sql)[1])


ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  OK   {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {detail}")


M = "LRTAPI-"


def clean():
    q(f"delete from stock_movements where notes like '%{M}%' or reference_id in (select id from wholesale_returns where reason like '{M}%')")
    q(f"delete from counterparty_payments where notes like '%{M}%' or order_id in (select id from wholesale_orders where notes like '{M}%')")
    q(f"delete from wholesale_return_items where return_id in (select id from wholesale_returns where reason like '{M}%' or order_id in (select id from wholesale_orders where notes like '{M}%'))")
    q(f"delete from wholesale_returns where reason like '{M}%' or order_id in (select id from wholesale_orders where notes like '{M}%')")
    q(f"delete from wholesale_order_items where order_id in (select id from wholesale_orders where notes like '{M}%')")
    q(f"delete from wholesale_orders where notes like '{M}%'")
    q(f"delete from inventory_batches where batch_number like '{M}%' or inventory_item_id in (select id from inventory_items where name like '{M}%')")
    q(f"delete from inventory_stock where inventory_item_id in (select id from inventory_items where name like '{M}%')")
    q(f"delete from inventory_items where name like '{M}%'")
    q(f"delete from counterparties where name like '{M}%'")


clean()
print("=== подготовка ===")
org = one("select id from enterprises where subdomain='organika'")
wh = one(f"select id from warehouses where enterprise_id='{org}' limit 1")
usr = one(f"select id from users where enterprise_id='{org}' limit 1")
item = one(f"""insert into inventory_items (enterprise_id,name,unit,cost_price,item_type)
 values ('{org}','{M}товар','шт',50,'good') returning id""")
if not (org and wh and usr and item):
    print(f"ПРОВЕРКА НЕ СОСТОЯЛАСЬ: org={org} wh={wh} usr={usr} item={item}")
    sys.exit(1)
q(f"insert into inventory_stock (warehouse_id,inventory_item_id,quantity) values ('{wh}','{item}',100)")
q(f"""insert into inventory_batches (inventory_item_id,warehouse_id,enterprise_id,batch_number,quantity,cost_price)
 values ('{item}','{wh}','{org}','{M}b1',100,50)""")
cp = one(f"insert into counterparties (enterprise_id,name) values ('{org}','{M}клиент') returning id")
order = one(f"""insert into wholesale_orders (enterprise_id,counterparty_id,warehouse_id,status,total_amount,notes)
 values ('{org}','{cp}','{wh}','shipped',1200,'{M}заказ') returning id""")
oi = one(f"""insert into wholesale_order_items (order_id,inventory_item_id,name,quantity,price,total,cost_price,shipped_quantity,returned_quantity)
 values ('{order}','{item}','{M}товар',10,120,1200,50,10,0) returning id""")
if not (cp and order and oi):
    print(f"ПРОВЕРКА НЕ СОСТОЯЛАСЬ: cp={cp} order={order} oi={oi}")
    sys.exit(1)
stock_before = float(one(f"select quantity from inventory_stock where warehouse_id='{wh}' and inventory_item_id='{item}'") or 0)
bal_before = float(one(f"select balance from counterparties where id='{cp}'") or 0)
print(f"  остаток {stock_before}, отгружено 10 по 120 ₽ (себестоимость 50), долг {bal_before}")

# --- JWT подписываем секретом из контейнера, роль admin, userId реального пользователя
sec = subprocess.run(["docker", "exec", "wholesale-service", "printenv", "JWT_SECRET"],
                     capture_output=True, text=True).stdout.strip()
if not sec:
    print("ПРОВЕРКА НЕ СОСТОЯЛАСЬ: JWT_SECRET пуст")
    sys.exit(1)


def b64(d):
    return base64.urlsafe_b64encode(json.dumps(d, separators=(',', ':')).encode()).rstrip(b'=').decode()


h = b64({"alg": "HS256", "typ": "JWT"})
p = b64({"userId": usr, "id": usr, "role": "admin", "enterpriseId": org,
         "iat": int(time.time()), "exp": int(time.time()) + 900})
sg = base64.urlsafe_b64encode(
    hmac.new(sec.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest()).rstrip(b'=').decode()
tok = f"{h}.{p}.{sg}"


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    rq = urllib.request.Request("http://localhost" + path, data=data, method=method,
                                headers={"Authorization": "Bearer " + tok,
                                         "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(rq, timeout=30) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, (e.read().decode() or "")[:400]
    except Exception as e:
        return -1, str(e)


print("\n=== ЭТАП 1: возврат 3 restock + 2 write_off через боевой API ===")
st, resp = api("POST", f"/api/wholesale/orders/{order}/returns", {
    "reason": f"{M}смешанный возврат",
    "items": [
        {"orderItemId": oi, "quantity": 3, "disposition": "restock", "reason": "товар целый"},
        {"orderItemId": oi, "quantity": 2, "disposition": "write_off", "reason": "раздавлена упаковка"},
    ]})
check("создание возврата: HTTP 201", st == 201, f"-> {st} {resp}")
if st != 201:
    print("ПРОВЕРКА НЕ СОСТОЯЛАСЬ: возврат не создан")
    clean()
    sys.exit(1)
ret_id = resp["return"]["id"]

st2, resp2 = api("POST", f"/api/wholesale/returns/{ret_id}/confirm")
check("подтверждение возврата: HTTP 200", st2 == 200, f"-> {st2} {resp2}")

mv = q(f"""select movement_type, quantity, cost_price, notes from stock_movements
 where reference_type='wholesale_return' and reference_id='{ret_id}' order by movement_type""")[1]
print("  движения склада:")
for line in mv.splitlines():
    if line.strip():
        print("    " + line)
rows = [l.split("|") for l in mv.splitlines() if l.strip() and "|" in l]
types = {r[0]: r for r in rows}

check("движение write_off записано", "write_off" in types)
check("движение return записано", "return" in types)
check("write_off количество 2", "write_off" in types and abs(float(types["write_off"][1]) - 2) < 1e-6,
      types.get("write_off", [""])[0])
check("write_off себестоимость отгрузки 50", "write_off" in types and abs(float(types["write_off"][2]) - 50) < 1e-6)
check("причина списания в заметке", "write_off" in types and "раздавлена упаковка" in types["write_off"][3])
check("return количество 3", "return" in types and abs(float(types["return"][1]) - 3) < 1e-6)

stock_after = float(one(f"select quantity from inventory_stock where warehouse_id='{wh}' and inventory_item_id='{item}'") or 0)
check(f"остаток вырос ровно на 3 ({stock_before} -> {stock_after}): списанное не приходовано",
      abs(stock_after - (stock_before + 3)) < 1e-6, f"-> {stock_after}")

nb = one(f"select count(*) from inventory_batches where inventory_item_id='{item}' and batch_number like 'RET-%'")
check("создана ровно одна партия возврата (только на restock)", nb == "1", f"-> {nb}")

bal_after = float(one(f"select balance from counterparties where id='{cp}'") or 0)
check(f"кредит-нота погасила долг на 600 ₽ ({bal_before} -> {bal_after})",
      abs((bal_before - bal_after) - 600) < 0.01, f"-> {bal_after}")

rq_ = one(f"select returned_quantity from wholesale_order_items where id='{oi}'")
check("счётчик возвращённого стал 5", abs(float(rq_ or 0) - 5) < 1e-6, f"-> {rq_}")

print("\n=== уборка ===")
clean()
left = one(f"select count(*) from stock_movements where notes like '%{M}%'")
left2 = one(f"select count(*) from inventory_items where name like '{M}%'")
print(f"  остатки тестовых данных: движений {left}, позиций {left2}")

print(f"\nИТОГ: OK {ok}, FAIL {fail}")
sys.exit(0 if fail == 0 else 2)
