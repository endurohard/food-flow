-- ============================================================
-- Миграция 057: ответственные за закуп
-- ============================================================
-- Владелец или админ назначает одного или нескольких сотрудников
-- «ответственными за закуп» на всю организацию. Они получают в Telegram
-- «пора заказать» (остаток позиции дошёл до inventory_items.min_stock)
-- вместе с владельцем и админами — без повышения их роли.
--
-- Флаг лежит в enterprise_users, а не отдельной таблицей: сотрудника
-- убрали из организации — пропало и назначение, ничего не надо чистить.

ALTER TABLE enterprise_users
    ADD COLUMN IF NOT EXISTS is_purchaser BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_enterprise_users_purchasers
    ON enterprise_users (enterprise_id) WHERE is_purchaser;
