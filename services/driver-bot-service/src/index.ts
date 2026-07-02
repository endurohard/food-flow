import express from 'express';
import { Telegraf } from 'telegraf';
import { config } from './config';
import { logger } from './utils/logger';
import { registerBotHandlers } from './bot';
import { startPoller, stopPoller } from './poller';
import { pool } from './db';

const app = express();
app.use(express.json());

let botStarted = false;

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'driver-bot-service',
    bot: botStarted ? 'running' : 'disabled',
    timestamp: new Date().toISOString()
  });
});

let bot: Telegraf | null = null;

async function start(): Promise<void> {
  logger.info('Starting Driver Bot Service...');
  logger.info(`Port: ${config.port}`);
  logger.info(`Wholesale service: ${config.wholesaleServiceUrl}`);
  logger.info(`Poll interval: ${config.pollIntervalMs} ms`);

  app.listen(config.port, () => {
    logger.info(`Health server listening on port ${config.port}`);
  });

  if (!config.botToken) {
    logger.warn('DRIVER_BOT_TOKEN is not set — bot disabled, serving /health only');
    return;
  }
  if (!config.internalToken) {
    logger.warn('INTERNAL_TOKEN is not set — wholesale-service calls will be rejected');
  }

  bot = new Telegraf(config.botToken);
  registerBotHandlers(bot);

  bot
    .launch(() => {
      botStarted = true;
      logger.info('Telegram bot started (polling mode)');
    })
    .catch((err) => {
      botStarted = false;
      logger.error('Telegram bot polling stopped with error', err);
    });

  startPoller(bot);
}

async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  try {
    stopPoller();
    if (bot && botStarted) bot.stop(signal);
    await pool.end();
    process.exit(0);
  } catch (e) {
    logger.error('Error during shutdown', e);
    process.exit(1);
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

start().catch((err) => {
  logger.error('Failed to start service', err);
  process.exit(1);
});
