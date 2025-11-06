import { Express, Request, Response } from 'express';
import client from 'prom-client';

const register = new client.Registry();

client.collectDefaultMetrics({ register });

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

const httpRequestTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

const ordersPrinted = new client.Counter({
  name: 'orders_printed_total',
  help: 'Total number of orders printed',
  labelNames: ['type'], // 'kitchen' or 'customer'
  registers: [register],
});

const ordersReceived = new client.Counter({
  name: 'orders_received_total',
  help: 'Total number of orders received from queue',
  registers: [register],
});

const kitchenDisplayConnections = new client.Gauge({
  name: 'kitchen_display_connections',
  help: 'Number of active kitchen display connections',
  registers: [register],
});

export function setupMetrics(app: Express): void {
  app.use((req: Request, res: Response, next) => {
    const start = Date.now();

    res.on('finish', () => {
      const duration = (Date.now() - start) / 1000;
      const route = req.route?.path || req.path;

      httpRequestDuration
        .labels(req.method, route, res.statusCode.toString())
        .observe(duration);
      httpRequestTotal
        .labels(req.method, route, res.statusCode.toString())
        .inc();
    });

    next();
  });

  app.get('/metrics', async (req: Request, res: Response) => {
    res.setHeader('Content-Type', register.contentType);
    const metrics = await register.metrics();
    res.send(metrics);
  });
}

export { register, ordersPrinted, ordersReceived, kitchenDisplayConnections };
