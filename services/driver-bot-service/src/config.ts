import * as dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3015', 10),
  botToken: process.env.DRIVER_BOT_TOKEN || '',
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgresql://foodflow:foodflow@localhost:5432/foodflow',
  wholesaleServiceUrl:
    process.env.WHOLESALE_SERVICE_URL || 'http://wholesale-service:3013',
  internalToken: process.env.INTERNAL_TOKEN || '',
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '30000', 10)
};
