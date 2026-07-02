import winston from 'winston';

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.printf((info) => {
      const { timestamp, level, message, stack, ...meta } = info;
      const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      const stackStr = stack ? `\n${stack}` : '';
      return `[${String(level).toUpperCase()}] ${timestamp} ${String(message)}${extra}${stackStr}`;
    })
  ),
  transports: [new winston.transports.Console()]
});
