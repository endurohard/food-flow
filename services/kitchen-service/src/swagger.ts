import { Express } from 'express';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Kitchen Service API',
      version: '1.0.0',
      description: 'Kitchen Display System and Printer Integration for Food Flow',
    },
    servers: [
      {
        url: 'http://localhost:3005',
        description: 'Development server',
      },
      {
        url: 'http://localhost:8000',
        description: 'Kong API Gateway',
      },
    ],
    components: {
      schemas: {
        Order: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            orderNumber: { type: 'string' },
            status: {
              type: 'string',
              enum: ['confirmed', 'preparing', 'ready', 'picked_up'],
            },
            customerName: { type: 'string' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  quantity: { type: 'integer' },
                  specialInstructions: { type: 'string' },
                },
              },
            },
            specialInstructions: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        PrinterStatus: {
          type: 'object',
          properties: {
            connected: { type: 'boolean' },
            type: { type: 'string' },
            interface: { type: 'string' },
          },
        },
      },
    },
  },
  apis: ['./src/routes/*.ts'],
};

const swaggerSpec = swaggerJsdoc(options);

export function setupSwagger(app: Express): void {
  app.use(
    '/api-docs',
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      explorer: true,
      customCss: '.swagger-ui .topbar { display: none }',
      customSiteTitle: 'Kitchen Service API Documentation',
    })
  );

  app.get('/api-docs.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });
}
