import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config';
import { logger } from './utils/logger';
import { setupSwagger } from './swagger';
import { setupMetrics } from './metrics';
import { RabbitMQService } from './services/rabbitmq.service';
import { PrinterService } from './services/printer.service';
import { KitchenDisplayService } from './services/kitchen-display.service';
import kitchenRoutes from './routes/kitchen.routes';
import printerRoutes from './routes/printer.routes';

const app = express();
const httpServer = createServer(app);

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

// Logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('user-agent')
  });
  next();
});

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'healthy',
    service: 'kitchen-service',
    timestamp: new Date().toISOString()
  });
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

  socket.on('authenticate', async (data: { restaurantId: string; token: string }) => {
    try {
      // TODO: Validate token and restaurant access
      socket.join(`restaurant:${data.restaurantId}`);
      logger.info(`Display authenticated for restaurant: ${data.restaurantId}`);

      // Send current orders to the newly connected display
      await kitchenDisplayService.sendActiveOrders(data.restaurantId, socket);
    } catch (error) {
      logger.error('Authentication error:', error);
      socket.emit('error', { message: 'Authentication failed' });
    }
  });

  socket.on('updateOrderStatus', async (data: { orderId: string; status: string }) => {
    try {
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
httpServer.listen(PORT, async () => {
  logger.info(`Kitchen service listening on port ${PORT}`);
  logger.info(`Environment: ${config.nodeEnv}`);
  logger.info(`Swagger docs: http://localhost:${PORT}/api-docs`);

  await startServices();
});

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down gracefully...');
  await rabbitmqService.disconnect();
  httpServer.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export default app;
