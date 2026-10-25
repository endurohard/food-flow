import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'crypto';
import path from 'path';
import pkg from 'pg';
const { Pool } = pkg;
import { config } from './config';
import { logger } from './utils/logger';
import restaurantRoutes from './routes/restaurant.routes';
import menuRoutes from './routes/menu.routes';
import pbxRoutes from './routes/pbx.routes';
import reservationRoutes from './routes/reservation.routes';

const app = express();

const healthPool = new Pool({ connectionString: config.database.url, max: 1 });

// Middleware
app.use(helmet());
app.use(cors());
// Загрузка фото блюда шлёт data URL и разбирает тело сама, с лимитом 8 МБ
const defaultJson = express.json();
app.use((req: Request, res: Response, next: NextFunction) =>
  /\/menu-items\/[^/]+\/image$/.test(req.path) ? next() : defaultJson(req, res, next)
);
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
    res.json({ status: 'healthy', service: 'restaurant-service', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'unhealthy', service: 'restaurant-service', error: 'database unreachable' });
  }
});

// Routes
// Фото блюд — публичные файлы; cross-origin, чтобы их видело и клиентское приложение
app.use('/api/restaurants/media', express.static(path.resolve(config.uploadDir), {
  maxAge: '30d',
  fallthrough: true,
  setHeaders: (res) => res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
}));
app.use('/api/restaurants', restaurantRoutes);
app.use('/api/restaurants', menuRoutes);  // menu routes are nested under /api/restaurants/:id/...
app.use('/api/restaurants', pbxRoutes);   // PBX settings (preserved from original)
// Тот же роутер меню под /api/menus (Kong уже ведёт этот префикс сюда): здесь
// одно-сегментные пути вроде /stop-list не перехватывает GET /api/restaurants/:id
app.use('/api/menus', menuRoutes);
app.use('/api/reservations', reservationRoutes);

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route not found`
  });
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: config.nodeEnv === 'development' ? err.message : 'Something went wrong'
  });
});

// Start server
const PORT = config.port;
const server = app.listen(PORT, () => {
  logger.info(`Restaurant service listening on port ${PORT}`);
  logger.info(`Environment: ${config.nodeEnv}`);
});

// Graceful shutdown
const shutdown = (signal: string) => {
  logger.info(`${signal} received, shutting down gracefully`);
  server.close(async () => {
    await healthPool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
