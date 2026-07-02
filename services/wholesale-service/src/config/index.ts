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
  port: parseInt(process.env.PORT || '3013', 10),
  database: { url: process.env.DATABASE_URL || 'postgresql://foodflow:foodflow_secret@localhost:5432/foodflow' },
  jwt: { secret: process.env.JWT_SECRET || 'your-jwt-secret-key-change-in-production' },
  inventoryServiceUrl: process.env.INVENTORY_SERVICE_URL || 'http://inventory-service:3005',
  financeServiceUrl: process.env.FINANCE_SERVICE_URL || 'http://finance-service:3012',
  whatsappServiceUrl: process.env.WHATSAPP_SERVICE_URL || 'http://whatsapp-service:3008',
  internalToken: process.env.INTERNAL_TOKEN || ''
};
