#!/bin/bash
set -e

# Auto-apply migrations from /migrations/ on database init.
# Tracks applied migrations in migration_history table.
# Runs as part of docker-entrypoint-initdb.d (only on fresh DB init).

MIGRATIONS_DIR="/migrations"

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "[migrations] No migrations directory mounted at $MIGRATIONS_DIR, skipping."
  exit 0
fi

echo "[migrations] Creating migration_history table if not exists..."
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE TABLE IF NOT EXISTS migration_history (
    id SERIAL PRIMARY KEY,
    filename VARCHAR(255) NOT NULL UNIQUE,
    applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );
EOSQL

for f in "$MIGRATIONS_DIR"/*.sql; do
  [ -f "$f" ] || continue
  BASENAME=$(basename "$f")

  ALREADY=$(psql -t -A -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -c "SELECT COUNT(*) FROM migration_history WHERE filename = '$BASENAME'")

  if [ "$ALREADY" -gt 0 ]; then
    echo "[migrations] Skipping $BASENAME (already applied)"
    continue
  fi

  echo "[migrations] Applying $BASENAME..."
  psql -v ON_ERROR_STOP=0 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f "$f"

  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -c "INSERT INTO migration_history (filename) VALUES ('$BASENAME')"

  echo "[migrations] $BASENAME applied successfully."
done

echo "[migrations] All migrations processed."
