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
/** Telegram ID пользователя — положительное целое (у групп id отрицательный) */
const CHAT_ID_RE = /^\d{5,15}$/;

export class TelegramIntegrationError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** Бот, через которого организация шлёт уведомления прямо сейчас. */
export interface ActiveBot {
  token: string;
  bot_username: string;
  bot_name: string | null;
  updates_offset: number;
  /** own — свой бот организации, platform — общий бот FoodFlow */
  source: 'own' | 'platform';
}

const idReply = (chatId: number | string) =>
  `Ваш Telegram ID: ${chatId}\n\nПередайте его администратору вашего заведения в FoodFlow — ` +
  'он добавит вас в уведомления (например, «пора заказать», когда на складе заканчивается товар).';
const LINKED_REPLY = '✅ Готово. Сюда будут приходить уведомления FoodFlow: например, когда на складе заканчивается товар.';

/**
 * Telegram-уведомления организации.
 *
 * Бот — свой у организации (подключает владелец/админ в «Интеграциях») или,
 * если своего нет, общий бот платформы (подключает супер-админ). Получатель
 * попадает в рассылку двумя путями: по ссылке t.me/<бот>?start=<код> или по
 * Telegram ID, который админ вписывает вручную (бот сообщает ID в ответ на
 * «Start»). В обоих случаях человек сначала сам нажимает «Start» у бота —
 * иначе Telegram не даёт боту написать ему.
 */
export class TelegramIntegrationService {
  constructor(private pool: Queryable) {}

  // ── боты ────────────────────────────────────────────────────────────────

  private async ownBot(enterpriseId: string): Promise<ActiveBot | null> {
    const r = await this.pool.query(
      'SELECT bot_token, bot_username, bot_name, updates_offset FROM enterprise_telegram_bots WHERE enterprise_id = $1',
      [enterpriseId]
    );
    if (!r.rows[0]) return null;
    return { ...r.rows[0], token: decryptSecret(r.rows[0].bot_token) as string, source: 'own' };
  }

  async platformBot(): Promise<ActiveBot | null> {
    const r = await this.pool.query(
      'SELECT bot_token, bot_username, bot_name, updates_offset FROM platform_telegram_bot WHERE id'
    );
    if (!r.rows[0]) return null;
    return { ...r.rows[0], token: decryptSecret(r.rows[0].bot_token) as string, source: 'platform' };
  }

  /** Свой бот организации главнее общего. */
  async activeBot(enterpriseId: string): Promise<ActiveBot | null> {
    return (await this.ownBot(enterpriseId)) || (await this.platformBot());
  }

  /** getMe + запрет чужого вебхука. Общая проверка для своего и общего бота. */
  private async verifyToken(token: string) {
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
    return { token, me };
  }

  // ── статус и получатели ─────────────────────────────────────────────────

  async getStatus(enterpriseId: string, userId: string) {
    const own = await this.ownBot(enterpriseId);
    const platform = await this.platformBot();
    const bot = own || platform;
    const people = await this.pool.query(
      `SELECT u.id AS user_id, u.first_name, u.last_name, u.email, eu.role, eu.is_purchaser,
              eu.role = ANY($2) OR eu.is_purchaser AS recipient,
              r.chat_id, r.bot_username, r.telegram_username, r.linked_at
         FROM enterprise_users eu
         JOIN users u ON u.id = eu.user_id
         LEFT JOIN enterprise_telegram_recipients r ON r.enterprise_id = eu.enterprise_id AND r.user_id = eu.user_id
        WHERE eu.enterprise_id = $1 AND COALESCE(eu.is_active, true) AND u.is_active = true
        ORDER BY (eu.role = 'owner') DESC, (eu.role = 'admin') DESC, u.first_name`,
      [enterpriseId, RECIPIENT_ROLES]
    );
    const name = (p: any) => [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email;
    // Привязка годится, только если сделана через бота, который сейчас шлёт
    const linked = (p: any) => !!bot && p.chat_id != null && p.bot_username === bot.bot_username;
    return {
      connected: !!bot,
      source: bot?.source || null,
      ownBot: !!own,
      platformBotUsername: platform?.bot_username || null,
      botUsername: bot?.bot_username || null,
      botName: bot?.bot_name || null,
      recipients: people.rows.filter((p: any) => p.recipient).map((p: any) => ({
        userId: p.user_id,
        name: name(p),
        role: p.role,
        purchaser: !!p.is_purchaser,
        linked: linked(p),
        chatId: linked(p) ? String(p.chat_id) : null,
        telegramUsername: linked(p) ? p.telegram_username : null,
        linkedAt: linked(p) ? p.linked_at : null,
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

  // ── свой бот организации ────────────────────────────────────────────────

  /** Проверяет токен у Telegram и сохраняет (зашифрованным). */
  async saveBot(enterpriseId: string, token: string, userId: string) {
    const v = await this.verifyToken(token);
    const platform = await this.platformBot();
    // Тот же бот двумя «хозяевами» — два читателя getUpdates, сообщения теряются
    if (platform && platform.bot_username === v.me.username) {
      throw new TelegramIntegrationError('Это общий бот FoodFlow — он и так используется, свой подключать не нужно', 409);
    }
    // Привязки получателей не трогаем: у каждой записан её бот (bot_username),
    // через другого бота она просто не считается привязанной.
    await this.pool.query(
      `INSERT INTO enterprise_telegram_bots (enterprise_id, bot_token, bot_username, bot_name, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (enterprise_id) DO UPDATE
         SET bot_token = EXCLUDED.bot_token, bot_username = EXCLUDED.bot_username,
             bot_name = EXCLUDED.bot_name, updates_offset = 0, updated_at = NOW()`,
      [enterpriseId, encryptSecret(v.token), v.me.username, v.me.first_name || null, userId]
    );
    return { botUsername: v.me.username, botName: v.me.first_name || null };
  }

  /** Отключить свой бот — организация возвращается на общий (если он есть). */
  async removeBot(enterpriseId: string) {
    await this.pool.query('DELETE FROM enterprise_telegram_bots WHERE enterprise_id = $1', [enterpriseId]);
  }

  // ── общий бот платформы (супер-админ) ───────────────────────────────────

  async getPlatformStatus() {
    const bot = await this.platformBot();
    const usage = await this.pool.query(
      `SELECT count(DISTINCT r.enterprise_id) AS enterprises, count(*) AS recipients
         FROM enterprise_telegram_recipients r
         JOIN platform_telegram_bot p ON p.bot_username = r.bot_username
        WHERE r.chat_id IS NOT NULL`
    );
    return {
      connected: !!bot,
      botUsername: bot?.bot_username || null,
      botName: bot?.bot_name || null,
      enterprises: Number(usage.rows[0]?.enterprises || 0),
      recipients: Number(usage.rows[0]?.recipients || 0)
    };
  }

  async savePlatformBot(token: string, userId: string) {
    const v = await this.verifyToken(token);
    const own = await this.pool.query(
      'SELECT 1 FROM enterprise_telegram_bots WHERE bot_username = $1 LIMIT 1', [v.me.username]
    );
    if (own.rows.length) {
      throw new TelegramIntegrationError('Этот бот уже подключён как свой бот одной из организаций — для общего создайте отдельного', 409);
    }
    await this.pool.query(
      `INSERT INTO platform_telegram_bot (id, bot_token, bot_username, bot_name, updated_by)
       VALUES (true, $1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
         SET bot_token = EXCLUDED.bot_token, bot_username = EXCLUDED.bot_username, bot_name = EXCLUDED.bot_name,
             updates_offset = 0, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [encryptSecret(v.token), v.me.username, v.me.first_name || null, userId]
    );
    return { botUsername: v.me.username, botName: v.me.first_name || null };
  }

  async removePlatformBot() {
    await this.pool.query('DELETE FROM platform_telegram_bot WHERE id');
  }

  // ── привязка получателей ────────────────────────────────────────────────

  /** Ссылка t.me/<бот>?start=<код> для привязки Telegram получателя. */
  async createLink(enterpriseId: string, userId: string) {
    const bot = await this.activeBot(enterpriseId);
    if (!bot) throw new TelegramIntegrationError('Telegram-бот не подключён: подключите своего или попросите супер-админа подключить общий', 409);
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
   * Привязка по Telegram ID, вписанному админом. Сразу шлём человеку
   * приветствие: это и проверка, что он нажал «Start» у нужного бота, —
   * иначе Telegram отвечает ошибкой, и привязку не сохраняем.
   */
  async linkByChatId(enterpriseId: string, userId: string, chatIdRaw: string) {
    const chatId = String(chatIdRaw || '').trim();
    if (!CHAT_ID_RE.test(chatId)) {
      throw new TelegramIntegrationError('Telegram ID — это число из 5–15 цифр. Его присылает бот в ответ на «Start»');
    }
    const bot = await this.activeBot(enterpriseId);
    if (!bot) throw new TelegramIntegrationError('Telegram-бот не подключён', 409);
    const org = await this.pool.query('SELECT name FROM enterprises WHERE id = $1', [enterpriseId]);
    const orgName = org.rows[0]?.name || 'FoodFlow';
    try {
      await tgCall(bot.token, 'sendMessage', {
        chat_id: chatId,
        text: `✅ Вы подключены к уведомлениям «${orgName}» в FoodFlow: например, когда на складе заканчивается товар.`
      });
    } catch (e: any) {
      if (e instanceof TelegramError && (e.code === 400 || e.code === 403)) {
        throw new TelegramIntegrationError(
          `Бот @${bot.bot_username} не может написать на этот ID: сотрудник ещё не нажал у него «Start», заблокировал бота или ID неверный`);
      }
      throw new TelegramIntegrationError('Не удалось связаться с Telegram: ' + e.message, 502);
    }
    await this.pool.query(
      `INSERT INTO enterprise_telegram_recipients (enterprise_id, user_id, chat_id, bot_username, linked_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (enterprise_id, user_id) DO UPDATE
         SET chat_id = EXCLUDED.chat_id, bot_username = EXCLUDED.bot_username, linked_at = NOW(),
             telegram_username = NULL, link_code = NULL, link_expires_at = NULL`,
      [enterpriseId, userId, chatId, bot.bot_username]
    );
  }

  /**
   * Разбор входящих сообщений бота: «/start <код>» — привязка, всё прочее
   * в личке — ответ с Telegram ID. linkFn проводит привязку по коду и
   * возвращает true, если код подошёл.
   */
  private async handleUpdates(token: string, updates: any[],
      linkFn: (code: string, msg: any) => Promise<boolean>): Promise<{ linked: number; maxId: number }> {
    let linked = 0;
    let maxId = -1;
    for (const u of updates) {
      maxId = Math.max(maxId, u.update_id);
      const msg = u.message;
      if (!msg || msg.chat?.type !== 'private') continue;
      const text: string = msg.text || '';
      const code = text.startsWith('/start') ? (text.split(/\s+/)[1] || '') : '';
      const ok = code ? await linkFn(code, msg) : false;
      if (ok) linked++;
      await tgCall(token, 'sendMessage', { chat_id: msg.chat.id, text: ok ? LINKED_REPLY : idReply(msg.chat.id) }).catch(() => {});
    }
    return { linked, maxId };
  }

  /**
   * Свой бот организации: читает новые сообщения и проводит привязки по
   * /start <код>. Код ищется только среди кодов ЭТОЙ организации.
   * Общий бот здесь не читается — его читает один фоновый цикл на всю
   * платформу (pollPlatform), иначе два читателя getUpdates мешают друг другу.
   */
  async pollLinks(enterpriseId: string): Promise<number> {
    const bot = await this.ownBot(enterpriseId);
    if (!bot) return 0;
    const updates: any[] = await tgCall(bot.token, 'getUpdates', {
      offset: Number(bot.updates_offset) || 0, timeout: 0, allowed_updates: ['message']
    });
    const { linked, maxId } = await this.handleUpdates(bot.token, updates, async (code, msg) => {
      const r = await this.pool.query(
        `UPDATE enterprise_telegram_recipients
            SET chat_id = $3, telegram_username = $4, bot_username = $5, linked_at = NOW(),
                link_code = NULL, link_expires_at = NULL
          WHERE enterprise_id = $1 AND link_code = $2 AND link_expires_at > NOW()
          RETURNING user_id`,
        [enterpriseId, code, msg.chat.id, msg.from?.username || null, bot.bot_username]
      );
      return r.rows.length > 0;
    });
    if (maxId >= 0) {
      await this.pool.query(
        'UPDATE enterprise_telegram_bots SET updates_offset = GREATEST(updates_offset, $2) WHERE enterprise_id = $1',
        [enterpriseId, maxId + 1]
      );
    }
    return linked;
  }

  /**
   * Один проход по общему боту: привязки по кодам любых организаций, у
   * которых нет своего бота (ссылку на общего бота выдают только им), и
   * ответ с Telegram ID на «Start». timeoutSec > 0 — long polling.
   */
  async pollPlatform(timeoutSec = 0): Promise<number> {
    const bot = await this.platformBot();
    if (!bot) return 0;
    const updates: any[] = await tgCall(bot.token, 'getUpdates', {
      offset: Number(bot.updates_offset) || 0, timeout: timeoutSec, allowed_updates: ['message']
    });
    const { linked, maxId } = await this.handleUpdates(bot.token, updates, async (code, msg) => {
      const r = await this.pool.query(
        `UPDATE enterprise_telegram_recipients r
            SET chat_id = $2, telegram_username = $3, bot_username = $4, linked_at = NOW(),
                link_code = NULL, link_expires_at = NULL
          WHERE r.link_code = $1 AND r.link_expires_at > NOW()
            AND NOT EXISTS (SELECT 1 FROM enterprise_telegram_bots b WHERE b.enterprise_id = r.enterprise_id)
          RETURNING r.user_id`,
        [code, msg.chat.id, msg.from?.username || null, bot.bot_username]
      );
      return r.rows.length > 0;
    });
    if (maxId >= 0) {
      // Токен могли сменить, пока шёл long polling: offset чужого бота не пишем
      await this.pool.query(
        'UPDATE platform_telegram_bot SET updates_offset = GREATEST(updates_offset, $1) WHERE id AND bot_username = $2',
        [maxId + 1, bot.bot_username]
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

  // ── рассылка ────────────────────────────────────────────────────────────

  /**
   * Рассылка владельцу, админам и ответственным за закуп. Роль и назначение
   * проверяются в момент отправки: разжалованный перестаёт получать сразу,
   * без ручной отвязки. Шлём только тем, кто привязан через бота, который
   * сейчас активен у организации.
   */
  async notify(enterpriseId: string, text: string, linkPath?: string):
      Promise<{ sent: number; failed: number; skipped?: 'no_bot' | 'no_recipients'; errors: string[] }> {
    const bot = await this.activeBot(enterpriseId);
    if (!bot) return { sent: 0, failed: 0, skipped: 'no_bot', errors: [] };
    // Закупщик жмёт «Start» по ссылке, которую ему переслал админ, — часто
    // уже после того, как админ закрыл страницу настроек и опрос остановился.
    // Дочитываем такие привязки перед рассылкой, иначе он её не получит.
    // (Общий бот читается фоновым циклом постоянно — для него не нужно.)
    if (bot.source === 'own') {
      const pending = await this.pool.query(
        `SELECT 1 FROM enterprise_telegram_recipients
          WHERE enterprise_id = $1 AND link_code IS NOT NULL AND link_expires_at > NOW() LIMIT 1`,
        [enterpriseId]
      );
      if (pending.rows.length) await this.pollLinks(enterpriseId).catch(() => 0);
    }
    const r = await this.pool.query(
      `SELECT r.chat_id, e.subdomain
         FROM enterprise_telegram_recipients r
         JOIN enterprise_users eu ON eu.enterprise_id = r.enterprise_id AND eu.user_id = r.user_id
         JOIN users u ON u.id = r.user_id
         JOIN enterprises e ON e.id = r.enterprise_id
        WHERE r.enterprise_id = $1 AND r.chat_id IS NOT NULL AND r.bot_username = $3
          AND ${RECIPIENT_COND} AND COALESCE(eu.is_active, true) AND u.is_active = true`,
      [enterpriseId, RECIPIENT_ROLES, bot.bot_username]
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

/**
 * Фоновый цикл общего бота: long polling, чтобы «Start» получал ответ с
 * Telegram ID сразу, а привязка по ссылке проходила без открытой страницы.
 * Один на процесс; при сбое — пауза и снова.
 */
export function startPlatformBotPoller(tg: TelegramIntegrationService, log: (m: string) => void = console.error) {
  let stopped = false;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    while (!stopped) {
      try {
        if (!(await tg.platformBot())) { await sleep(30_000); continue; }
        // timeout меньше таймаута запроса в tgCall (15 с)
        await tg.pollPlatform(10);
      } catch (e: any) {
        log('platform telegram bot poll failed: ' + (e?.message || e));
        await sleep(15_000);
      }
    }
  })();
  return () => { stopped = true; };
}
