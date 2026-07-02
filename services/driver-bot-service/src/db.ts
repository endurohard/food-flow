import { Pool } from 'pg';
import { config } from './config';

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 5
});

export interface DriverUser {
  id: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  role: string;
  enterprise_id: string | null;
  telegram_chat_id: string | null;
}

const USER_FIELDS =
  'id, first_name, last_name, phone, role, enterprise_id, telegram_chat_id';

/** Найти пользователя, привязанного к данному Telegram-чату */
export async function findUserByChatId(chatId: number): Promise<DriverUser | null> {
  const r = await pool.query(
    `SELECT ${USER_FIELDS} FROM users WHERE telegram_chat_id = $1 AND is_active = true LIMIT 1`,
    [chatId]
  );
  return r.rows[0] || null;
}

/**
 * Найти водителя по номеру телефона (сравнение последних 10 цифр,
 * чтобы не зависеть от формата +7 / 8 / пробелов / скобок).
 * admin допускается для тестирования.
 */
export async function findDriverByPhone(rawPhone: string): Promise<DriverUser | null> {
  const digits = rawPhone.replace(/\D/g, '');
  if (digits.length < 10) return null;
  const r = await pool.query(
    `SELECT ${USER_FIELDS}
     FROM users
     WHERE role IN ('delivery_driver', 'admin')
       AND is_active = true
       AND phone IS NOT NULL
       AND RIGHT(regexp_replace(phone, '\\D', '', 'g'), 10) = RIGHT($1, 10)
     ORDER BY (role = 'delivery_driver') DESC
     LIMIT 1`,
    [digits]
  );
  return r.rows[0] || null;
}

/** Привязать Telegram-чат к пользователю (снимая привязку с других) */
export async function linkChat(userId: string, chatId: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE users SET telegram_chat_id = NULL WHERE telegram_chat_id = $1 AND id <> $2',
      [chatId, userId]
    );
    await client.query(
      'UPDATE users SET telegram_chat_id = $1, updated_at = NOW() WHERE id = $2',
      [chatId, userId]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export interface DayStats {
  delivered: number;
  cashCollected: number;
  returnsCount: number;
  returnsAmount: number;
}

/** Статистика водителя за сегодня */
export async function getDayStats(userId: string): Promise<DayStats> {
  const [delivered, cash, returns] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS n
       FROM wholesale_orders
       WHERE driver_id = $1 AND delivered_at::date = CURRENT_DATE`,
      [userId]
    ),
    pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS s
       FROM counterparty_payments
       WHERE received_by = $1
         AND method = 'cash'
         AND payment_type = 'payment'
         AND created_at::date = CURRENT_DATE`,
      [userId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(total_amount), 0) AS s
       FROM wholesale_returns
       WHERE processed_by = $1
         AND status = 'confirmed'
         AND confirmed_at::date = CURRENT_DATE`,
      [userId]
    )
  ]);
  return {
    delivered: delivered.rows[0].n,
    cashCollected: parseFloat(cash.rows[0].s),
    returnsCount: returns.rows[0].n,
    returnsAmount: parseFloat(returns.rows[0].s)
  };
}

export interface NotifyOrderRow {
  id: string;
  invoice_number: string | null;
  delivery_address: string | null;
  delivery_date: string | null;
  total_amount: string;
  paid_amount: string;
  counterparty_name: string;
  counterparty_phone: string | null;
  telegram_chat_id: string;
}

/** Отгруженные заказы, о которых водителям ещё не отправлено уведомление */
export async function getUnnotifiedOrders(): Promise<NotifyOrderRow[]> {
  const r = await pool.query(
    `SELECT o.id, o.invoice_number, o.delivery_address, o.delivery_date,
            o.total_amount, o.paid_amount,
            c.name AS counterparty_name, c.phone AS counterparty_phone,
            u.telegram_chat_id
     FROM wholesale_orders o
     JOIN users u ON u.id = o.driver_id
     JOIN counterparties c ON c.id = o.counterparty_id
     WHERE o.status = 'shipped'
       AND o.driver_notified_at IS NULL
       AND u.telegram_chat_id IS NOT NULL
     ORDER BY o.shipped_at ASC NULLS LAST
     LIMIT 50`
  );
  return r.rows;
}

export async function markOrderNotified(orderId: string): Promise<void> {
  await pool.query(
    'UPDATE wholesale_orders SET driver_notified_at = NOW() WHERE id = $1',
    [orderId]
  );
}
