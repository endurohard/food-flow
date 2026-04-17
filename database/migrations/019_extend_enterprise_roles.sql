-- Migration: Extend enterprise_users.role CHECK constraint
-- Description: Adds CHECK constraint restricting enterprise_users.role to known values.
-- Adds operational roles (operator, chef, waiter) used by frontend RBAC.
-- Idempotent: safe to run multiple times.
-- Date: 2026-04-17

DO $$
BEGIN
    -- Drop existing CHECK constraint if present (idempotency)
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'enterprise_users_role_check'
          AND conrelid = 'enterprise_users'::regclass
    ) THEN
        ALTER TABLE enterprise_users DROP CONSTRAINT enterprise_users_role_check;
    END IF;
END $$;

-- Normalize any unexpected legacy values to 'employee' before adding the constraint.
-- This prevents constraint violation on existing rows.
UPDATE enterprise_users
SET role = 'employee'
WHERE role IS NULL
   OR role NOT IN ('owner', 'admin', 'manager', 'operator', 'chef', 'waiter', 'employee', 'viewer');

-- Add unified CHECK constraint with extended role set.
ALTER TABLE enterprise_users
    ADD CONSTRAINT enterprise_users_role_check
    CHECK (role IN ('owner', 'admin', 'manager', 'operator', 'chef', 'waiter', 'employee', 'viewer'));

COMMENT ON COLUMN enterprise_users.role IS
    'Operational role within enterprise: owner, admin, manager, operator, chef, waiter, employee, viewer';
