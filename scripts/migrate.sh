#!/usr/bin/env bash
# Применение миграций к УЖЕ РАБОТАЮЩЕЙ базе.
#
# Зачем отдельно от database/init/03-run-migrations.sh: тот скрипт лежит в
# docker-entrypoint-initdb.d и выполняется ТОЛЬКО при первичной инициализации
# пустого кластера. На проде, где данные уже есть, он не запускается никогда —
# новые миграции надо накатывать этим скриптом.
#
# Отличия от init-версии:
#   * работает против любой базы по DATABASE_URL (прод, стейдж, локально);
#   * ON_ERROR_STOP=1 — упавшая миграция НЕ помечается применённой;
#   * каждая миграция в отдельной транзакции (--single-transaction);
#   * режим --dry-run показывает, что будет применено, ничего не меняя.
#
# Использование:
#   DATABASE_URL=postgresql://user:pass@host:5432/db ./scripts/migrate.sh
#   ./scripts/migrate.sh --dry-run
#   ./scripts/migrate.sh --docker          # внутрь контейнера food-flow-postgres
set -euo pipefail

MIGRATIONS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/database/migrations"
DRY_RUN=0
USE_DOCKER=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --docker)  USE_DOCKER=1 ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Неизвестный аргумент: $arg" >&2; exit 2 ;;
  esac
done

# ── как выполнять psql ────────────────────────────────────────────────────────
if [ "$USE_DOCKER" -eq 1 ]; then
  CONTAINER="${PG_CONTAINER:-food-flow-postgres}"
  PG_USER="${POSTGRES_USER:-foodflow}"
  PG_DB="${POSTGRES_DB:-foodflow}"
  if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    echo "ОШИБКА: контейнер $CONTAINER не запущен." >&2
    exit 1
  fi
  psql_q()  { docker exec -i "$CONTAINER" psql -t -A -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" -c "$1"; }
  psql_f()  { docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 --single-transaction -U "$PG_USER" -d "$PG_DB" -f - ; }
  TARGET="контейнер $CONTAINER, база $PG_DB"
else
  if [ -z "${DATABASE_URL:-}" ]; then
    echo "ОШИБКА: задайте DATABASE_URL или запустите с --docker." >&2
    echo "Пример: DATABASE_URL=postgresql://foodflow:pass@localhost:5432/foodflow $0" >&2
    exit 1
  fi
  command -v psql >/dev/null || { echo "ОШИБКА: psql не найден в PATH." >&2; exit 1; }
  psql_q()  { psql -t -A -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "$1"; }
  psql_f()  { psql -v ON_ERROR_STOP=1 --single-transaction "$DATABASE_URL" -f - ; }
  # Не печатаем пароль в лог
  TARGET="$(printf '%s' "$DATABASE_URL" | sed -E 's#(//[^:]+):[^@]*@#\1:***@#')"
fi

echo "Цель: $TARGET"
echo "Миграции: $MIGRATIONS_DIR"
[ "$DRY_RUN" -eq 1 ] && echo "РЕЖИМ: dry-run, изменения не вносятся"
echo

# ── таблица учёта (та же, что у init-скрипта) ────────────────────────────────
if [ "$DRY_RUN" -eq 0 ]; then
  psql_q "CREATE TABLE IF NOT EXISTS migration_history (
            id SERIAL PRIMARY KEY,
            filename VARCHAR(255) NOT NULL UNIQUE,
            applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );" >/dev/null
fi

applied=0
skipped=0
failed=0

shopt -s nullglob
for f in "$MIGRATIONS_DIR"/*.sql; do
  name="$(basename "$f")"

  # Экранируем кавычки в имени файла для безопасного SQL-литерала
  safe_name="${name//\'/\'\'}"

  already="$(psql_q "SELECT COUNT(*) FROM migration_history WHERE filename = '$safe_name'" 2>/dev/null || echo 0)"
  already="$(printf '%s' "$already" | tr -d '[:space:]')"

  if [ "${already:-0}" -gt 0 ]; then
    skipped=$((skipped + 1))
    continue
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  [будет применена] $name"
    applied=$((applied + 1))
    continue
  fi

  echo "  [применяю] $name"
  # ON_ERROR_STOP=1 + одна транзакция: при ошибке миграция откатывается
  # целиком и НЕ помечается применённой (в отличие от init-скрипта).
  if psql_f < "$f"; then
    psql_q "INSERT INTO migration_history (filename) VALUES ('$safe_name')" >/dev/null
    echo "  [ок] $name"
    applied=$((applied + 1))
  else
    echo "  [ОШИБКА] $name — откат выполнен, миграция НЕ помечена применённой." >&2
    failed=1
    break
  fi
done

echo
if [ "$DRY_RUN" -eq 1 ]; then
  echo "Итог dry-run: к применению $applied, уже применено $skipped."
  exit 0
fi

echo "Итог: применено $applied, пропущено (уже было) $skipped."
if [ "$failed" -ne 0 ]; then
  echo "Выполнение остановлено на ошибке — исправьте миграцию и запустите снова." >&2
  exit 1
fi
