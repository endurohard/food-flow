#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Живой сценарий печати через агента на проде.

Проверяем ровно то, ради чего делалась фича: сервер не печатает сам, а ставит
задание в очередь; агент (ЛЮБАЯ машина, подключающаяся исходящим соединением)
забирает своё задание, печатает и отчитывается; журнал печати это видит.

Роль агента играет этот скрипт: ходит по тем же HTTP-эндпоинтам, что настоящий
агент на кухне. Принтера нет, поэтому отчёт отправляем и успешный, и неуспешный —
проверяем обе ветки.

Уборка в начале и в конце: прогон повторяемый.
Все проверки — ДО уборки.
"""
import json
import subprocess
import sys
import urllib.error
import urllib.request

PG = "food-flow-postgres"
MARK = "ЖИВАЯ-ПРОВЕРКА-ПЕЧАТИ"
BASE = "http://localhost"

failures = []


def q(sql):
    """psql -t -A с отбросом отчётов команд (INSERT 0 1 и т.п.)."""
    r = subprocess.run(
        ["docker", "exec", PG, "psql", "-U", "foodflow", "-d", "foodflow", "-t", "-A", "-F", "|", "-c", sql],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        print("SQL ОШИБКА:", sql[:120])
        print(r.stderr.strip()[:500])
        return []
    out = []
    for line in r.stdout.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        if line.split()[0] in ("INSERT", "UPDATE", "DELETE", "BEGIN", "COMMIT", "SELECT", "ROLLBACK"):
            continue
        out.append(line)
    return out


def die(msg):
    print("\n!!! ПРОВЕРКА НЕ СОСТОЯЛАСЬ:", msg)
    cleanup()
    sys.exit(1)


def cleanup():
    q(f"DELETE FROM print_jobs WHERE preview LIKE '%{MARK}%'")
    q(f"DELETE FROM printer_stations WHERE name LIKE '%{MARK}%'")
    q(f"DELETE FROM print_agents WHERE name LIKE '%{MARK}%'")


def http(method, path, token=None, body=None, agent_token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    if agent_token:
        req.add_header("X-Agent-Token", agent_token)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw.strip().startswith(("{", "[")) else raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        return e.code, (json.loads(raw) if raw.strip().startswith(("{", "[")) else raw)
    except Exception as e:
        return 0, str(e)


def check(name, ok, detail=""):
    print(("  ✔ " if ok else "  ✘ ") + name + (("  " + str(detail)) if detail else ""))
    if not ok:
        failures.append(name)


print("===== 0. Уборка перед прогоном")
cleanup()

print("===== 1. Подопытное предприятие: нужны И точка, И пользователь с правом управления")
# Роли берём фактические из enum user_role (restaurant_owner/admin/super_admin),
# а не угаданные: 'owner' в этом типе нет, и запрос по нему падает.
rows = q("""SELECT e.id, r.id, e.name, u.id, u.email, u.role
              FROM enterprises e
              JOIN restaurants r ON r.enterprise_id = e.id
              JOIN users u ON u.enterprise_id = e.id
             WHERE u.role IN ('restaurant_owner', 'admin')
             ORDER BY e.created_at
             LIMIT 1""")
if not rows:
    die("нет предприятия, у которого есть и точка, и пользователь с ролью restaurant_owner/admin")
ent_id, rest_id, ent_name, uid, uemail, urole = rows[0].split("|")
print(f"  предприятие {ent_name} ({ent_id}), точка {rest_id}")

print("===== 2. JWT этого пользователя (внутри контейнера, где есть JWT_SECRET)")
print(f"  пользователь {uemail} ({urole})")

jwt_code = (
    "const jwt=require('jsonwebtoken');"
    f"console.log(jwt.sign({{userId:'{uid}',email:'{uemail}',role:'{urole}',"
    f"enterpriseId:'{ent_id}'}},process.env.JWT_SECRET,{{expiresIn:'1h'}}))"
)
r = subprocess.run(["docker", "exec", "user-service", "node", "-e", jwt_code],
                   capture_output=True, text=True)
token = r.stdout.strip()
if not token or token.count(".") != 2:
    die("не удалось собрать JWT: " + (r.stderr.strip()[:300] or "пустой вывод"))
print("  токен получен")

print("===== 3. Агент создаётся через API, токен отдаётся один раз")
st, body = http("POST", "/api/print-agents", token=token,
                body={"name": f"{MARK} кухня", "restaurantId": rest_id})
check("POST /api/print-agents отдаёт 201", st == 201, f"HTTP {st}")
if st != 201:
    die(f"агент не создан: {body}")
agent_id = body["data"]["id"]
agent_token = body.get("token")
check("токен агента пришёл в ответе", bool(agent_token))
check("в ответе есть предупреждение про единственный показ", bool(body.get("tokenNotice")))

hash_rows = q(f"SELECT token_hash FROM print_agents WHERE id = '{agent_id}'")
check("в базе лежит хеш, а не сам токен",
      bool(hash_rows) and agent_token not in hash_rows[0] and len(hash_rows[0]) == 64,
      hash_rows[0][:16] + "…" if hash_rows else "нет строки")

st, lst = http("GET", "/api/print-agents", token=token)
listed = [a for a in (lst.get("data") or []) if a["id"] == agent_id]
check("агент виден в списке", bool(listed))
check("токен НЕ отдаётся в списке агентов",
      not any("token" in k.lower() and k != "tokenNotice" for a in listed for k in a.keys()),
      list(listed[0].keys()) if listed else "")

print("===== 4. Станция печати, привязанная к агенту")
# Имена колонок взяты из information_schema, а не угаданы: в printer_stations
# нет restaurant_id, а тип и адрес принтера зовутся type/address.
srows = q(f"""INSERT INTO printer_stations
                (enterprise_id, name, type, address, agent_id, enabled)
              VALUES ('{ent_id}', '{MARK} станция', 'network', '192.168.77.77:9100',
                      '{agent_id}', true)
              RETURNING id""")
if not srows:
    die("станция не создалась — смотри ошибку SQL выше")
station_id = srows[0]
print(f"  станция {station_id}")

print("===== 5. Тестовый чек: сервер обязан поставить задание в очередь, а не печатать сам")
st, body = http("POST", f"/api/print-agents/{agent_id}/test", token=token,
                body={"stationId": station_id})
check("POST /:id/test отдаёт 200", st == 200, f"HTTP {st} {body if st != 200 else ''}")
if st != 200:
    die(f"задание не поставлено: {body}")
job_id = body["data"]["jobId"]
check("ответ не обещает печать, пока агент не отчитался",
      body.get("agentOnline") is False and "не на связи" in body.get("message", ""),
      body.get("message"))

jrows = q(f"SELECT status, kind, copies, agent_id, station_id FROM print_jobs WHERE id = '{job_id}'")
check("задание лежит в print_jobs со статусом queued",
      bool(jrows) and jrows[0].split("|")[0] == "queued", jrows[0] if jrows else "нет строки")
check("задание привязано к агенту и станции",
      bool(jrows) and jrows[0].split("|")[3] == agent_id and jrows[0].split("|")[4] == str(station_id))

print("===== 6. Роль агента: забираем очередь своим токеном")
st, hello = http("POST", "/api/print-agent/hello", agent_token=agent_token,
                 body={"agentVersion": "1.0.0-live-check", "platform": "linux", "hostname": "live-check"})
check("POST /api/print-agent/hello отдаёт 200", st == 200, f"HTTP {st}")
st, jobs = http("GET", "/api/print-agent/jobs", agent_token=agent_token)
check("GET /api/print-agent/jobs отдаёт 200", st == 200, f"HTTP {st}")
mine = [j for j in (jobs.get("data") or jobs.get("jobs") or []) if j.get("id") == job_id]
check("агент получил СВОЁ задание", bool(mine), f"в очереди {len(jobs.get('data') or [])} заданий")
if mine:
    check("в задании есть готовые байты ESC/POS", bool(mine[0].get("payload")),
          f"{len(str(mine[0].get('payload') or ''))} симв. base64")

claimed = q(f"SELECT status, claimed_at IS NOT NULL FROM print_jobs WHERE id = '{job_id}'")
check("после выдачи задание помечено in_progress",
      bool(claimed) and claimed[0].split("|")[0] == "in_progress", claimed[0] if claimed else "")

print("===== 7. Чужой токен не даёт доступа к очереди")
# Токен только ASCII: кириллица в HTTP-заголовке роняет сам urllib
# (UnicodeEncodeError, latin-1) — и падение скрипта выглядит как дефект сервера.
st, body = http("GET", "/api/print-agent/jobs", agent_token="definitely-wrong-token")
check("неверный токен агента даёт 401", st == 401, f"HTTP {st} {body}")
st, _ = http("GET", "/api/print-agent/jobs")
check("запрос к очереди вовсе без токена даёт 401", st == 401, f"HTTP {st}")
st, _ = http("GET", "/api/print-agents", token=None)
check("админский список без JWT даёт 401", st == 401, f"HTTP {st}")

print("===== 8. Отчёт агента о неудаче: ошибка видна в учёте, а не проглочена")
st, _ = http("POST", f"/api/print-agent/jobs/{job_id}/result", agent_token=agent_token,
             body={"ok": False, "error": "принтер недоступен (живая проверка)"})
check("POST /jobs/:id/result (ok:false) отдаёт 200", st == 200, f"HTTP {st}")
frows = q(f"SELECT status, attempts, last_error FROM print_jobs WHERE id = '{job_id}'")
check("ошибка печати сохранена в задании",
      bool(frows) and "принтер недоступен" in frows[0], frows[0] if frows else "")
# Пока попытки не исчерпаны (MAX_ATTEMPTS=5), задание ОБЯЗАНО вернуться в очередь:
# чек на кухне должен выйти после починки принтера, а не потеряться с первой ошибки.
check("задание вернулось в очередь на повтор, а не потерялось",
      bool(frows) and frows[0].split("|")[0] == "queued", frows[0] if frows else "")

print("===== 8a. Попытки исчерпаны — задание фиксируется как failed, а не крутится вечно")
for _ in range(6):
    http("GET", "/api/print-agent/jobs", agent_token=agent_token)
    http("POST", f"/api/print-agent/jobs/{job_id}/result", agent_token=agent_token,
         body={"ok": False, "error": "принтер недоступен (живая проверка)"})
erows = q(f"SELECT status, attempts FROM print_jobs WHERE id = '{job_id}'")
check("после исчерпания попыток статус failed",
      bool(erows) and erows[0].split("|")[0] == "failed", erows[0] if erows else "")

print("===== 9. Отчёт об успехе: задание закрывается, время печати фиксируется")
st, body = http("POST", f"/api/print-agents/{agent_id}/test", token=token,
                body={"stationId": station_id})
job2 = body.get("data", {}).get("jobId")
if not job2:
    die(f"второе задание не поставлено: {body}")
http("GET", "/api/print-agent/jobs", agent_token=agent_token)
st, _ = http("POST", f"/api/print-agent/jobs/{job2}/result", agent_token=agent_token,
             body={"ok": True})
check("POST /jobs/:id/result (ok:true) отдаёт 200", st == 200, f"HTTP {st}")
drows = q(f"SELECT status, printed_at IS NOT NULL FROM print_jobs WHERE id = '{job2}'")
check("задание стало done и у него есть printed_at",
      bool(drows) and drows[0] == "done|t", drows[0] if drows else "")

print("===== 10. Журнал печати в админке видит оба задания")
st, jl = http("GET", "/api/print-agents/jobs/list?limit=100", token=token)
ids = [j["id"] for j in (jl.get("data") or [])]
check("журнал отдаёт 200", st == 200, f"HTTP {st}")
check("в журнале есть неудачное задание", job_id in ids)
check("в журнале есть успешное задание", job2 in ids)
st, pv = http("GET", f"/api/print-agents/jobs/{job2}/preview", token=token)
check("предпросмотр чека доступен без принтера",
      st == 200 and bool((pv.get("data") or {}).get("preview")), f"HTTP {st}")

print("===== 11. Изоляция предприятий: чужой агент недоступен")
orows = q(f"""SELECT id FROM enterprises WHERE id <> '{ent_id}' ORDER BY created_at LIMIT 1""")
if orows:
    other_ent = orows[0]
    jwt2 = (
        "const jwt=require('jsonwebtoken');"
        f"console.log(jwt.sign({{userId:'{uid}',email:'{uemail}',role:'{urole}',"
        f"enterpriseId:'{other_ent}'}},process.env.JWT_SECRET,{{expiresIn:'1h'}}))"
    )
    r2 = subprocess.run(["docker", "exec", "user-service", "node", "-e", jwt2],
                        capture_output=True, text=True)
    t2 = r2.stdout.strip()
    st, body = http("POST", f"/api/print-agents/{agent_id}/test", token=t2, body={})
    check("тест чужого агента даёт 404, а не печать", st == 404, f"HTTP {st}")
    st, jl2 = http("GET", "/api/print-agents/jobs/list?limit=100", token=t2)
    ids2 = [j["id"] for j in (jl2.get("data") or [])]
    check("чужие задания не видны в журнале другого предприятия",
          job_id not in ids2 and job2 not in ids2)
else:
    print("  (пропуск: второго предприятия нет)")

print("===== 12. Уборка")
cleanup()
left = q(f"""SELECT (SELECT count(*) FROM print_agents WHERE name LIKE '%{MARK}%')
             || '|' || (SELECT count(*) FROM print_jobs WHERE preview LIKE '%{MARK}%')
             || '|' || (SELECT count(*) FROM printer_stations WHERE name LIKE '%{MARK}%')""")
check("база вернулась к исходному состоянию", left and left[0] == "0|0|0", left[0] if left else "")

print()
if failures:
    print(f"ИТОГ: ПРОВАЛЕНО {len(failures)} проверок:")
    for f in failures:
        print("  -", f)
    sys.exit(1)
print("ИТОГ: все проверки прошли")
