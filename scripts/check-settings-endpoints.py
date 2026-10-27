#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Проверка эндпоинтов, которые зовёт settings.html, от имени ВЛАДЕЛЬЦА.

Повод: экран настроек зовёт GET и PUT /api/enterprises/:id, а в
enterprise.routes.ts таких роутов не видно — есть PATCH /:id под
requireSuperAdmin. Если роутов действительно нет, то настройки предприятия
(название, функционал, тип заведения) не читаются и не сохраняются у
владельца, а экран показывает ошибку или молча не применяет изменения.

Скрипт ТОЛЬКО читает: PUT отправляется с тем значением, которое уже стоит в
базе, поэтому ничего не меняет. Значение считывается перед запросом.
"""
import json
import subprocess
import sys
import urllib.error
import urllib.request

BASE = "http://localhost"
PG = "food-flow-postgres"


def sh(cmd):
    return subprocess.run(cmd, capture_output=True, text=True).stdout


def q(sql):
    out = sh(["docker", "exec", PG, "psql", "-U", "foodflow", "-d", "foodflow",
              "-t", "-A", "-F", "|", "-c", sql])
    return [l.strip() for l in out.strip().split("\n")
            if l.strip() and l.split()[0] not in
            ("INSERT", "UPDATE", "DELETE", "SELECT", "BEGIN", "COMMIT")]


def http(method, path, token, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            raw = r.read().decode(errors="replace")
            return r.status, raw[:400]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")[:400]
    except Exception as e:
        return 0, str(e)[:200]


rows = q("""SELECT e.id, e.name, u.id, u.email, u.role
              FROM enterprises e
              JOIN users u ON u.enterprise_id = e.id
             WHERE u.role IN ('restaurant_owner','admin')
             ORDER BY e.created_at LIMIT 1""")
if not rows:
    print("ПРОВЕРКА НЕ СОСТОЯЛАСЬ: нет владельца предприятия")
    sys.exit(1)
ent, ent_name, uid, uemail, urole = rows[0].split("|")
print(f"предприятие {ent_name} ({ent}), владелец {uemail} ({urole})\n")

code = ("const jwt=require('jsonwebtoken');"
        f"console.log(jwt.sign({{userId:'{uid}',email:'{uemail}',role:'{urole}',"
        f"enterpriseId:'{ent}'}},process.env.JWT_SECRET,{{expiresIn:'1h'}}))")
token = sh(["docker", "exec", "user-service", "node", "-e", code]).strip()
if token.count(".") != 2:
    print("ПРОВЕРКА НЕ СОСТОЯЛАСЬ: не собрался JWT")
    sys.exit(1)

# Текущее значение business_type, чтобы PUT ничего не изменил
cur = q(f"SELECT business_type FROM enterprises WHERE id = '{ent}'")
cur_type = cur[0] if cur else "restaurant"
print(f"текущий business_type: {cur_type} (PUT отправим с ним же — ничего не меняем)\n")

checks = [
    ("GET", f"/api/enterprises/{ent}", None, "чтение настроек предприятия"),
    ("GET", "/api/enterprises/my", None, "альтернатива: свои настройки"),
    ("PUT", f"/api/enterprises/{ent}", {"business_type": cur_type}, "сохранение типа заведения"),
    ("PATCH", f"/api/enterprises/{ent}", {"business_type": cur_type}, "PATCH (он есть в роутах)"),
]

for method, path, body, what in checks:
    st, resp = http(method, path, token, body)
    mark = "  " if st < 400 else "!!"
    print(f"{mark} {method:6} {st}  {path}")
    print(f"        {what}")
    if st >= 400:
        print(f"        ответ: {resp[:200]}")
    print()
