import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'crypto';
import pkg from 'pg';
const { Pool } = pkg;
import { config } from './config';
import { logger } from './utils/logger';
import counterpartyRoutes from './routes/counterparty.routes';
import orderRoutes from './routes/order.routes';
import returnRoutes from './routes/return.routes';
import reportRoutes from './routes/report.routes';
import invoiceRoutes from './routes/invoice.routes';

const app = express();

const pool = new Pool({ connectionString: config.database.url });

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
    await pool.query('SELECT 1');
    res.json({ status: 'healthy', service: 'wholesale-service', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'unhealthy', service: 'wholesale-service', error: 'database unreachable' });
  }
});

app.use('/api/wholesale', counterpartyRoutes(pool));
app.use('/api/wholesale', orderRoutes(pool));
app.use('/api/wholesale', returnRoutes(pool));
app.use('/api/wholesale', reportRoutes(pool));
app.use('/api/wholesale', invoiceRoutes(pool));

app.use((_req: Request, res: Response) => { res.status(404).json({ error: 'Not Found' }); });
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

const PORT = config.port;
const server = app.listen(PORT, () => { logger.info(`Wholesale service listening on port ${PORT}`); });

const shutdown = (signal: string) => {
  logger.info(`${signal} received, shutting down gracefully`);
  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
