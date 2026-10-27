-- Проверка: settings.html зовёт GET и PUT /api/enterprises/:id, а в
-- enterprise.routes.ts таких роутов нет (есть PATCH /:id под super_admin).
-- Проверяем живыми запросами от владельца своего предприятия.
\echo '--- предприятие и его владелец'
SELECT e.id AS enterprise_id, e.name, u.id AS user_id, u.email, u.role
  FROM enterprises e
  JOIN users u ON u.enterprise_id = e.id
 WHERE u.role IN ('restaurant_owner', 'admin')
 ORDER BY e.created_at
 LIMIT 3;
