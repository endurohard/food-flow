import express from 'express';
import { BotService } from './services/bot.service';
import { logger } from './utils/logger';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Validate required environment variables
const requiredEnvVars = ['TELEGRAM_BOT_TOKEN', 'ALLOWED_USER_IDS'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    logger.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const PORT = parseInt(process.env.PORT || '3007', 10);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const ALLOWED_USER_IDS = process.env.ALLOWED_USER_IDS!.split(',').map(id => parseInt(id.trim(), 10));
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads/invoices';

// Initialize Express app
const app = express();
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'telegram-bot-service',
    timestamp: new Date().toISOString()
  });
});

// Initialize bot service
let botService: BotService;

async function start() {
  try {
    logger.info('Starting Telegram Bot Service...');
    logger.info(`Port: ${PORT}`);
    logger.info(`Allowed users: ${ALLOWED_USER_IDS.length}`);
    logger.info(`Upload directory: ${UPLOAD_DIR}`);

    // Create bot service
    botService = new BotService(BOT_TOKEN, ALLOWED_USER_IDS, UPLOAD_DIR);

    // Webhook endpoint (optional, for production)
    const WEBHOOK_URL = process.env.WEBHOOK_URL;
    if (WEBHOOK_URL) {
      logger.info(`Setting up webhook: ${WEBHOOK_URL}`);
      app.use(botService.getBot().webhookCallback('/webhook'));

      // Set webhook
      await botService.getBot().telegram.setWebhook(WEBHOOK_URL);
      logger.info('Webhook set successfully');
    } else {
      // Use polling mode (for development)
      logger.info('Using polling mode (no webhook configured)');
      await botService.launch();
    }

    // Start Express server
    app.listen(PORT, () => {
      logger.info(`Server listening on port ${PORT}`);
      logger.info('Telegram Bot Service started successfully');
    });

    // Graceful shutdown
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));

  } catch (error) {
    logger.error('Failed to start service:', error);
    process.exit(1);
  }
}

async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully...`);

  try {
    if (botService) {
      await botService.stop();
    }

    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
}

// Start the service
start();
