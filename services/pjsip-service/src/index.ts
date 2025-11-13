import express from 'express';
import { Server } from 'socket.io';
import http from 'http';
import cors from 'cors';
import * as dotenv from 'dotenv';
import { SIPConnectionManager } from './services/sip-connection-manager.service.js';
import { CallLoggerService } from './services/call-logger.service.js';
import { SIPConfig, SIPUser } from './models/call.model.js';
import { logger } from './utils/logger.js';

// Load environment variables
dotenv.config();

// Validate required environment variables
const requiredEnvVars = ['SIP_SERVER', 'SIP_USERS', 'DATABASE_URL'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    logger.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const PORT = parseInt(process.env.PORT || '3009', 10);

// Parse SIP users from environment
function parseSIPUsers(): SIPUser[] {
  const usersStr = process.env.SIP_USERS!;
  return usersStr.split(',').map(userStr => {
    const parts = userStr.trim().split(':');
    const [username, password, extension, displayName, wsPassword] = parts;
    return {
      username,
      password,
      extension,
      displayName,
      wsPassword: wsPassword || password // Use separate WS password if provided
    };
  });
}

// SIP configuration
const sipConfig: SIPConfig = {
  server: process.env.SIP_SERVER!,
  port: parseInt(process.env.SIP_PORT || '5060', 10),
  transport: (process.env.SIP_TRANSPORT as 'UDP' | 'TCP' | 'TLS' | 'WS' | 'WSS') || 'UDP',
  users: parseSIPUsers(),
  rtpPortMin: parseInt(process.env.RTP_PORT_MIN || '5700', 10),
  rtpPortMax: parseInt(process.env.RTP_PORT_MAX || '5750', 10),
  websocketUrl: process.env.SIP_WEBSOCKET_URL,
  useWebSocket: process.env.SIP_USE_WEBSOCKET === 'true'
};

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Initialize Socket.IO for real-time updates
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST']
  },
  path: process.env.SOCKETIO_PATH || '/socket.io'
});

app.use(cors());
app.use(express.json());

// Initialize services
let sipClient: SIPConnectionManager;
let callLogger: CallLoggerService;

async function start() {
  try {
    logger.info('Starting PJSIP Service...');

    // Initialize call logger
    callLogger = new CallLoggerService(process.env.DATABASE_URL!);
    await callLogger.initialize();

    // Initialize SIP client with connection manager
    sipClient = new SIPConnectionManager(sipConfig);

    // Setup event handlers
    setupSIPEventHandlers();

    // Setup API routes
    setupApiRoutes();

    // Start Express server first
    server.listen(PORT, () => {
      logger.info(`Server listening on port ${PORT}`);
      logger.info('PJSIP Service started successfully');
    });

    // Try to connect to SIP server (don't fail if unable to connect)
    try {
      await sipClient.connect();
      logger.info(`Registered ${sipConfig.users.length} SIP users`);
    } catch (sipError) {
      logger.warn('Failed to connect to SIP server (service will continue to run):', sipError);
      logger.info('API endpoints are available. Configure SIP settings in the web interface.');
    }

    // Graceful shutdown
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));

  } catch (error) {
    logger.error('Failed to start service:', error);
    process.exit(1);
  }
}

function setupSIPEventHandlers() {
  // Connection events
  sipClient.on('connected', () => {
    logger.info('Connected to SIP server');
    io.emit('sip:connected');
  });

  sipClient.on('disconnected', () => {
    logger.warn('Disconnected from SIP server');
    io.emit('sip:disconnected');
  });

  sipClient.on('error', (error) => {
    logger.error('SIP error:', error);
    io.emit('sip:error', { error: error.message });
  });

  // Call events
  sipClient.on('call:new', async (call) => {
    logger.info(`New call: ${call.from} -> ${call.to} (${call.direction})`);

    // Log to database
    await callLogger.logCall(call);

    // Emit to frontend
    io.emit('call:new', call);

    // TODO: Check if caller is in customer database
    // TODO: Show popup on operator's screen
  });

  sipClient.on('call:ringing', async (call) => {
    logger.info(`Call ringing: ${call.id}`);
    await callLogger.logCall(call);
    io.emit('call:ringing', call);
  });

  sipClient.on('call:answered', async (call) => {
    logger.info(`Call answered: ${call.id}`);
    await callLogger.logCall(call);
    io.emit('call:answered', call);
  });

  sipClient.on('call:ended', async (call) => {
    logger.info(`Call ended: ${call.id}, duration: ${call.duration}s`);
    await callLogger.logCall(call);
    io.emit('call:ended', call);
  });

  sipClient.on('call:held', async (call) => {
    logger.info(`Call held: ${call.id}`);
    await callLogger.logCall(call);
    io.emit('call:held', call);
  });

  sipClient.on('call:resumed', async (call) => {
    logger.info(`Call resumed: ${call.id}`);
    await callLogger.logCall(call);
    io.emit('call:resumed', call);
  });

  sipClient.on('call:transferred', async (call) => {
    logger.info(`Call transferred: ${call.id}`);
    await callLogger.logCall(call);
    io.emit('call:transferred', call);
  });

  sipClient.on('call:cancelled', async (call) => {
    logger.info(`Call cancelled: ${call.id}`);
    await callLogger.logCall(call);
    io.emit('call:cancelled', call);
  });

  sipClient.on('call:failed', async (call) => {
    logger.info(`Call failed: ${call.id}`);
    await callLogger.logCall(call);
    io.emit('call:failed', call);
  });

  sipClient.on('transport:switched', (info) => {
    logger.info(`Transport switched to: ${info.type}`);
    io.emit('transport:switched', info);
  });
}

function setupApiRoutes() {
  // Health check
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'pjsip-service',
      connected: sipClient.isConnected(),
      connectionType: sipClient.getConnectionType(),
      registeredUsers: sipConfig.users.length,
      timestamp: new Date().toISOString()
    });
  });

  // Get connection info
  app.get('/api/pbx/connection', (req, res) => {
    try {
      const info = sipClient.getConnectionInfo();
      res.json(info);
    } catch (error: any) {
      logger.error('Failed to get connection info:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Switch transport (between WebSocket and native)
  app.post('/api/pbx/switch-transport', async (req, res) => {
    try {
      const {
        server,
        port,
        transport,
        websocketUrl,
        useWebSocket,
        users
      } = req.body;

      if (!server) {
        return res.status(400).json({ error: 'Missing required parameter: server' });
      }

      const newConfig: SIPConfig = {
        server,
        port: port || 5060,
        transport: transport || 'UDP',
        users: users || sipConfig.users,
        rtpPortMin: sipConfig.rtpPortMin,
        rtpPortMax: sipConfig.rtpPortMax,
        websocketUrl,
        useWebSocket
      };

      await sipClient.switchTransport(newConfig);

      res.json({
        success: true,
        connectionType: sipClient.getConnectionType(),
        message: `Switched to ${sipClient.getConnectionType()} transport`
      });
    } catch (error: any) {
      logger.error('Failed to switch transport:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Test PBX connection
  app.post('/api/pbx/test-connection', async (req, res) => {
    try {
      const { server, port, transport, websocketUrl } = req.body;

      if (!server || !port) {
        return res.status(400).json({ error: 'Missing required parameters: server, port' });
      }

      const isConnected = sipClient.isConnected();
      const connectionType = sipClient.getConnectionType();

      res.json({
        success: true,
        connected: isConnected,
        connectionType,
        message: isConnected
          ? `Successfully connected to ${server}:${port} via ${connectionType} (${transport || 'UDP'})`
          : `Configuration valid but not connected to ${server}:${port}. Will connect on save.`
      });
    } catch (error: any) {
      logger.error('PBX connection test failed:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get registered extensions
  app.get('/api/extensions', (req, res) => {
    res.json({
      extensions: sipConfig.users.map(u => ({
        extension: u.extension,
        username: u.username,
        displayName: u.displayName
      }))
    });
  });

  // Get active calls
  app.get('/api/calls/active', (req, res) => {
    try {
      const calls = sipClient.getActiveCalls();
      res.json({ calls });
    } catch (error: any) {
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
    } catch (error: any) {
      logger.error('Failed to get call logs:', error);
      res.status(500).json({ error: 'Failed to get call logs' });
    }
  });

  // Get call logs by phone number
  app.get('/api/calls/logs/phone/:number', async (req, res) => {
    try {
      const logs = await callLogger.getCallLogsByPhone(req.params.number);
      res.json({ logs });
    } catch (error: any) {
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
    } catch (error: any) {
      logger.error('Failed to get call stats:', error);
      res.status(500).json({ error: 'Failed to get call stats' });
    }
  });

  // Click-to-call (make outbound call)
  app.post('/api/calls/dial', async (req, res) => {
    try {
      const { from, to, autoAnswer } = req.body;

      if (!from || !to) {
        return res.status(400).json({ error: 'Missing required parameters: from, to' });
      }

      const call = await sipClient.makeCall(from, to, autoAnswer);
      res.json({ success: true, call });
    } catch (error: any) {
      logger.error('Click-to-call failed:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Answer incoming call
  app.post('/api/calls/answer/:callId', async (req, res) => {
    try {
      await sipClient.answerCall(req.params.callId);
      res.json({ success: true });
    } catch (error: any) {
      logger.error('Answer call failed:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Hangup call
  app.post('/api/calls/hangup/:callId', async (req, res) => {
    try {
      await sipClient.hangupCall(req.params.callId);
      res.json({ success: true });
    } catch (error: any) {
      logger.error('Hangup failed:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Hold call
  app.post('/api/calls/hold/:callId', async (req, res) => {
    try {
      await sipClient.holdCall(req.params.callId);
      res.json({ success: true });
    } catch (error: any) {
      logger.error('Hold call failed:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Unhold call
  app.post('/api/calls/unhold/:callId', async (req, res) => {
    try {
      await sipClient.unholdCall(req.params.callId);
      res.json({ success: true });
    } catch (error: any) {
      logger.error('Unhold call failed:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Transfer call
  app.post('/api/calls/transfer/:callId', async (req, res) => {
    try {
      const { target } = req.body;

      if (!target) {
        return res.status(400).json({ error: 'Missing required parameter: target' });
      }

      await sipClient.transferCall(req.params.callId, target);
      res.json({ success: true });
    } catch (error: any) {
      logger.error('Transfer call failed:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Link call to customer
  app.post('/api/calls/:callId/customer', async (req, res) => {
    try {
      const { customerId, customerName, customerPhone } = req.body;

      await callLogger.linkCallToCustomer(req.params.callId, customerId, customerName, customerPhone);
      res.json({ success: true });
    } catch (error: any) {
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
    } catch (error: any) {
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
    } catch (error: any) {
      logger.error('Failed to add note:', error);
      res.status(500).json({ error: 'Failed to add note' });
    }
  });
}

async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully...`);

  try {
    if (sipClient) {
      await sipClient.disconnect();
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
  socket.emit('calls:active', sipClient.getActiveCalls());

  socket.on('disconnect', () => {
    logger.info(`Client disconnected: ${socket.id}`);
  });
});

// Start the service
start();
