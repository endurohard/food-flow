import https from 'https';
import http from 'http';
import tls from 'tls';

/**
 * Вызов Telegram Bot API без зависимостей.
 *
 * С iTTEST контейнеры до api.telegram.org напрямую не достают (таймаут),
 * поэтому при заданном TELEGRAM_PROXY_URL (http://host:port) идём через
 * HTTP CONNECT-туннель. Переменные HTTPS_PROXY в контейнере указывают на
 * 127.0.0.1 самого контейнера и не годятся — отдельная переменная нарочно.
 */

export class TelegramError extends Error {
  constructor(message: string, public code?: number) { super(message); }
}

const TIMEOUT_MS = 15_000;

function tunnel(proxyUrl: string): Promise<tls.TLSSocket> {
  const p = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: p.hostname, port: Number(p.port || 80), method: 'CONNECT',
      path: 'api.telegram.org:443', timeout: TIMEOUT_MS
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new TelegramError(`прокси отказал: ${res.statusCode}`));
      }
      resolve(tls.connect({ socket, servername: 'api.telegram.org' }));
    });
    req.on('timeout', () => req.destroy(new TelegramError('прокси не ответил')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Скачать файл, который прислали боту (getFile → file_path). Тем же путём,
 * что и tgCall: через TELEGRAM_PROXY_URL, если задан. Больше maxBytes — ошибка.
 */
export async function tgDownload(token: string, filePath: string, maxBytes = 10 * 1024 * 1024): Promise<Buffer> {
  const proxy = process.env.TELEGRAM_PROXY_URL || '';
  const socket = proxy ? await tunnel(proxy) : undefined;
  return new Promise<Buffer>((resolve, reject) => {
    const req = https.request({
      host: 'api.telegram.org', path: `/file/bot${token}/${filePath}`, method: 'GET', timeout: 30_000,
      ...(socket ? { createConnection: () => socket } : {})
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new TelegramError('файл не скачался: ' + res.statusCode)); }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(new TelegramError('файл слишком большой')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new TelegramError('Telegram не отдал файл')));
    req.on('error', (e: any) => reject(e instanceof TelegramError ? e : new TelegramError('нет связи с Telegram: ' + (e.code || e.message))));
    req.end();
  });
}

export async function tgCall<T = any>(token: string, method: string, params: Record<string, any> = {}): Promise<T> {
  const body = JSON.stringify(params);
  const proxy = process.env.TELEGRAM_PROXY_URL || '';
  const socket = proxy ? await tunnel(proxy) : undefined;

  const raw = await new Promise<string>((resolve, reject) => {
    const req = https.request({
      host: 'api.telegram.org', path: `/bot${token}/${method}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: TIMEOUT_MS,
      ...(socket ? { createConnection: () => socket } : {})
    }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve(d));
    });
    req.on('timeout', () => req.destroy(new TelegramError('Telegram не ответил')));
    req.on('error', (e: any) => reject(e instanceof TelegramError ? e : new TelegramError('нет связи с Telegram: ' + (e.code || e.message))));
    req.end(body);
  });

  let json: any;
  try { json = JSON.parse(raw); } catch { throw new TelegramError('непонятный ответ Telegram'); }
  if (!json.ok) throw new TelegramError(json.description || 'ошибка Telegram', json.error_code);
  return json.result as T;
}
