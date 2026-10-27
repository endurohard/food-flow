#!/usr/bin/env bash
# Выкат на прод: касса (страница скачивания + APK) и агенты печати.
# Запускается НА СЕРВЕРЕ (iTTEST), вывод целиком в файл.
#
# Порядок: бэкап → код → миграции → образы → здоровье → проверка того,
# что реально отдаёт Kong. Живой сценарий печати — отдельным шагом,
# в этот скрипт не вклеивается.
set -uo pipefail

cd ~/food-flow
TS="$(date +%F_%H%M%S)"
step() { echo; echo "===== $* ====="; }

step "0. Бэкап БД"
mkdir -p ~/backups/food-flow
docker exec food-flow-postgres pg_dump -U foodflow -d foodflow --clean --if-exists \
  > ~/backups/food-flow/pre_pos_${TS}.sql || { echo "ПРОВАЛ: бэкап не снят"; exit 1; }
ls -l ~/backups/food-flow/pre_pos_${TS}.sql

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

step "3. Миграции"
PG_CONTAINER=food-flow-postgres bash scripts/migrate.sh --docker 2>&1 | tail -30

step "3a. Схема после миграции"
docker exec food-flow-postgres psql -U foodflow -d foodflow -c \
  "SELECT table_name FROM information_schema.tables
    WHERE table_name IN ('print_agents','print_jobs') ORDER BY 1;"
docker exec food-flow-postgres psql -U foodflow -d foodflow -c \
  "SELECT conname FROM pg_constraint
    WHERE conrelid='print_jobs'::regclass AND contype='c' ORDER BY 1;"
docker exec food-flow-postgres psql -U foodflow -d foodflow -c \
  "SELECT column_name FROM information_schema.columns
    WHERE table_name='printer_stations' AND column_name='agent_id';"
docker exec food-flow-postgres psql -U foodflow -d foodflow -c \
  "SELECT column_name FROM information_schema.columns
    WHERE table_name='enterprises' AND column_name LIKE 'vats%' ORDER BY 1;"

step "4. Сборка образов (kitchen-service, user-service, frontend-service)"
for s in kitchen-service user-service frontend-service; do
  echo "--- $s"
  docker build --network host -q -t food-flow-${s}:latest services/${s} \
    || { echo "ПРОВАЛ: не собрался $s"; exit 1; }
done

step "5. Перезапуск сервисов"
docker compose up -d --no-build kitchen-service user-service frontend-service
sleep 20

step "5a. Uptime контейнеров (доказательство пересборки)"
docker ps --format '{{.Names}}\t{{.Status}}' | grep -E 'kitchen|user-service|frontend' || true

step "6. Kong: перечитать декларативный конфиг (новые роуты /downloads, /api/print-agent*)"
docker exec kong-gateway kong reload 2>&1 | tail -5
sleep 5

step "7. Что отдаёт Kong"
for p in /api/print-agent/jobs /api/print-agents /downloads/pos.json /downloads/pos.apk; do
  printf '%-28s -> %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' http://localhost$p)"
done
echo "--- страница скачивания"
curl -s -o /dev/null -w 'pos-download.html -> %{http_code}\n' http://localhost/admin-panel/pos-download.html
curl -s http://localhost/admin-panel/pos-download.html | grep -c 'pos-binding.js'
echo "--- модальные диалоги на странице (должно быть 0 вне комментариев)"
curl -s http://localhost/admin-panel/pos-download.html \
  | grep -nE '\b(alert|confirm|prompt)\(' | grep -vE '^\s*[0-9]+:\s*(//|\*|<!--)' | wc -l
echo "--- ссылка на страницу в настройках"
curl -s http://localhost/admin-panel/settings.html | grep -c 'pos-download.html'
echo "--- раздел агентов печати в админке"
curl -s http://localhost/admin-panel/index.html | grep -c 'print-agents'

step "8. Логи сервисов на ошибки старта"
for c in kitchen-service user-service; do
  echo "--- $c"
  docker logs --tail 15 "$c" 2>&1 | grep -iE 'error|listen|started|rabbit' | tail -8
done

step "ГОТОВО"
