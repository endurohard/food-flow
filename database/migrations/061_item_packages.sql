-- ============================================================
-- Миграция 061: фасовки поставщика в накладной
-- ============================================================
-- Поставщик продаёт «мешок 50 кг», «коробку 12 шт», «ящик 6 бут. по 1 л»,
-- а склад ведётся в кг / шт / л. Раньше кладовщик пересчитывал в уме, и
-- цена за кг получалась с ошибкой — а от неё считается себестоимость.
--
-- Теперь в позиции накладной хранится, как было в документе (3 мешка по
-- 2 400 ₽), а количество и цена за единицу склада считаются сервером.
-- Фасовка запоминается за товаром и поставщиком и подставляется в
-- следующий раз.

ALTER TABLE supply_invoice_items ADD COLUMN IF NOT EXISTS pack_name  VARCHAR(60);
ALTER TABLE supply_invoice_items ADD COLUMN IF NOT EXISTS pack_size  DECIMAL(12, 3);
ALTER TABLE supply_invoice_items ADD COLUMN IF NOT EXISTS pack_count DECIMAL(12, 3);
ALTER TABLE supply_invoice_items ADD COLUMN IF NOT EXISTS pack_price DECIMAL(12, 2);

CREATE TABLE IF NOT EXISTS item_packages (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    enterprise_id      UUID NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
    inventory_item_id  UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    supplier_id        UUID REFERENCES suppliers(id) ON DELETE CASCADE,
    name               VARCHAR(60) NOT NULL,
    units_per_pack     DECIMAL(12, 3) NOT NULL CHECK (units_per_pack > 0),
    last_pack_price    DECIMAL(12, 2),
    used_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Одна фасовка с таким названием у товара на поставщика (NULL — без поставщика)
CREATE UNIQUE INDEX IF NOT EXISTS uq_item_packages
    ON item_packages (inventory_item_id, COALESCE(supplier_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
CREATE INDEX IF NOT EXISTS idx_item_packages_item ON item_packages (inventory_item_id, used_at DESC);
