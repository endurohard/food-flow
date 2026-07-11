import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'crypto';
import pkg from 'pg';
const { Pool } = pkg;
import { config } from './config';
import { logger } from './utils/logger';
import { setupSwagger } from './swagger';
import { setupMetrics } from './metrics';
import { RabbitMQService } from './services/rabbitmq.service';
import { PrinterService } from './services/printer.service';
import { KitchenDisplayService } from './services/kitchen-display.service';
import kitchenRoutes from './routes/kitchen.routes';
import printerRoutes from './routes/printer.routes';
import stationRoutes from './routes/station.routes';

const app = express();
const httpServer = createServer(app);

const healthPool = new Pool({ connectionString: config.database.url, max: 1 });

// Socket.IO setup for Kitchen Display System
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Middleware
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
    res.json({ status: 'healthy', service: 'kitchen-service', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'unhealthy', service: 'kitchen-service', error: 'database unreachable' });
  }
});

// Metrics
setupMetrics(app);

// Swagger documentation
setupSwagger(app);

// Make io accessible to routes
app.set('io', io);

// Routes
app.use('/api/kitchen', kitchenRoutes);
app.use('/api/printers', printerRoutes);
app.use('/api/stations', stationRoutes);

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`
  });
});

// Error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// Initialize services
const printerService = new PrinterService();
const kitchenDisplayService = new KitchenDisplayService(io);
const rabbitmqService = new RabbitMQService(printerService, kitchenDisplayService);

// Socket.IO connection handling
io.on('connection', (socket) => {
  logger.info(`Kitchen display connected: ${socket.id}`);

  socket.on('authenticate', async (data: { restaurantId: string; token: string; enterpriseId?: string }) => {
    try {
      // TODO: Validate token and restaurant access
      const room = data.enterpriseId
        ? `enterprise:${data.enterpriseId}:restaurant:${data.restaurantId}`
        : `restaurant:${data.restaurantId}`;

      socket.join(room);
      logger.info(`Display authenticated for room: ${room}`);

      await kitchenDisplayService.sendActiveOrders(data.restaurantId, socket, data.enterpriseId);
    } catch (error) {
      logger.error('Authentication error:', error);
      socket.emit('error', { message: 'Authentication failed' });
    }
  });

  socket.on('updateOrderStatus', async (data: { orderId: string; status: string }) => {
    try {
      // TODO: multi-tenant — pass a VERIFIED enterpriseId as the 3rd arg once Socket.IO
      // auth is hardened (the `authenticate` payload is currently unverified, so we must
      // NOT trust data.enterpriseId here). Until then updateOrderStatus runs unscoped.
      await kitchenDisplayService.updateOrderStatus(data.orderId, data.status);
      logger.info(`Order ${data.orderId} status updated to ${data.status}`);
    } catch (error) {
      logger.error('Update order status error:', error);
      socket.emit('error', { message: 'Failed to update order status' });
    }
  });

  socket.on('disconnect', () => {
    logger.info(`Kitchen display disconnected: ${socket.id}`);
  });
});

// Start RabbitMQ consumer
async function startServices() {
  try {
    await rabbitmqService.connect();
    await rabbitmqService.consumeOrders();
    logger.info('RabbitMQ service started successfully');
  } catch (error) {
    logger.error('Failed to start RabbitMQ service:', error);
    process.exit(1);
  }
}

// Start server
const PORT = config.port;
const server = httpServer.listen(PORT, async () => {
  logger.info(`Kitchen service listening on port ${PORT}`);
  logger.info(`Environment: ${config.nodeEnv}`);
  logger.info(`Swagger docs: http://localhost:${PORT}/api-docs`);

  await startServices();
});

// Graceful shutdown
const shutdown = (signal: string) => {
  logger.info(`${signal} received, shutting down gracefully`);
  server.close(async () => {
    await rabbitmqService.disconnect();
    await healthPool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
