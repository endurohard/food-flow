#!/usr/bin/env python3
"""Состояние интеграции ВАТС на проде: схема, ключ шифрования, код сервиса."""
import subprocess

PG = "food-flow-postgres"


def psql(sql, tuples=False):
    args = ["docker", "exec", "-i", PG, "psql", "-U", "foodflow", "-d", "foodflow"]
    if tuples:
        args += ["-t", "-A"]
    args += ["-c", sql]
    r = subprocess.run(args, capture_output=True, text=True)
    return ((r.stdout or "") + (r.stderr or "")).strip()


print("--- миграции 039..044 в журнале ---")
print(psql("select filename, applied_at from migration_history where filename >= '039' and filename < '045' order by filename"))

print("\n--- vats-колонки на enterprises ---")
print(psql("select column_name, data_type from information_schema.columns "
           "where table_name = 'enterprises' and column_name like 'vats%' order by ordinal_position"))

print("\n--- настройки ВАТС по предприятиям ---")
print(psql("select name, vats_enabled, coalesce(vats_host,'(нет)') as host, "
           "(vats_password is not null) as pwd_set, vats_last_error from enterprises order by created_at"))

print("\n--- журнал звонков ---")
print(psql("select count(*) as calls from vats_calls"))

print("\n--- ENCRYPTION_KEY в контейнере user-service ---")
r = subprocess.run(["docker", "exec", "user-service", "sh", "-c", "printenv ENCRYPTION_KEY | wc -c"],
                   capture_output=True, text=True)
print("длина значения (0 = не задан):", (r.stdout or "").strip() or (r.stderr or "").strip())

print("\n--- есть ли в собранном коде контейнера роут vats-settings ---")
r = subprocess.run(["docker", "exec", "user-service", "sh", "-c",
                    "grep -rl 'vats-settings' /app/dist 2>/dev/null | head -3; echo rc=$?"],
                   capture_output=True, text=True)
print((r.stdout or "").strip() or "не найден")
