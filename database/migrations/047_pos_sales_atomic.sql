-- ============================================================
-- Миграция 047: атомарные продажи POS
-- ============================================================
-- Один sale_id в рамках предприятия соответствует ровно одной продаже.
-- Заказ, платёж и кассовая операция создаются одной транзакцией; повторный
-- запрос возвращает response_data и не двигает деньги повторно.

CREATE TABLE IF NOT EXISTS pos_sales (
    enterprise_id      UUID NOT NULL REFERENCES enterprises(id) ON DELETE RESTRICT,
    sale_id            UUID NOT NULL,
    request_hash       VARCHAR(64) NOT NULL,
    status             VARCHAR(20) NOT NULL DEFAULT 'processing'
                       CHECK (status IN ('processing', 'completed')),
    restaurant_id      UUID NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
    register_id        UUID REFERENCES cash_registers(id) ON DELETE RESTRICT,
    cashier_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    order_type         VARCHAR(20) NOT NULL,
    payment_method     VARCHAR(20) NOT NULL,
    order_id           UUID REFERENCES orders(id) ON DELETE RESTRICT,
    payment_id         UUID REFERENCES payments(id) ON DELETE RESTRICT,
    cash_operation_id  UUID REFERENCES cash_operations(id) ON DELETE RESTRICT,
    total              DECIMAL(12, 2),
    response_data      JSONB,
    created_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    completed_at       TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (enterprise_id, sale_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_sales_order
    ON pos_sales(order_id) WHERE order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_sales_payment
    ON pos_sales(payment_id) WHERE payment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_sales_cash_operation
    ON pos_sales(cash_operation_id) WHERE cash_operation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pos_sales_restaurant_created
    ON pos_sales(restaurant_id, created_at DESC);

COMMENT ON TABLE pos_sales IS
    'Идемпотентный журнал POS: одна локальная продажа создаёт заказ, платёж и движение кассы одной транзакцией';
