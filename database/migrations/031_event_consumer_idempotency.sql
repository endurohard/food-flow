-- ============================================================
-- Миграция 031: Идемпотентность подписчиков событий
-- ============================================================
-- Outbox даёт гарантию at-least-once: при сбое сети одно и то же событие
-- может прийти подписчику дважды. Значит сами подписчики должны быть
-- идемпотентны, иначе появятся дубли:
--   * две доставки на один заказ;
--   * двойное начисление баллов за один заказ.
--
-- Защита ставится на уровне БД, а не кода: уникальный индекс не обойти
-- ни гонкой двух реплик, ни ошибкой в логике сервиса.
--
-- Идемпотентна: безопасно запускать повторно.
-- Date: 2026-10-14

-- ── 1. Одна доставка на заказ ───────────────────────────────────────────────
-- Сначала убираем возможные существующие дубли, оставляя самую раннюю:
-- без этого CREATE UNIQUE INDEX упадёт на грязных данных.
DELETE FROM deliveries d
USING deliveries keep
WHERE d.order_id IS NOT NULL
  AND d.order_id = keep.order_id
  AND d.created_at > keep.created_at;

-- Остатки с одинаковым created_at (до микросекунды) разруливаем по id
DELETE FROM deliveries d
USING deliveries keep
WHERE d.order_id IS NOT NULL
  AND d.order_id = keep.order_id
  AND d.created_at = keep.created_at
  AND d.id > keep.id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_deliveries_order
    ON deliveries (order_id)
    WHERE order_id IS NOT NULL;

COMMENT ON INDEX uq_deliveries_order IS
    'Одна доставка на заказ: защита от повторной обработки события order.confirmed';

-- ── 2. Одно начисление баллов на заказ ──────────────────────────────────────
-- Повторная доставка события не должна начислить баллы дважды.
-- Ограничение только на тип 'earn': списаний (redeem) по одному заказу
-- может быть несколько, и это нормально.
DELETE FROM loyalty_transactions t
USING loyalty_transactions keep
WHERE t.order_id IS NOT NULL
  AND t.transaction_type = 'earn'
  AND keep.transaction_type = 'earn'
  AND t.order_id = keep.order_id
  AND t.customer_profile_id = keep.customer_profile_id
  AND t.id > keep.id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_loyalty_earn_per_order
    ON loyalty_transactions (order_id, customer_profile_id)
    WHERE order_id IS NOT NULL AND transaction_type = 'earn';

COMMENT ON INDEX uq_loyalty_earn_per_order IS
    'Одно начисление баллов на заказ: защита от повторной обработки события order.completed';
