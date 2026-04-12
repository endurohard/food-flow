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
  port: parseInt(process.env.PORT || '3012', 10),
  database: { url: process.env.DATABASE_URL || 'postgresql://foodflow:foodflow_secret@localhost:5432/foodflow' },
  redis: { url: process.env.REDIS_URL || 'redis://localhost:6379' },
  jwt: { secret: process.env.JWT_SECRET || 'your-jwt-secret-key-change-in-production' },
  yookassa: {
    shopId: process.env.YOOKASSA_SHOP_ID || '',
    secretKey: process.env.YOOKASSA_SECRET_KEY || '',
    returnUrl: process.env.YOOKASSA_RETURN_URL || 'http://localhost/payment/callback',
    webhookSecret: process.env.YOOKASSA_WEBHOOK_SECRET || ''
  }
};
