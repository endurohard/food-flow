-- ============================================================
-- Миграция 030: Outbox для событий (transactional outbox)
-- ============================================================
-- Проблема, которую решает:
-- order-service публикует события в RabbitMQ ПОСЛЕ COMMIT, обёрнутым
-- в try/catch. Если брокер недоступен, API возвращает успех, а событие
-- теряется навсегда: кухня не увидит заказ, склад не спишет ингредиенты,
-- баллы не начислятся. Восстановить потерянное неоткуда.
--
-- Решение: событие пишется в эту таблицу В ТОЙ ЖЕ транзакции, что и сам
-- заказ. Либо есть и заказ, и событие, либо нет ни того, ни другого.
-- Фоновый воркер забирает необработанные строки и публикует их в брокер,
-- помечая отправленные. Брокер лежал — события просто дождутся его.
--
-- Идемпотентна: безопасно запускать повторно.
-- Date: 2026-10-14

CREATE TABLE IF NOT EXISTS event_outbox (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    enterprise_id   UUID REFERENCES enterprises(id) ON DELETE SET NULL,

    -- Маршрутизация в topic-exchange: 'order.confirmed', 'order.completed' и т.п.
    exchange        VARCHAR(100) NOT NULL DEFAULT 'orders_exchange',
    routing_key     VARCHAR(255) NOT NULL,

    -- Полезная нагрузка события целиком
    payload         JSONB NOT NULL,

    -- Связь с сущностью-источником (для отладки и ручного разбора)
    aggregate_type  VARCHAR(50),
    aggregate_id    UUID,

    -- pending  — ждёт отправки
    -- sent     — успешно опубликовано
    -- failed   — исчерпаны попытки, нужен ручной разбор
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'failed')),

    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,

    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    -- Время следующей попытки: экспоненциальная задержка после ошибки
    next_attempt_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    sent_at         TIMESTAMP WITH TIME ZONE
);

-- Основной индекс воркера: выбрать готовые к отправке в порядке создания.
-- Частичный — в нём только pending, поэтому он не растёт от отправленных.
CREATE INDEX IF NOT EXISTS idx_event_outbox_pending
    ON event_outbox (next_attempt_at, created_at)
    WHERE status = 'pending';

-- Для разбора застрявших событий в админке
CREATE INDEX IF NOT EXISTS idx_event_outbox_failed
    ON event_outbox (created_at DESC)
    WHERE status = 'failed';

-- Поиск событий конкретного заказа
CREATE INDEX IF NOT EXISTS idx_event_outbox_aggregate
    ON event_outbox (aggregate_type, aggregate_id);

COMMENT ON TABLE event_outbox IS
    'Transactional outbox: событие пишется в одной транзакции с бизнес-данными, воркер досылает его в RabbitMQ';
COMMENT ON COLUMN event_outbox.next_attempt_at IS
    'Время следующей попытки отправки; растёт экспоненциально при ошибках';
COMMENT ON COLUMN event_outbox.status IS
    'pending — ждёт отправки, sent — опубликовано, failed — исчерпаны попытки';
