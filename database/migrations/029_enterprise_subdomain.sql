-- Migration: поддомен организации
-- Description: enterprises.subdomain — метка для адреса вида <subdomain>.food-flow.ru.
--              По ней фронт и API определяют арендатора до входа (экран логина
--              показывает организацию), а wildcard-маршрут в Kong отдаёт один и тот же стек.
--              Хранится в нижнем регистре: DNS-имена регистронезависимы, а сравнение
--              с Host-заголовком идёт строкой.
-- Идемпотентна.
-- Date: 2026-09-14

ALTER TABLE enterprises ADD COLUMN IF NOT EXISTS subdomain VARCHAR(63);

-- Формат метки DNS: строчные буквы/цифры/дефис, не начинается и не заканчивается дефисом.
-- Длина 2..63 — верхняя граница из RFC 1035, нижняя чтобы не плодить односимвольные.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'enterprises_subdomain_format'
          AND conrelid = 'enterprises'::regclass
    ) THEN
        ALTER TABLE enterprises
            ADD CONSTRAINT enterprises_subdomain_format
            CHECK (subdomain IS NULL OR subdomain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])$');
    END IF;
END $$;

-- Уникальность только среди заполненных: NULL допускается у организаций без поддомена.
CREATE UNIQUE INDEX IF NOT EXISTS idx_enterprises_subdomain
    ON enterprises (subdomain) WHERE subdomain IS NOT NULL;

COMMENT ON COLUMN enterprises.subdomain IS
    'DNS-метка организации: <subdomain>.food-flow.ru. Только [a-z0-9-], уникальна среди заполненных.';
