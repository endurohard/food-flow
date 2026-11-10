-- ============================================================
-- Миграция 059: фото накладной из Telegram
-- ============================================================
-- Ответственный за закуп фотографирует накладную и отправляет боту
-- организации — на складе появляется черновик накладной с этим фото.
-- Позиции вносятся по фото, затем накладная принимается как обычно.
--
-- photo_url (была с 010, не использовалась) хранит путь к файлу внутри
-- хранилища склада. telegram_file_id — защита от двойного черновика, если
-- одно и то же обновление бота прочитают дважды.

ALTER TABLE supply_invoices ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'manual';
ALTER TABLE supply_invoices ADD COLUMN IF NOT EXISTS telegram_file_id VARCHAR(128);
ALTER TABLE supply_invoices ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_supply_invoices_telegram_file
    ON supply_invoices (enterprise_id, telegram_file_id)
 WHERE telegram_file_id IS NOT NULL;
