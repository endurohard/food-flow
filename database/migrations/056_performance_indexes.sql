-- 056: индексы под рост данных и удаление дублей.
--
-- Почему сейчас. База на проде — 16 МБ, в таблицах десятки строк, и на таком
-- объёме Postgres правильно читает таблицы целиком: эти индексы сегодня не
-- ускорят ни один экран. Они нужны, чтобы экраны не начали тормозить, когда
-- заказов и движений склада станет тысячи: список заказов и панель фильтруют
-- по предприятию и дате, себестоимость ищет «где используется ингредиент»,
-- приёмка — последнюю закупочную цену. Без индексов каждый такой запрос
-- со временем превращается в полный проход по таблице.
--
-- Дубли (два одинаковых индекса под разными именами из разных миграций)
-- ничего не ускоряют, но каждая вставка и обновление пишет в оба.
--
-- Каждое действие под проверкой существования: история схемы на проде и на
-- чистой базе (CI «Migrations») расходится, и падение одной строки
-- остановило бы все последующие миграции.
-- CONCURRENTLY не используем: migrate.sh гонит файл одной транзакцией,
-- а таблицы маленькие — блокировка на создание индекса мгновенная.

CREATE OR REPLACE FUNCTION pg_temp.ff_index(idx text, tbl text, cols text, pred text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  col text;
BEGIN
  IF to_regclass('public.' || tbl) IS NULL THEN
    RAISE NOTICE 'пропуск %: нет таблицы %', idx, tbl;
    RETURN;
  END IF;
  -- Колонки индекса без DESC/ASC — проверяем, что все есть в таблице
  FOREACH col IN ARRAY string_to_array(regexp_replace(cols, '\s+(DESC|ASC)', '', 'gi'), ',') LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = tbl AND column_name = btrim(col)) THEN
      RAISE NOTICE 'пропуск %: нет колонки %.%', idx, tbl, btrim(col);
      RETURN;
    END IF;
  END LOOP;
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (%s)%s',
                 idx, tbl, cols, CASE WHEN pred IS NULL THEN '' ELSE ' WHERE ' || pred END);
END $$;

-- Удаляет индекс-дубль, только если его «близнец» на месте: на чистой базе
-- может существовать лишь один из пары, и тогда его трогать нельзя.
CREATE OR REPLACE FUNCTION pg_temp.ff_drop_dup(dup text, keep text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF to_regclass('public.' || dup) IS NOT NULL AND to_regclass('public.' || keep) IS NOT NULL THEN
    EXECUTE format('DROP INDEX public.%I', dup);
  END IF;
END $$;

-- ── Заказы ─────────────────────────────────────────────────────────────
-- Список «Заказы», панель «за сегодня», выручка: WHERE enterprise_id = $1
-- AND created_at >= ... ORDER BY created_at DESC
SELECT pg_temp.ff_index('idx_orders_enterprise_created', 'orders', 'enterprise_id, created_at DESC');
SELECT pg_temp.ff_index('idx_orders_table', 'orders', 'table_id', 'table_id IS NOT NULL');
SELECT pg_temp.ff_index('idx_orders_parent', 'orders', 'parent_order_id', 'parent_order_id IS NOT NULL');
SELECT pg_temp.ff_index('idx_restaurant_tables_current_order', 'restaurant_tables', 'current_order_id',
                        'current_order_id IS NOT NULL');
SELECT pg_temp.ff_index('idx_reservations_table', 'reservations', 'table_id', 'table_id IS NOT NULL');

-- ── Склад, техкарты, закупки ──────────────────────────────────────────
-- «В каких техкартах участвует ингредиент» — пересчёт себестоимости
SELECT pg_temp.ff_index('idx_tech_card_ingredients_item', 'tech_card_ingredients', 'inventory_item_id');
-- Последняя закупочная цена ингредиента
SELECT pg_temp.ff_index('idx_supply_invoice_items_item', 'supply_invoice_items', 'inventory_item_id');
SELECT pg_temp.ff_index('idx_supply_invoices_warehouse', 'supply_invoices', 'warehouse_id');
SELECT pg_temp.ff_index('idx_inventory_batches_invoice', 'inventory_batches', 'invoice_id', 'invoice_id IS NOT NULL');
SELECT pg_temp.ff_index('idx_stock_alerts_item', 'stock_alerts', 'inventory_item_id');
SELECT pg_temp.ff_index('idx_production_runs_tech_card', 'production_runs', 'tech_card_id');
SELECT pg_temp.ff_index('idx_wholesale_return_items_order_item', 'wholesale_return_items', 'order_item_id');

-- ── Касса ─────────────────────────────────────────────────────────────
SELECT pg_temp.ff_index('idx_cash_register_sessions_register', 'cash_register_sessions', 'register_id');
SELECT pg_temp.ff_index('idx_pos_sales_register', 'pos_sales', 'register_id');

-- ── Дубли ─────────────────────────────────────────────────────────────
SELECT pg_temp.ff_drop_dup('idx_orders_created', 'idx_orders_created_at');
SELECT pg_temp.ff_drop_dup('idx_orders_restaurant', 'idx_orders_restaurant_id');
-- (enterprise_id) целиком покрыт новым (enterprise_id, created_at)
SELECT pg_temp.ff_drop_dup('idx_orders_enterprise_id', 'idx_orders_enterprise_created');
SELECT pg_temp.ff_drop_dup('idx_order_items_order', 'idx_order_items_order_id');
SELECT pg_temp.ff_drop_dup('idx_menu_items_restaurant', 'idx_menu_items_restaurant_id');
SELECT pg_temp.ff_drop_dup('idx_menu_items_category', 'idx_menu_items_category_id');
-- users_email_key — уникальное ограничение, оно и есть индекс по email
SELECT pg_temp.ff_drop_dup('idx_users_email', 'users_email_key');

-- Без списка таблиц: на чистой базе часть из них может отсутствовать
ANALYZE;
