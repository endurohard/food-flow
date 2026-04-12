import dotenv from 'dotenv';

dotenv.config();

const INSECURE_JWT_DEFAULT = 'your-jwt-secret-key-change-in-production';
if (process.env.NODE_ENV === 'production') {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === INSECURE_JWT_DEFAULT) {
    throw new Error('JWT_SECRET must be set to a non-default value in production');
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set in production');
  }
}

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3005', 10),

  database: {
    url: process.env.DATABASE_URL || 'postgresql://foodflow:foodflow_secret@localhost:5432/foodflow'
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379'
  },

  rabbitmq: {
    url: process.env.RABBITMQ_URL || 'amqp://foodflow:foodflow_secret@localhost:5672'
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'your-jwt-secret-key-change-in-production'
  },

  printer: {
    // Printer configuration
    type: process.env.PRINTER_TYPE || 'network', // 'usb', 'network', or 'bluetooth'
    interface: process.env.PRINTER_INTERFACE || '192.168.1.100:9100', // IP:port for network, device path for USB
    encoding: process.env.PRINTER_ENCODING || 'UTF-8',
    width: parseInt(process.env.PRINTER_WIDTH || '48', 10), // characters per line
    autoPrint: process.env.AUTO_PRINT === 'true', // Auto-print orders
  },

  kitchen: {
    // Kitchen Display System settings
    orderTimeout: parseInt(process.env.ORDER_TIMEOUT || '1800', 10), // seconds (30 min)
    soundEnabled: process.env.SOUND_ENABLED !== 'false',
    autoRefresh: parseInt(process.env.AUTO_REFRESH || '30', 10), // seconds
  }
};
