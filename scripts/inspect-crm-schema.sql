-- Осмотр схемы CRM: какие колонки есть у таблиц, которые читает crm-service.
-- Повод: GET /api/crm/promotions падает с 500 — «column enterprise_id does not
-- exist», то есть акции не изолированы по предприятию.

SELECT table_name, column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name IN ('promotions', 'loyalty_programs', 'loyalty_transactions',
                      'customers', 'customer_tags')
 ORDER BY table_name, ordinal_position;

\echo '--- у каких таблиц CRM вообще есть enterprise_id'
SELECT t.table_name,
       bool_or(c.column_name = 'enterprise_id') AS есть_enterprise_id
  FROM information_schema.tables t
  LEFT JOIN information_schema.columns c ON c.table_name = t.table_name
 WHERE t.table_schema = 'public'
   AND t.table_name IN ('promotions', 'loyalty_programs', 'loyalty_transactions',
                        'customers', 'inventory_items', 'warehouses')
 GROUP BY t.table_name ORDER BY t.table_name;

\echo '--- сколько строк в promotions и у кого они'
SELECT count(*) AS всего FROM promotions;

\echo '--- миграции, создававшие promotions'
SELECT filename FROM migration_history ORDER BY filename;
