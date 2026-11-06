-- ============================================================
-- Миграция 051: отложенные (открытые) чеки режима кассы
-- ============================================================
-- Кассир откладывает собранный чек («за столиком», «подойдёт позже») и
-- оплачивает его потом, на любом планшете точки. Пока чек открыт, это только
-- черновик состава: ни заказа, ни денег, ни списания склада. Цены берутся в
-- момент оплаты сервером — отложенный чек не фиксирует старую цену.
-- Оплата помечает чек в той же транзакции, что и продажа (pos_sales).

CREATE TABLE IF NOT EXISTS pos_open_checks (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    enterprise_id  UUID NOT NULL REFERENCES enterprises(id) ON DELETE CASCADE,
    restaurant_id  UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    label          VARCHAR(100) NOT NULL,
    items          JSONB NOT NULL DEFAULT '[]'::jsonb
                   CHECK (jsonb_typeof(items) = 'array'),
    status         VARCHAR(20) NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'paid', 'cancelled')),
    sale_id        UUID,
    created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    closed_at      TIMESTAMP WITH TIME ZONE,
    -- Оплаченный чек обязан знать свою продажу, открытый — не иметь её
    CHECK ((status = 'paid') = (sale_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_pos_open_checks_open
    ON pos_open_checks(enterprise_id, restaurant_id, created_at) WHERE status = 'open';

COMMENT ON TABLE pos_open_checks IS
    'Отложенные чеки режима кассы: черновик состава до оплаты, без денег и списаний';
