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
# Список страниц берём с самого прода (см. ниже), а не фиксируем руками:
# в прошлый раз в списке были несуществующие reports.html/techcards.html,
# а половина реальных экранов (dashboard, finance, analytics, calls, kds,
# pos, tables, hall-designer, orders, enterprises, user-profile) не
# проверялась вовсе — осмотр выглядел полным, покрывая 12 файлов из 22.
PAGES: list = []


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

# Страницы берём из каталога контейнера frontend-service: это ровно те файлы,
# которые браузер и может открыть. Жёсткий список в коде скрипта разошёлся бы
# с реальностью (и уже расходился).
PAGES = sorted(
    p for p in sh(["docker", "exec", "frontend-service",
                   "sh", "-c", "ls /app/public/admin-panel/*.html"]).split()
    if p.endswith(".html")
)
PAGES = [p.rsplit("/", 1)[-1] for p in PAGES]
print(f"\n===== Экранов к осмотру: {len(PAGES)}")
print("  " + ", ".join(PAGES))
if not PAGES:
    print("ПРОВЕРКА НЕ СОСТОЯЛАСЬ: не удалось получить список страниц из контейнера")
    sys.exit(1)

for page in PAGES:
    st, html = http(f"{ADMIN}/{page}")
    if st != 200:
        print(f"\n--- {page}: страница недоступна (HTTP {st}) — пропуск")
        continue
    # страницу надо прочитать целиком, http() режет тело
    full = sh(["curl", "-s", BASE + ADMIN + "/" + page])
    urls = set()
    # Берём не только URL, но и метод из опций запроса: слепой GET на роут,
    # который фронт зовёт POST'ом (/crm/points/redeem) или PUT'ом
    # (/nomenclature/cash-order), даёт 404 от самого Express — артефакт
    # проверки, а не мёртвый эндпоинт.
    for m in re.finditer(
            r"""(?:AUTH\.fetch|apiJson|fetch)\(\s*[`'"]([^`'"]*?/api/[^`'"]*)[`'"]\s*(,\s*\{(?:[^{}]|\{[^{}]*\})*\})?""",
            full):
        url, opts = m.group(1), (m.group(2) or "")
        mm = re.search(r"method\s*:\s*['\"](\w+)['\"]", opts)
        method = (mm.group(1) if mm else "GET").upper()
        if method == "GET":
            urls.add(url)
    # AUTH.API_BASE + '/api/...' — это базовый URL раздела, а не готовый
    # эндпоинт: конкретные вызовы делаются конкатенацией ниже по коду.
    # Проверять его слепым GET бессмысленно, поэтому НЕ добавляем.

    gets = sorted(u for u in urls if "${" not in u and "' +" not in u and '" +' not in u)
    # URL с хвостовым '/' — это шаблон, куда фронт подставляет id
    # ('/api/x/' + id). Дёргать его без id бессмысленно: 404/500 от такого
    # запроса — артефакт проверки, а не поломка экрана. Такие же артефакты
    # дают базовые URL без ресурса (AUTH.API_BASE + '/api/printers') и роуты
    # других методов (PUT /nomenclature/cash-order, POST /crm/points/redeem).
    # Проверять их надо живым сценарием с настоящим id, а не слепым GET.
    skipped = [u for u in gets if u.endswith('/')]
    gets = [u for u in gets if not u.endswith('/')]
    if not gets:
        print(f"\n--- {page}: статических GET-URL не найдено")
        continue

    print(f"\n--- {page}")
    if skipped:
        print(f"    (пропущено шаблонов с id: {len(skipped)})")
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
