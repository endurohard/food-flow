#!/usr/bin/env bash
# Докат на прод: 4 коммита поверх 9ba4fae (ENCRYPTION_KEY в user-service +
# скрипты проверок). Миграций в этой пачке нет — 045 намеренно не
# закоммичена, она едет отдельно после репетиции на копии.
#
# Запускается НА СЕРВЕРЕ, вывод целиком в файл: обрыв ssh не рвёт выкат.
set -uo pipefail

cd ~/food-flow
TS="$(date +%F_%H%M%S)"
step() { echo; echo "===== $* ====="; }

step "0. Бэкап БД"
mkdir -p ~/backups/food-flow
docker exec food-flow-postgres pg_dump -U foodflow -d foodflow --clean --if-exists \
  > ~/backups/food-flow/pre_print2_${TS}.sql || { echo "ПРОВАЛ: бэкап не снят"; exit 1; }
ls -l ~/backups/food-flow/pre_print2_${TS}.sql

step "1. Сколько коммитов поедет"
git fetch -q origin main
echo "HEAD:        $(git rev-parse --short HEAD)"
echo "origin/main: $(git rev-parse --short origin/main)"
echo "коммитов к накату: $(git rev-list --count HEAD..origin/main)"
git log --oneline HEAD..origin/main

step "2. Код"
git stash -u -q || true
git pull --ff-only origin main || { echo "ПРОВАЛ: pull не прошёл"; exit 1; }
git rev-parse --short HEAD

step "3. Миграции (новых в пачке нет, но журнал сверяем)"
PG_CONTAINER=food-flow-postgres bash scripts/migrate.sh --docker 2>&1 | tail -15

step "4. ENCRYPTION_KEY реально виден контейнеру user-service"
docker compose up -d --no-build user-service
sleep 12
docker exec user-service printenv ENCRYPTION_KEY >/dev/null 2>&1 \
  && echo "ENCRYPTION_KEY: задан (длина $(docker exec user-service sh -c 'printf %s "$ENCRYPTION_KEY" | wc -c'))" \
  || echo "ПРОВАЛ: ENCRYPTION_KEY контейнеру не виден"

step "5. Состояние контейнеров"
docker ps --format '{{.Names}}\t{{.Status}}' | grep -E 'kitchen|user-service|frontend|kong-gateway'

step "6. Что отдаёт Kong по печати"
for p in /api/print-agent/jobs /api/print-agents /api/printers/stations; do
  printf '%-30s -> %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' http://localhost$p)"
done
echo "--- кнопка теста печати живая (функция определена, не только onclick)"
echo "onclick=testPrinter: $(curl -s http://localhost/admin-panel/index.html | grep -c 'onclick="testPrinter()"')"
echo "function testPrinter: $(curl -s http://localhost/admin-panel/index.html | grep -c 'async function testPrinter')"
echo "--- модальные диалоги вне комментариев (должно быть 0)"
curl -s http://localhost/admin-panel/index.html \
  | grep -nE '\b(alert|confirm|prompt)\(' | grep -vE ':\s*(//|\*|<!--)' | wc -l

step "7. Логи на ошибки старта"
for c in kitchen-service user-service; do
  echo "--- $c"
  docker logs --tail 20 "$c" 2>&1 | grep -iE 'error|listen|started|rabbit' | tail -6
done

step "ГОТОВО"
