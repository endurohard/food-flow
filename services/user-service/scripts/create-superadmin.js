#!/usr/bin/env node
/**
 * Сид платформенного супер-администратора.
 * Роль super_admin нельзя получить через публичный /register — только этим скриптом.
 *
 * Запуск (внутри контейнера user-service, где есть pg/bcryptjs и DATABASE_URL):
 *   docker exec -e SA_EMAIL=admin@foodflow.local -e SA_PASSWORD='<пароль>' \
 *     user-service node scripts/create-superadmin.js
 *
 * Или локально: SA_EMAIL=.. SA_PASSWORD=.. DATABASE_URL=.. node scripts/create-superadmin.js
 * Идемпотентно: повторный запуск обновит роль/пароль существующего пользователя.
 */
const pkg = require('pg');
const bcrypt = require('bcryptjs');

const email = process.env.SA_EMAIL || process.argv[2];
const password = process.env.SA_PASSWORD || process.argv[3];
const firstName = process.env.SA_FIRST_NAME || 'Super';
const lastName = process.env.SA_LAST_NAME || 'Admin';

if (!email || !password) {
  console.error('Нужны SA_EMAIL и SA_PASSWORD (env или аргументы).');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Пароль минимум 8 символов.');
  process.exit(1);
}

(async () => {
  const pool = new pkg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const hash = await bcrypt.hash(password, 10);
    const res = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, is_active)
       VALUES ($1, $2, $3, $4, 'super_admin', true)
       ON CONFLICT (email) DO UPDATE
         SET role = 'super_admin', password_hash = EXCLUDED.password_hash, is_active = true
       RETURNING id, email, role`,
      [email, hash, firstName, lastName]
    );
    console.log('OK super_admin:', res.rows[0].email, '(id ' + res.rows[0].id + ')');
    process.exit(0);
  } catch (e) {
    console.error('Ошибка:', e.message);
    process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }
})();
