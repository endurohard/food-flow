import { Request, Response, NextFunction } from 'express';
import { createClient } from 'redis';
import { config } from '../config';

const IDEMPOTENCY_TTL = 86400; // 24 hours
const HEADER = 'idempotency-key';

let redisClient: ReturnType<typeof createClient> | null = null;

async function getRedis() {
  if (!redisClient) {
    redisClient = createClient({ url: config.redis.url });
    redisClient.on('error', () => {});
    await redisClient.connect().catch(() => { redisClient = null; });
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
    const cached = await redis.get(cacheKey);
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
