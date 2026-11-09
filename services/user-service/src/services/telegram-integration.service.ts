import crypto from 'crypto';
import { tgCall, TelegramError } from '../utils/telegram';
import { encryptSecret, decryptSecret } from '../utils/secrets';
import { TENANT_BASE_DOMAIN } from './tenant-domain.service';

export interface Queryable {
  query(sql: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

/**
 * Кому слать уведомления организации: владелец и админы по роли плюс
 * сотрудники, назначенные ответственными за закуп (enterprise_users.is_purchaser).
 */
const RECIPIENT_ROLES = ['owner', 'admin'];
/** Условие «получатель» по строке enterprise_users eu; $2 — RECIPIENT_ROLES */
const RECIPIENT_COND = '(eu.role = ANY($2) OR eu.is_purchaser)';
const TOKEN_RE = /^\d{5,12}:[A-Za-z0-9_-]{30,}$/;
const LINK_TTL_MIN = 30;

export class TelegramIntegrationError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/**
 * Telegram-бот организации: подключение по токену, привязка чатов владельца
 * и админов, рассылка уведомлений. Входящие сообщения бот читает getUpdates
 * только пока кто-то ждёт привязку на странице «Интеграции» — отдельный
 * постоянно работающий процесс не нужен, вебхук на прод-домен тоже.
 */
export class TelegramIntegrationService {
  constructor(private pool: Queryable) {}

  private async bot(enterpriseId: string) {
    const r = await this.pool.query(
      'SELECT bot_token, bot_username, bot_name, updates_offset FROM enterprise_telegram_bots WHERE enterprise_id = $1',
      [enterpriseId]
    );
    if (!r.rows[0]) return null;
    return { ...r.rows[0], token: decryptSecret(r.rows[0].bot_token) as string };
  }

  async getStatus(enterpriseId: string, userId: string) {
    const bot = await this.bot(enterpriseId);
    const people = await this.pool.query(
      `SELECT u.id AS user_id, u.first_name, u.last_name, u.email, eu.role, eu.is_purchaser,
              eu.role = ANY($2) OR eu.is_purchaser AS recipient,
              r.chat_id IS NOT NULL AS linked, r.telegram_username, r.linked_at
         FROM enterprise_users eu
         JOIN users u ON u.id = eu.user_id
         LEFT JOIN enterprise_telegram_recipients r ON r.enterprise_id = eu.enterprise_id AND r.user_id = eu.user_id
        WHERE eu.enterprise_id = $1 AND COALESCE(eu.is_active, true) AND u.is_active = true
        ORDER BY (eu.role = 'owner') DESC, (eu.role = 'admin') DESC, u.first_name`,
      [enterpriseId, RECIPIENT_ROLES]
    );
    const name = (p: any) => [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email;
    return {
      connected: !!bot,
      botUsername: bot?.bot_username || null,
      botName: bot?.bot_name || null,
      recipients: people.rows.filter((p: any) => p.recipient).map((p: any) => ({
        userId: p.user_id,
        name: name(p),
        role: p.role,
        purchaser: !!p.is_purchaser,
        linked: !!p.linked,
        telegramUsername: p.telegram_username,
        isMe: p.user_id === userId
      })),
      // Кого ещё можно назначить ответственным за закуп
      staff: people.rows.filter((p: any) => !p.recipient).map((p: any) => ({
        userId: p.user_id, name: name(p), role: p.role
      }))
    };
  }

  /** Назначить / снять ответственного за закуп (только сотрудник этой организации). */
  async setPurchaser(enterpriseId: string, userId: string, on: boolean) {
    const r = await this.pool.query(
      `UPDATE enterprise_users SET is_purchaser = $3
        WHERE enterprise_id = $1 AND user_id = $2 AND COALESCE(is_active, true)
        RETURNING role`,
      [enterpriseId, userId, on]
    );
    if (!r.rows.length) throw new TelegramIntegrationError('Сотрудник не найден в организации', 404);
    // Снятый закупщик без роли владельца/админа больше не получатель —
    // убираем привязку, чтобы в списке не висел «привязанный» посторонний
    if (!on && !RECIPIENT_ROLES.includes(r.rows[0].role)) {
      await this.unlink(enterpriseId, userId);
    }
  }

  /** Привязку можно выдать только получателю уведомлений этой организации. */
  async isRecipient(enterpriseId: string, userId: string): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM enterprise_users eu JOIN users u ON u.id = eu.user_id
        WHERE eu.enterprise_id = $1 AND ${RECIPIENT_COND} AND eu.user_id = $3
          AND COALESCE(eu.is_active, true) AND u.is_active = true`,
      [enterpriseId, RECIPIENT_ROLES, userId]
    );
    return r.rows.length > 0;
  }

  /** Проверяет токен у Telegram и сохраняет (зашифрованным). */
  async saveBot(enterpriseId: string, token: string, userId: string) {
    token = token.trim();
    if (!TOKEN_RE.test(token)) {
      throw new TelegramIntegrationError('Это не похоже на токен бота. Он выглядит так: 1234567890:AAH…, его выдаёт @BotFather');
    }
    let me: any;
    try {
      me = await tgCall(token, 'getMe');
    } catch (e: any) {
      if (e instanceof TelegramError && e.code === 401) {
        throw new TelegramIntegrationError('Telegram не принял токен — проверьте, что скопирован целиком');
      }
      throw new TelegramIntegrationError('Не удалось проверить токен: ' + e.message, 502);
    }
    // Бот с вебхуком уже обслуживает другую систему: getUpdates у него
    // не работает, а снимать чужой вебхук нельзя — сломаем ту систему.
    const hook: any = await tgCall(token, 'getWebhookInfo').catch(() => ({}));
    if (hook && hook.url) {
      throw new TelegramIntegrationError('Этот бот уже подключён к другой системе (webhook). Создайте отдельного бота в @BotFather', 409);
    }
    const prev = await this.bot(enterpriseId);
    await this.pool.query(
      `INSERT INTO enterprise_telegram_bots (enterprise_id, bot_token, bot_username, bot_name, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (enterprise_id) DO UPDATE
         SET bot_token = EXCLUDED.bot_token, bot_username = EXCLUDED.bot_username,
             bot_name = EXCLUDED.bot_name, updates_offset = 0, updated_at = NOW()`,
      [enterpriseId, encryptSecret(token), me.username, me.first_name || null, userId]
    );
    // Другой бот — старые привязки к нему недействительны: чат с одним ботом
    // не получает сообщений от другого, пока человек его не запустит.
    if (prev && prev.bot_username !== me.username) {
      await this.pool.query(
        `UPDATE enterprise_telegram_recipients SET chat_id = NULL, linked_at = NULL, telegram_username = NULL
          WHERE enterprise_id = $1`,
        [enterpriseId]
      );
    }
    return { botUsername: me.username, botName: me.first_name || null };
  }

  async removeBot(enterpriseId: string) {
    await this.pool.query('DELETE FROM enterprise_telegram_recipients WHERE enterprise_id = $1', [enterpriseId]);
    await this.pool.query('DELETE FROM enterprise_telegram_bots WHERE enterprise_id = $1', [enterpriseId]);
  }

  /** Ссылка t.me/<бот>?start=<код> для привязки своего Telegram. */
  async createLink(enterpriseId: string, userId: string) {
    const bot = await this.bot(enterpriseId);
    if (!bot) throw new TelegramIntegrationError('Сначала подключите бота', 409);
    const code = crypto.randomBytes(12).toString('hex');
    await this.pool.query(
      `INSERT INTO enterprise_telegram_recipients (enterprise_id, user_id, link_code, link_expires_at)
       VALUES ($1, $2, $3, NOW() + make_interval(mins => $4))
       ON CONFLICT (enterprise_id, user_id) DO UPDATE
         SET link_code = EXCLUDED.link_code, link_expires_at = EXCLUDED.link_expires_at`,
      [enterpriseId, userId, code, LINK_TTL_MIN]
    );
    return { url: `https://t.me/${bot.bot_username}?start=${code}`, expiresInMin: LINK_TTL_MIN };
  }

  /**
   * Читает новые сообщения бота и проводит привязки по /start <код>.
   * Код ищется только среди кодов ЭТОЙ организации: чужой код не сработает.
   */
  async pollLinks(enterpriseId: string): Promise<number> {
    const bot = await this.bot(enterpriseId);
    if (!bot) return 0;
    const updates: any[] = await tgCall(bot.token, 'getUpdates', {
      offset: Number(bot.updates_offset) || 0, timeout: 0, allowed_updates: ['message']
    });
    let linked = 0;
    let maxId = -1;
    for (const u of updates) {
      maxId = Math.max(maxId, u.update_id);
      const msg = u.message;
      const text: string = msg?.text || '';
      if (!msg || msg.chat?.type !== 'private' || !text.startsWith('/start')) continue;
      const code = text.split(/\s+/)[1] || '';
      const r = code ? await this.pool.query(
        `UPDATE enterprise_telegram_recipients
            SET chat_id = $3, telegram_username = $4, linked_at = NOW(), link_code = NULL, link_expires_at = NULL
          WHERE enterprise_id = $1 AND link_code = $2 AND link_expires_at > NOW()
          RETURNING user_id`,
        [enterpriseId, code, msg.chat.id, msg.from?.username || null]
      ) : { rows: [] };
      const reply = r.rows.length
        ? '✅ Готово. Сюда будут приходить уведомления FoodFlow: например, когда на складе заканчивается товар.'
        : 'Чтобы получать уведомления, откройте FoodFlow → Настройки → Интеграции и нажмите «Привязать мой Telegram».';
      if (r.rows.length) linked++;
      await tgCall(bot.token, 'sendMessage', { chat_id: msg.chat.id, text: reply }).catch(() => {});
    }
    if (maxId >= 0) {
      await this.pool.query(
        'UPDATE enterprise_telegram_bots SET updates_offset = GREATEST(updates_offset, $2) WHERE enterprise_id = $1',
        [enterpriseId, maxId + 1]
      );
    }
    return linked;
  }

  async unlink(enterpriseId: string, userId: string) {
    await this.pool.query(
      'DELETE FROM enterprise_telegram_recipients WHERE enterprise_id = $1 AND user_id = $2',
      [enterpriseId, userId]
    );
  }

  /**
   * Рассылка владельцу, админам и ответственным за закуп. Роль и назначение
   * проверяются в момент отправки: разжалованный перестаёт получать сразу,
   * без ручной отвязки.
   */
  async notify(enterpriseId: string, text: string, linkPath?: string):
      Promise<{ sent: number; failed: number; skipped?: 'no_bot' | 'no_recipients'; errors: string[] }> {
    const bot = await this.bot(enterpriseId);
    if (!bot) return { sent: 0, failed: 0, skipped: 'no_bot', errors: [] };
    // Закупщик жмёт «Start» по ссылке, которую ему переслал админ, — часто
    // уже после того, как админ закрыл страницу настроек и опрос остановился.
    // Дочитываем такие привязки перед рассылкой, иначе он её не получит.
    const pending = await this.pool.query(
      `SELECT 1 FROM enterprise_telegram_recipients
        WHERE enterprise_id = $1 AND link_code IS NOT NULL AND link_expires_at > NOW() LIMIT 1`,
      [enterpriseId]
    );
    if (pending.rows.length) await this.pollLinks(enterpriseId).catch(() => 0);
    const r = await this.pool.query(
      `SELECT r.chat_id, e.subdomain
         FROM enterprise_telegram_recipients r
         JOIN enterprise_users eu ON eu.enterprise_id = r.enterprise_id AND eu.user_id = r.user_id
         JOIN users u ON u.id = r.user_id
         JOIN enterprises e ON e.id = r.enterprise_id
        WHERE r.enterprise_id = $1 AND r.chat_id IS NOT NULL
          AND ${RECIPIENT_COND} AND COALESCE(eu.is_active, true) AND u.is_active = true`,
      [enterpriseId, RECIPIENT_ROLES]
    );
    if (!r.rows.length) return { sent: 0, failed: 0, skipped: 'no_recipients', errors: [] };
    const sub = r.rows[0].subdomain;
    const host = sub ? `${sub}.${TENANT_BASE_DOMAIN}` : TENANT_BASE_DOMAIN;
    const full = linkPath ? `${text}\n\nОткрыть: https://${host}${linkPath}` : text;
    let sent = 0;
    const errors: string[] = [];
    for (const row of r.rows) {
      try {
        await tgCall(bot.token, 'sendMessage', { chat_id: row.chat_id, text: full, disable_web_page_preview: true });
        sent++;
      } catch (e: any) {
        errors.push(e.message);
      }
    }
    return { sent, failed: errors.length, errors };
  }
}
