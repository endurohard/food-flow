import express from 'express';
import { Server } from 'socket.io';
import http from 'http';
import * as dotenv from 'dotenv';
import { YeastarWebSocketService } from './services/yeastar-websocket.service';
import { CallLoggerService } from './services/call-logger.service';
import { YeastarConfig } from './models/call.model';
import { logger } from './utils/logger';

// Load environment variables
dotenv.config();

// Validate required environment variables
const requiredEnvVars = ['YEASTAR_HOST', 'YEASTAR_USERNAME', 'YEASTAR_PASSWORD', 'DATABASE_URL'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    logger.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const PORT = parseInt(process.env.PORT || '3008', 10);

// Yeastar configuration
const yeastarConfig: YeastarConfig = {
  host: process.env.YEASTAR_HOST!,
  port: parseInt(process.env.YEASTAR_PORT || '8088', 10),
  username: process.env.YEASTAR_USERNAME!,
  password: process.env.YEASTAR_PASSWORD!,
  apiVersion: process.env.YEASTAR_API_VERSION || 'v2.0.0',
  reconnectInterval: parseInt(process.env.YEASTAR_RECONNECT_INTERVAL || '10000', 10),
  heartbeatInterval: parseInt(process.env.YEASTAR_HEARTBEAT_INTERVAL || '30000', 10)
};

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Initialize Socket.IO for real-time updates to frontend
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST']
  }
});

app.use(express.json());

// Initialize services
let yeastarService: YeastarWebSocketService;
let callLogger: CallLoggerService;

async function start() {
  try {
    logger.info('Starting Yeastar Service...');

    // Initialize call logger
    callLogger = new CallLoggerService(process.env.DATABASE_URL!);
    await callLogger.initialize();

    // Initialize Yeastar WebSocket service
    yeastar Service = new YeastarWebSocketService(yeastarConfig);

    // Setup event handlers
    setupYeastarEventHandlers();

    // Connect to Yeastar
    await yeastarService.connect();

    // Setup API routes
    setupApiRoutes();

    // Start Express server
    server.listen(PORT, () => {
      logger.info(`Server listening on port ${PORT}`);
      logger.info('Yeastar Service started successfully');
    });

    // Graceful shutdown
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));

  } catch (error) {
    logger.error('Failed to start service:', error);
    process.exit(1);
  }
}

function setupYeastarEventHandlers() {
  // Connection events
  yeastarService.on('connected', () => {
    logger.info('Connected to Yeastar PBX');
    io.emit('yeastar:connected');
  });

  yeastarService.on('disconnected', () => {
    logger.warn('Disconnected from Yeastar PBX');
    io.emit('yeastar:disconnected');
  });

  yeastarService.on('error', (error) => {
    logger.error('Yeastar error:', error);
  });

  // Call events
  yeastarService.on('call:new', async (call) => {
    logger.info(`New call: ${call.from} -> ${call.to}`);

    // Log to database
    await callLogger.logCall(call);

    // Emit to frontend
    io.emit('call:new', call);

    // TODO: Check if caller is in customer database
    // TODO: Show popup on operator's screen
  });

  yeastarService.on('call:ringing', async (call) => {
    logger.info(`Call ringing: ${call.callId}`);
    await callLogger.logCall(call);
    io.emit('call:ringing', call);
  });

  yeastarService.on('call:answered', async (call) => {
    logger.info(`Call answered: ${call.callId}`);
    await callLogger.logCall(call);
    io.emit('call:answered', call);
  });

  yeastarService.on('call:ended', async (call) => {
    logger.info(`Call ended: ${call.callId}, duration: ${call.duration}s`);
    await callLogger.logCall(call);
    io.emit('call:ended', call);
  });

  yeastarService.on('extension:status', (event) => {
    io.emit('extension:status', event);
  });
}

function setupApiRoutes() {
  // Health check
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'yeastar-service',
      connected: yeastarService.isConnectionActive(),
      timestamp: new Date().toISOString()
    });
  });

  // Get active calls
  app.get('/api/calls/active', (req, res) => {
    try {
      const calls = yeastarService.getActiveCalls();
      res.json({ calls });
    } catch (error) {
      logger.error('Failed to get active calls:', error);
      res.status(500).json({ error: 'Failed to get active calls' });
    }
  });

  // Get call logs
  app.get('/api/calls/logs', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const offset = parseInt(req.query.offset as string) || 0;

      const logs = await callLogger.getCallLogs(limit, offset);
      res.json({ logs });
    } catch (error) {
      logger.error('Failed to get call logs:', error);
      res.status(500).json({ error: 'Failed to get call logs' });
    }
  });

  // Get call logs by phone number
  app.get('/api/calls/logs/phone/:number', async (req, res) => {
    try {
      const logs = await callLogger.getCallLogsByPhone(req.params.number);
      res.json({ logs });
    } catch (error) {
      logger.error('Failed to get call logs by phone:', error);
      res.status(500).json({ error: 'Failed to get call logs' });
    }
  });

  // Get call stats by extension
  app.get('/api/calls/stats/:extension', async (req, res) => {
    try {
      const fromDate = new Date(req.query.from as string || new Date().toISOString().split('T')[0]);
      const toDate = new Date(req.query.to as string || new Date().toISOString());

      const stats = await callLogger.getCallStatsByExtension(req.params.extension, fromDate, toDate);
      res.json({ stats });
    } catch (error) {
      logger.error('Failed to get call stats:', error);
      res.status(500).json({ error: 'Failed to get call stats' });
    }
  });

  // Click-to-call
  app.post('/api/calls/dial', async (req, res) => {
    try {
      const { from, to, autoAnswer } = req.body;

      if (!from || !to) {
        return res.status(400).json({ error: 'Missing required parameters: from, to' });
      }

      const result = await yeastarService.makeCall(from, to, autoAnswer);
      res.json({ success: true, result });
    } catch (error) {
      logger.error('Click-to-call failed:', error);
      res.status(500).json({ error: 'Failed to initiate call' });
    }
  });

  // Hangup call
  app.post('/api/calls/hangup/:callId', async (req, res) => {
    try {
      const result = await yeastarService.hangupCall(req.params.callId);
      res.json({ success: true, result });
    } catch (error) {
      logger.error('Hangup failed:', error);
      res.status(500).json({ error: 'Failed to hangup call' });
    }
  });

  // Link call to customer
  app.post('/api/calls/:callId/customer', async (req, res) => {
    try {
      const { customerId, customerName, customerPhone } = req.body;

      await callLogger.linkCallToCustomer(req.params.callId, customerId, customerName, customerPhone);
      res.json({ success: true });
    } catch (error) {
      logger.error('Failed to link call to customer:', error);
      res.status(500).json({ error: 'Failed to link call' });
    }
  });

  // Link call to order
  app.post('/api/calls/:callId/order', async (req, res) => {
    try {
      const { orderId } = req.body;

      await callLogger.linkCallToOrder(req.params.callId, orderId);
      res.json({ success: true });
    } catch (error) {
      logger.error('Failed to link call to order:', error);
      res.status(500).json({ error: 'Failed to link call' });
    }
  });

  // Add note to call
  app.post('/api/calls/:callId/notes', async (req, res) => {
    try {
      const { note } = req.body;

      await callLogger.addCallNote(req.params.callId, note);
      res.json({ success: true });
    } catch (error) {
      logger.error('Failed to add note:', error);
      res.status(500).json({ error: 'Failed to add note' });
    }
  });

  // Get extension status
  app.get('/api/extensions/:number/status', async (req, res) => {
    try {
      const status = await yeastarService.getExtensionStatus(req.params.number);
      res.json({ status });
    } catch (error) {
      logger.error('Failed to get extension status:', error);
      res.status(500).json({ error: 'Failed to get extension status' });
    }
  });
}

async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully...`);

  try {
    if (yeastarService) {
      await yeastarService.disconnect();
    }

    if (callLogger) {
      await callLogger.close();
    }

    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });

    // Force exit after 10 seconds
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);

  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
}

// Socket.IO connection
io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);

  // Send current active calls to new client
  socket.emit('call:active', yeastarService.getActiveCalls());

  socket.on('disconnect', () => {
    logger.info(`Client disconnected: ${socket.id}`);
  });
});

// Start the service
start();
