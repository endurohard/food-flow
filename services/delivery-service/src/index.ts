import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import http from 'http';
import crypto from 'crypto';
import { Server as SocketIOServer } from 'socket.io';
import pkg from 'pg';
const { Pool } = pkg;
import { config } from './config';
import { logger } from './utils/logger';
import deliveryRoutes from './routes/delivery.routes';

const app = express();
const httpServer = http.createServer(app);

const healthPool = new Pool({ connectionString: config.database.url, max: 1 });

// Socket.IO for real-time delivery tracking
const io = new SocketIOServer(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

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
    res.json({ status: 'healthy', service: 'delivery-service', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'unhealthy', service: 'delivery-service', error: 'database unreachable' });
  }
});

// Routes
app.use('/api/deliveries', deliveryRoutes);

// Socket.IO events for live tracking
io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);

  // Driver joins their delivery room
  socket.on('joinDelivery', (deliveryId: string) => {
    socket.join(`delivery:${deliveryId}`);
    logger.info(`Socket ${socket.id} joined delivery:${deliveryId}`);
  });

  // Customer tracks a delivery
  socket.on('trackOrder', (orderId: string) => {
    socket.join(`order:${orderId}`);
    logger.info(`Socket ${socket.id} tracking order:${orderId}`);
  });

  // Driver sends location update
  socket.on('locationUpdate', (data: { deliveryId: string; lat: number; lng: number; speed?: number; heading?: number }) => {
    // Broadcast to all clients tracking this delivery
    io.to(`delivery:${data.deliveryId}`).emit('driverLocation', {
      deliveryId: data.deliveryId,
      latitude: data.lat,
      longitude: data.lng,
      speed: data.speed,
      heading: data.heading,
      timestamp: new Date().toISOString()
    });
  });

  // Driver status update
  socket.on('statusUpdate', (data: { deliveryId: string; status: string }) => {
    io.to(`delivery:${data.deliveryId}`).emit('deliveryStatus', {
      deliveryId: data.deliveryId,
      status: data.status,
      timestamp: new Date().toISOString()
    });
  });

  socket.on('disconnect', () => {
    logger.info(`Client disconnected: ${socket.id}`);
  });
});

// Make io accessible to routes if needed
app.set('io', io);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not Found' });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

const PORT = config.port;
const server = httpServer.listen(PORT, () => {
  logger.info(`Delivery service listening on port ${PORT}`);
  logger.info(`Socket.IO ready for real-time tracking`);
});

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
