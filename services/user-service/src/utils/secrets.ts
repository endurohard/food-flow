import crypto from 'crypto';

/**
 * Шифрование чужих секретов, которые приходится хранить в открытом виде
 * для последующего использования (пароль подключения к ВАТС).
 *
 * Хэш тут не годится принципиально: пароль нужно предъявить АТС при
 * подключении, то есть требуется обратимость. Поэтому AES-256-GCM —
 * с аутентификацией, чтобы подмена шифротекста в базе не прошла молча.
 *
 * Ключ берётся из окружения и НИКОГДА не хранится в базе рядом с данными:
 * иначе дамп базы содержит и замок, и ключ к нему.
 */

const ALGO = 'aes-256-gcm';
const PREFIX = 'enc:v1:';

function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    // Падать, а не шифровать нулевым ключом: молчаливая деградация здесь
    // означала бы пароли клиентов, лежащие практически открыто.
    throw new Error('ENCRYPTION_KEY не задан — шифрование секретов невозможно');
  }
  // hex(64) или base64(44) — иначе считаем, что передали парольную фразу
  const buf = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, 'hex')
    : crypto.createHash('sha256').update(raw, 'utf8').digest();
  if (buf.length !== 32) throw new Error('ENCRYPTION_KEY должен давать 32 байта');
  return buf;
}

/** Зашифрован ли уже этот текст (для миграции значений и идемпотентности). */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encryptSecret(plain: string): string {
  if (plain === '') return '';
  if (isEncrypted(plain)) return plain; // не шифруем дважды
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALGO, key(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, data]).toString('base64');
}

export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!isEncrypted(stored)) {
    // Значение из до-шифровальных времён. Возвращаем как есть, иначе
    // интеграция у уже настроенных предприятий молча отвалится.
    return stored;
  }
  const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const d = crypto.createDecipheriv(ALGO, key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

/** Маска для выдачи наружу: сам пароль в API не отдаём никогда. */
export function maskSecret(stored: string | null | undefined): string | null {
  return stored ? '********' : null;
}
