import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'crypto';
import pkg from 'pg';
const { Pool } = pkg;
import { config } from './config';
import { logger } from './utils/logger';
import inventoryRoutes from './routes/inventory.routes';
import supplierRoutes from './routes/supplier.routes';
import purchaseOrderRoutes from './routes/purchase-order.routes';
import inventoryCountRoutes from './routes/inventory-count.routes';
import invoiceItemRoutes from './routes/invoice-item.routes';
import techCardRoutes from './routes/techcard.routes';
import productionRoutes from './routes/production.routes';
import nomenclatureRoutes from './routes/nomenclature.routes';
import { stockAlerts } from './services/stock-alerts.instance';

const app = express();

const healthPool = new Pool({ connectionString: config.database.url, max: 1 });

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
    res.json({ status: 'healthy', service: 'inventory-service', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'unhealthy', service: 'inventory-service', error: 'database unreachable' });
  }
});

// Routes
app.use('/api/inventory', inventoryCountRoutes);
app.use('/api/inventory', productionRoutes);
app.use('/api/inventory', inventoryRoutes);
// Заказы поставщикам — раньше маршрутов поставщиков (у тех есть GET /:id)
app.use('/api/suppliers', purchaseOrderRoutes);
app.use('/api/suppliers', invoiceItemRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/tech-cards', techCardRoutes);
app.use('/api/nomenclature', nomenclatureRoutes);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not Found' });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

const PORT = config.port;
const server = app.listen(PORT, () => {
  logger.info(`Inventory service listening on port ${PORT}`);
});

// Перепроверка остатков против минимума по всем складам: ловит приход по
// накладной, производство, правку минимума и повторяет несостоявшуюся отправку
let alertTimer: NodeJS.Timeout | undefined;
if (config.stockAlertIntervalMs > 0 && process.env.NODE_ENV !== 'test') {
  const tick = () => stockAlerts.sweep()
    .then((r) => { if (r.opened || r.resolved || r.notified) logger.info(`stock alerts: ${JSON.stringify(r)}`); })
    .catch((e) => logger.error(`stock alerts sweep failed: ${e.message || e}`));
  setTimeout(tick, 15_000);
  alertTimer = setInterval(tick, config.stockAlertIntervalMs);
}

const shutdown = (signal: string) => {
  logger.info(`${signal} received, shutting down gracefully`);
  if (alertTimer) clearInterval(alertTimer);
  server.close(async () => {
    await healthPool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
