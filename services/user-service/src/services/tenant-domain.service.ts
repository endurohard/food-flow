/**
 * Поддомен организации: <subdomain>.food-flow.ru.
 *
 * Маршрут `*.food-flow.ru` на фронтовом Kong уже ведёт любой поддомен в
 * FoodFlow, но TLS-сертификат плагин acme выпускает только по требованию —
 * первый заход на новый адрес получал бы чужой сертификат. Поэтому при
 * создании организации (и смене её поддомена) сертификат заказывается сразу,
 * через admin API фронтового Kong (`POST /acme {host}`).
 */

export const TENANT_BASE_DOMAIN = process.env.TENANT_BASE_DOMAIN || 'food-flow.ru';

// Служебные имена, которые не может занять организация
const RESERVED = new Set([
  'www', 'api', 'admin', 'app', 'mail', 'smtp', 'imap', 'pop', 'ftp', 'cdn', 'static',
  'assets', 'grafana', 'kong', 'status', 'help', 'support', 'docs', 'test', 'dev', 'staging',
  'login', 'auth', 'pos', 'kiosk', 'downloads',
]);

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function isReservedSubdomain(label: string): boolean {
  return RESERVED.has(label);
}

/** «Кофейня 104» → «kofeynya-104». Пустой или служебный результат → '' (решает вызывающий). */
export function subdomainFromName(name: string): string {
  const latin = name
    .toLowerCase()
    .split('')
    .map((ch) => (ch in TRANSLIT ? TRANSLIT[ch] : ch))
    .join('')
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  if (latin.length < 2 || RESERVED.has(latin)) return '';
  return latin;
}

export interface CertificateResult {
  status: 'issued' | 'skipped' | 'failed';
  host?: string;
  message?: string;
}

/**
 * Заказывает сертификат на поддомен. Создание организации от исхода не
 * зависит: при сбое плагин acme всё равно выпустит сертификат при первом
 * заходе, а результат честно возвращается в ответе API.
 */
export async function ensureSubdomainCertificate(
  subdomain: string | null | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<CertificateResult> {
  if (!subdomain) return { status: 'skipped', message: 'Поддомен не задан' };
  const admin = process.env.EDGE_KONG_ADMIN_URL;
  const host = `${subdomain}.${TENANT_BASE_DOMAIN}`;
  if (!admin) return { status: 'skipped', host, message: 'EDGE_KONG_ADMIN_URL не задан' };
  try {
    const res = await fetchImpl(admin.replace(/\/+$/, '') + '/acme', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host }),
      signal: AbortSignal.timeout(90_000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (res.ok) return { status: 'issued', host, message: body.message };
    return { status: 'failed', host, message: body.message || `HTTP ${res.status}` };
  } catch (e: any) {
    return { status: 'failed', host, message: e?.message || String(e) };
  }
}
