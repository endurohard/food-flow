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
  port: parseInt(process.env.PORT || '3006', 10),
  database: {
    url: process.env.DATABASE_URL || 'postgresql://foodflow:foodflow_secret@localhost:5432/foodflow'
  },
  rabbitmq: {
    url: process.env.RABBITMQ_URL || 'amqp://foodflow:foodflow_secret@localhost:5672'
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'your-jwt-secret-key-change-in-production'
  },
  financeServiceUrl: process.env.FINANCE_SERVICE_URL || 'http://finance-service:3012',
  internalToken: process.env.INTERNAL_TOKEN || '',
  // Фото накладных (из Telegram). В docker — том invoice_uploads
  invoiceUploadDir: process.env.INVOICE_UPLOAD_DIR || '/app/uploads/invoices',
  // Через user-service уходят уведомления в Telegram-бот организации
  userServiceUrl: process.env.USER_SERVICE_URL || '',
  // Как часто перепроверять остатки против минимума, мс (0 — не проверять)
  stockAlertIntervalMs: parseInt(process.env.STOCK_ALERT_INTERVAL_MS || '300000', 10)
};
