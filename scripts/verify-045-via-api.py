#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Проверка изоляции складов ТЕМ ЖЕ ПУТЁМ, которым смотрит пользователь.

Запрос к БД доказывает только состояние БД. Экран склада читает
/api/inventory/warehouses и /api/inventory/stock/:warehouseId, и у этих
эндпоинтов свой расчёт тенанта — поэтому после миграции 045 смотрим именно их,
а не таблицы.

Ожидание: владелец «Кофейни 104» на своём складе больше НЕ видит позиций
«Органики», а владелец «Органики» видит свои 8 позиций на своём складе.
"""
import json
import subprocess
import sys
import urllib.error
import urllib.request

PG = "food-flow-postgres"
BASE = "http://localhost"
failures = []


def q(sql):
    r = subprocess.run(
        ["docker", "exec", PG, "psql", "-U", "foodflow", "-d", "foodflow",
         "-t", "-A", "-F", "|", "-c", sql],
        capture_output=True, text=True)
    if r.returncode != 0:
        print("SQL ОШИБКА:", r.stderr.strip()[:400])
        return []
    out = []
    for line in r.stdout.strip().split("\n"):
        line = line.strip()
        if not line or line.split()[0] in ("INSERT", "UPDATE", "DELETE", "SELECT", "BEGIN", "COMMIT"):
            continue
        out.append(line)
    return out


def jwt_for(uid, email, role, ent):
    code = ("const jwt=require('jsonwebtoken');"
            f"console.log(jwt.sign({{userId:'{uid}',email:'{email}',role:'{role}',"
            f"enterpriseId:'{ent}'}},process.env.JWT_SECRET,{{expiresIn:'1h'}}))")
    r = subprocess.run(["docker", "exec", "user-service", "node", "-e", code],
                       capture_output=True, text=True)
    t = r.stdout.strip()
    return t if t.count(".") == 2 else None


def http(path, token):
    req = urllib.request.Request(BASE + path)
    req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        return e.code, (json.loads(body) if body.strip().startswith(("{", "[")) else body)
    except Exception as e:
        return 0, str(e)


def check(name, ok, detail=""):
    print(("  ✔ " if ok else "  ✘ ") + name + (("  " + str(detail)) if detail else ""))
    if not ok:
        failures.append(name)


print("===== 1. Предприятия, которые участвовали в путанице")
rows = q("""SELECT e.id, e.name, u.id, u.email, u.role
              FROM enterprises e
              JOIN users u ON u.enterprise_id = e.id
             WHERE e.name IN ('Кофейня 104', 'Органика')
               AND u.role IN ('restaurant_owner', 'admin')
             ORDER BY e.name""")
if len(rows) < 2:
    print("!!! ПРОВЕРКА НЕ СОСТОЯЛАСЬ: не нашлось владельцев обоих предприятий")
    sys.exit(1)

orgs = {}
for r in rows:
    eid, ename, uid, uemail, urole = r.split("|")
    if ename in orgs:
        continue
    orgs[ename] = dict(id=eid, uid=uid, email=uemail, role=urole)
for n, o in orgs.items():
    print(f"  {n}: владелец {o['email']} ({o['role']})")

print("===== 2. Что отдаёт API склада каждому владельцу")
for name, o in orgs.items():
    token = jwt_for(o["uid"], o["email"], o["role"], o["id"])
    if not token:
        print(f"!!! не удалось собрать JWT для {name}")
        sys.exit(1)

    st, wh = http("/api/inventory/warehouses", token)
    check(f"[{name}] GET /api/inventory/warehouses → 200", st == 200, f"HTTP {st}")
    # Ответ роута — {"warehouses": [...]}, а не {"data": [...]}: имя поля сверено
    # с res.json() в inventory.routes.ts. Чтение по чужому ключу давало пустой
    # список, и проверка «нет чужих складов» проходила, ничего не проверив.
    whs = wh.get("warehouses") if isinstance(wh, dict) else wh
    whs = whs if isinstance(whs, list) else []
    check(f"[{name}] склады предприятия вообще пришли", len(whs) > 0, f"{len(whs)} шт.")
    check(f"[{name}] видит только свои склады",
          whs and all(w.get("enterprise_id") == o["id"] for w in whs),
          f"{len(whs)} шт.")

    total_items = 0
    foreign = []
    for w in whs:
        wid = w.get("id")
        st, stock = http(f"/api/inventory/stock/{wid}", token)
        if st != 200:
            check(f"[{name}] GET /api/inventory/stock/{wid} → 200", False, f"HTTP {st} {stock}")
            continue
        # Ответ — {"stock": [...]}, имя сверено с res.json() роута stock/:id
        items = stock.get("stock") if isinstance(stock, dict) else stock
        items = items if isinstance(items, list) else []
        total_items += len(items)
        for it in items:
            iid = it.get("inventory_item_id")
            if not iid:
                check(f"[{name}] в позиции остатка есть inventory_item_id", False, str(it)[:200])
                continue
            owner = q(f"""SELECT e.name FROM inventory_items i
                            JOIN enterprises e ON e.id = i.enterprise_id
                           WHERE i.id = '{iid}'""")
            if owner and owner[0] != name:
                foreign.append((it.get("name") or iid, owner[0]))

    print(f"  [{name}] позиций на своих складах по API: {total_items}")
    check(f"[{name}] на экране склада НЕТ чужих позиций",
          not foreign,
          "" if not foreign else f"чужое: {foreign[:5]}")
    o["api_items"] = total_items

print("===== 3. API и база сходятся")
for name, o in orgs.items():
    db_rows = q(f"""SELECT count(*) FROM inventory_stock s
                      JOIN warehouses w ON w.id = s.warehouse_id
                     WHERE w.enterprise_id = '{o['id']}'""")
    db_n = int(db_rows[0]) if db_rows else -1
    check(f"[{name}] число позиций в API совпадает с базой",
          db_n == o.get("api_items"), f"база {db_n}, API {o.get('api_items')}")

print()
if failures:
    print(f"ИТОГ: ПРОВАЛЕНО {len(failures)}:")
    for f in failures:
        print("  -", f)
    sys.exit(1)
print("ИТОГ: все проверки прошли")
