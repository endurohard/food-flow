import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'crypto';
import pkg from 'pg';
const { Pool } = pkg;
import { config } from './config';
import { logger } from './utils/logger';
import crmRoutes from './routes/crm.routes';
import walletRoutes from './routes/wallet.routes';
import { startWalletPusher } from './services/wallet.pusher';
import { getWalletConfig } from './services/wallet.runtime';
import { CRMService } from './services/crm.service';
import { OrderEventsConsumer } from './services/order-events.consumer';

const app = express();

const healthPool = new Pool({ connectionString: config.database.url, max: 1 });

app.use(helmet());
app.use(cors());
app.use(express.json());

// Correlation ID middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (!req.headers['x-request-id']) {
    req.headers['x-request-id'] = crypto.randomUUID();
  }
  next();
});

// Structured logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info(`${req.method} ${req.path}`, {
    requestId: req.headers['x-request-id'],
    userId: (req as any).userId,
    enterpriseId: (req as any).enterpriseId
  });
  next();
});

// Deep health check
app.get('/health', async (_req: Request, res: Response) => {
  try {
    await healthPool.query('SELECT 1');
    res.json({ status: 'healthy', service: 'crm-service', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'unhealthy', service: 'crm-service', error: 'database unreachable' });
  }
});

app.use('/api/crm', crmRoutes);
// Сервис обновлений Apple Wallet: телефоны ходят сюда сами (webServiceURL карты)
app.use('/api/wallet', walletRoutes);

app.use((_req: Request, res: Response) => { res.status(404).json({ error: 'Not Found' }); });
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

const PORT = config.port;
const server = app.listen(PORT, () => { logger.info(`CRM service listening on port ${PORT}`); });

// Подписка на закрытие заказов: баллы лояльности начисляются автоматически.
// Падение брокера не валит сервис — HTTP API работает и без событий.
const orderEventsConsumer = new OrderEventsConsumer(healthPool, new CRMService(config.database.url));
orderEventsConsumer
  .connect()
  .then(() => orderEventsConsumer.consume())
  .catch((err: Error) =>
    logger.warn(`Автоначисление баллов недоступно (RabbitMQ): ${err.message}`)
  );

// Apple Wallet: push на телефоны после изменения баллов. Без сертификата не запускается.
const walletCfg = getWalletConfig();
const stopWalletPusher = walletCfg ? startWalletPusher(new CRMService(config.database.url), walletCfg) : () => {};
logger.info(walletCfg ? `Apple Wallet включён (${walletCfg.passTypeId})` : 'Apple Wallet выключен: нет сертификата');

const shutdown = (signal: string) => {
  logger.info(`${signal} received, shutting down gracefully`);
  stopWalletPusher();
  orderEventsConsumer.disconnect().catch(() => {});
  server.close(async () => {
    await healthPool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
