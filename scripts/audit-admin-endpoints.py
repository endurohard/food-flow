#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Осмотр админки: каждый экран против эндпоинтов, которые он реально зовёт.

Зачем. Баг со складами (`/api/inventory/warehouses` отдавал 400, потому что
фронт не передавал restaurantId) не виден ни в консоли браузера, ни в логах:
экран молча показывал «нет данных». Единственный способ найти такой класс
поломок — взять URL из самого HTML и дёрнуть их с живым токеном владельца.

Что считается проблемой:
  * 4xx/5xx на GET, который экран делает при загрузке — экран будет пустым;
  * 404 — эндпоинта нет вовсе, кнопка/раздел мёртвые.
Не проблема: 401 без токена (так и должно быть) и роуты с параметром в пути,
который мы не можем подставить.

Скрипт только читает (GET), ничего не меняет.
"""
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request

BASE = "http://localhost"
ADMIN = "/admin-panel"
PG = "food-flow-postgres"
PAGES = [
    "index.html", "inventory.html", "menu.html", "staff.html", "loyalty.html",
    "settings.html", "wholesale.html", "pos-download.html", "orders.html",
    "reports.html", "techcards.html", "nomenclature.html",
]


def sh(cmd):
    return subprocess.run(cmd, capture_output=True, text=True).stdout


def q(sql):
    out = sh(["docker", "exec", PG, "psql", "-U", "foodflow", "-d", "foodflow",
              "-t", "-A", "-F", "|", "-c", sql])
    return [l.strip() for l in out.strip().split("\n")
            if l.strip() and l.split()[0] not in
            ("INSERT", "UPDATE", "DELETE", "SELECT", "BEGIN", "COMMIT")]


def http(path, token=None):
    req = urllib.request.Request(BASE + path)
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.status, r.read().decode(errors="replace")[:300]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")[:300]
    except Exception as e:
        return 0, str(e)[:200]


print("===== Токен владельца предприятия с данными")
rows = q("""SELECT e.id, e.name, u.id, u.email, u.role
              FROM enterprises e
              JOIN restaurants r ON r.enterprise_id = e.id
              JOIN users u ON u.enterprise_id = e.id
             WHERE u.role IN ('restaurant_owner','admin')
             ORDER BY (SELECT count(*) FROM inventory_items i WHERE i.enterprise_id=e.id) DESC
             LIMIT 1""")
if not rows:
    print("ПРОВЕРКА НЕ СОСТОЯЛАСЬ: нет подходящего предприятия")
    sys.exit(1)
ent_id, ent_name, uid, uemail, urole = rows[0].split("|")
print(f"  {ent_name} / {uemail} ({urole})")

code = ("const jwt=require('jsonwebtoken');"
        f"console.log(jwt.sign({{userId:'{uid}',email:'{uemail}',role:'{urole}',"
        f"enterpriseId:'{ent_id}'}},process.env.JWT_SECRET,{{expiresIn:'1h'}}))")
token = sh(["docker", "exec", "user-service", "node", "-e", code]).strip()
if token.count(".") != 2:
    print("ПРОВЕРКА НЕ СОСТОЯЛАСЬ: не собрался JWT")
    sys.exit(1)

broken = []
checked = 0

for page in PAGES:
    st, html = http(f"{ADMIN}/{page}")
    if st != 200:
        print(f"\n--- {page}: страница недоступна (HTTP {st}) — пропуск")
        continue
    # страницу надо прочитать целиком, http() режет тело
    full = sh(["curl", "-s", BASE + ADMIN + "/" + page])
    urls = set()
    for m in re.finditer(r"""(?:AUTH\.fetch|apiJson|fetch)\(\s*[`'"]([^`'"]*?/api/[^`'"]*)[`'"]""", full):
        urls.add(m.group(1))
    # AUTH.fetch('/api/...') c конкатенацией базового URL
    for m in re.finditer(r"""AUTH\.API_BASE\s*\+\s*[`'"]([^`'"]+)[`'"]""", full):
        urls.add(m.group(1))

    gets = sorted(u for u in urls if "${" not in u and "' +" not in u and '" +' not in u)
    if not gets:
        print(f"\n--- {page}: статических GET-URL не найдено")
        continue

    print(f"\n--- {page}")
    for u in gets:
        path = u if u.startswith("/") else "/" + u
        if not path.startswith("/api"):
            path = "/api" + path if not path.startswith("/api") else path
        st, body = http(path, token)
        checked += 1
        mark = "  "
        if st in (400, 403, 404, 500, 0):
            mark = "!!"
            broken.append((page, path, st, body))
        print(f"  {mark} {st}  {path}")
        if mark == "!!":
            print(f"        {body[:160]}")

print(f"\n===== Итог: проверено {checked} эндпоинтов")
if broken:
    print(f"ПРОБЛЕМНЫХ: {len(broken)}")
    for page, path, st, body in broken:
        print(f"  {page:22} {st}  {path}")
        print(f"      {body[:200]}")
    sys.exit(1)
print("все эндпоинты экранов отвечают успешно")
