-- Migration: Add 'cashier' enterprise role
-- Description: Кассир — сотрудник, который только оформляет продажи на кассе (pos.html).
--              Расширяет CHECK на enterprise_users.role, введённый миграцией 019.
-- Идемпотентна: безопасно запускать повторно.
-- Date: 2026-09-01

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'enterprise_users_role_check'
          AND conrelid = 'enterprise_users'::regclass
    ) THEN
        ALTER TABLE enterprise_users DROP CONSTRAINT enterprise_users_role_check;
    END IF;
END $$;

ALTER TABLE enterprise_users
    ADD CONSTRAINT enterprise_users_role_check
    CHECK (role IN ('owner', 'admin', 'manager', 'operator', 'chef', 'waiter', 'cashier', 'employee', 'viewer'));

COMMENT ON COLUMN enterprise_users.role IS
    'Operational role within enterprise: owner, admin, manager, operator, chef, waiter, cashier, employee, viewer';
