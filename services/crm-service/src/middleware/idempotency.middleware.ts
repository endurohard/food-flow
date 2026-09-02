import { Request, Response, NextFunction } from 'express';
import { createClient } from 'redis';
import { config } from '../config';

const IDEMPOTENCY_TTL = 86400; // 24 hours
const HEADER = 'idempotency-key';
const CONNECT_TIMEOUT_MS = 2000;
const OP_TIMEOUT_MS = 1000;

let redisClient: ReturnType<typeof createClient> | null = null;
// Redis не поднялся — идемпотентность выключается, но запрос не держим.
// Иначе node-redis переподключается бесконечно, а connect() не резолвится:
// клиент висит на POST навсегда (ловили на finance-service без REDIS_URL).
let redisUnavailable = false;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`redis ${label} timeout`)), ms);
    if (typeof (t as any).unref === 'function') (t as any).unref();
    p.then((v) => { clearTimeout(t); resolve(v); },
           (e) => { clearTimeout(t); reject(e); });
  });
}

async function getRedis() {
  if (redisUnavailable) return null;
  if (!redisClient) {
    const client = createClient({
      url: config.redis.url,
      socket: { connectTimeout: CONNECT_TIMEOUT_MS, reconnectStrategy: false }
    });
    client.on('error', () => {});
    try {
      await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, 'connect');
      redisClient = client;
    } catch {
      redisUnavailable = true;
      client.disconnect().catch(() => {});
      return null;
    }
  }
  return redisClient;
}

export const idempotencyCheck = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  const key = req.headers[HEADER] as string;
  if (!key) return next();

  const redis = await getRedis();
  if (!redis) return next();

  const cacheKey = `idem:${req.path}:${key}`;
  try {
    const cached = await withTimeout(redis.get(cacheKey), OP_TIMEOUT_MS, 'get');
    if (cached) {
      const { status, body } = JSON.parse(cached);
      return res.status(status).json(body);
    }

    const originalJson = res.json.bind(res);
    res.json = function (body: any) {
      redis.setEx(cacheKey, IDEMPOTENCY_TTL, JSON.stringify({ status: res.statusCode, body })).catch(() => {});
      return originalJson(body);
    } as any;

    next();
  } catch {
    next();
  }
};
