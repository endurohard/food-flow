-- ============================================================
-- Миграция 054: возвраты и правка чеков на кассе по PIN администратора
-- ============================================================
-- Кассир открывает пробитый чек и делает возврат (весь или части позиций)
-- либо правит его (убрать позиции, сменить способ оплаты). Каждое такое
-- действие подтверждает PIN владельца или админа организации — кассир один
-- вернуть деньги не может. Возврат возвращает деньги (наличные — из кассы)
-- и товар на склад — ровно то, что списала строка чека.

-- Строка чека, к которой относится списание: по ней возврат вернёт на склад
-- именно расход этой позиции (а не «пропорционально всему чеку»)
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS order_item_id UUID
  REFERENCES order_items(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_stock_movements_order_item
  ON stock_movements(order_item_id) WHERE order_item_id IS NOT NULL;

-- Сколько штук строки уже возвращено: второй возврат той же позиции не пройдёт
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS refunded_quantity INTEGER NOT NULL DEFAULT 0;
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_refunded_le_quantity;
ALTER TABLE order_items ADD CONSTRAINT order_items_refunded_le_quantity
  CHECK (refunded_quantity >= 0 AND refunded_quantity <= quantity);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_amount DECIMAL(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_refunded_le_total;
ALTER TABLE orders ADD CONSTRAINT orders_refunded_le_total
  CHECK (refunded_amount >= 0 AND refunded_amount <= total);

CREATE TABLE IF NOT EXISTS pos_refunds (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    enterprise_id      UUID NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
    -- Идемпотентность: повтор запроса с тем же refund_id не вернёт деньги дважды
    refund_id          UUID NOT NULL,
    restaurant_id      UUID NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
    register_id        UUID REFERENCES cash_registers(id) ON DELETE SET NULL,
    order_id           UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    kind               VARCHAR(20) NOT NULL CHECK (kind IN ('refund', 'payment_change')),
    items              JSONB NOT NULL DEFAULT '[]'::jsonb,
    amount             DECIMAL(12, 2) NOT NULL CHECK (amount >= 0),
    payment_method     VARCHAR(20) NOT NULL,
    new_payment_method VARCHAR(20),
    reason             VARCHAR(500),
    cashier_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    approved_by        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    cash_operation_id  UUID REFERENCES cash_operations(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (enterprise_id, refund_id)
);
CREATE INDEX IF NOT EXISTS idx_pos_refunds_order ON pos_refunds(order_id);

-- Подбор PIN администратора с планшета: после 5 ошибок подтверждение
-- на этой смене кассы закрывается на 5 минут
ALTER TABLE cash_register_sessions ADD COLUMN IF NOT EXISTS approve_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cash_register_sessions ADD COLUMN IF NOT EXISTS approve_locked_until TIMESTAMPTZ;
