import { Router, Request, Response } from 'express';
import Joi from 'joi';
import pkg from 'pg';
const { Pool } = pkg;
import { authenticateUser, requireRole, ROLES } from '../middleware/auth.middleware';
import { WholesaleOrderService } from '../services/order.service';
import { config } from '../config';
import { logger } from '../utils/logger';

const itemSchema = Joi.object({
  inventoryItemId: Joi.string().uuid().required(),
  quantity: Joi.number().positive().required(),
  price: Joi.number().min(0).optional()
});

const createSchema = Joi.object({
  counterpartyId: Joi.string().uuid().required(),
  warehouseId: Joi.string().uuid().allow(null),
  managerId: Joi.string().uuid().allow(null),
  deliveryDate: Joi.date().iso().allow(null),
  deliveryAddress: Joi.string().allow('', null),
  notes: Joi.string().allow('', null),
  items: Joi.array().items(itemSchema).min(1).required()
});

const updateSchema = Joi.object({
  warehouseId: Joi.string().uuid().allow(null),
  managerId: Joi.string().uuid().allow(null),
  deliveryDate: Joi.date().iso().allow(null),
  deliveryAddress: Joi.string().allow('', null),
  notes: Joi.string().allow('', null),
  items: Joi.array().items(itemSchema).min(1).optional()
});

const paySchema = Joi.object({
  amount: Joi.number().positive().required(),
  method: Joi.string().valid('cash', 'card', 'transfer', 'offset').required(),
  registerId: Joi.string().uuid().optional(),
  notes: Joi.string().allow('', null)
});

function isClientError(message: string): boolean {
  return /not found|Cannot|Insufficient|without items|Credit limit|No price|not fully paid/i.test(message);
}

export function orderRoutes(pool: InstanceType<typeof Pool>): Router {
  const router = Router();
  const service = new WholesaleOrderService(pool);

  const MANAGE_ROLES = [ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER];
  const SHIP_ROLES = [ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER, ROLES.OPERATOR, ROLES.EMPLOYEE];

  router.get('/orders', authenticateUser, async (req: Request, res: Response) => {
    try {
      const orders = await service.list({
        enterpriseId: req.enterpriseId,
        counterpartyId: req.query.counterpartyId as string | undefined,
        status: req.query.status as string | undefined,
        driverId: req.query.driverId as string | undefined,
        managerId: req.query.managerId as string | undefined,
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
        offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined
      });
      res.json({ orders });
    } catch (err) {
      logger.error('list wholesale orders failed', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  router.get('/orders/:id', authenticateUser, async (req: Request, res: Response) => {
    try {
      const order = await service.getById(req.params.id, req.enterpriseId);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      res.json({ order });
    } catch (err) {
      logger.error('get wholesale order failed', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  router.post('/orders', authenticateUser, requireRole(...MANAGE_ROLES), async (req: Request, res: Response) => {
    try {
      const { error, value } = createSchema.validate(req.body);
      if (error) return res.status(400).json({ error: 'ValidationError', message: error.message });
      const order = await service.create(value, req.userId, req.enterpriseId);
      res.status(201).json({ order });
    } catch (err: any) {
      if (err.message && isClientError(err.message)) return res.status(400).json({ error: err.message });
      logger.error('create wholesale order failed', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  router.put('/orders/:id', authenticateUser, requireRole(...MANAGE_ROLES), async (req: Request, res: Response) => {
    try {
      const { error, value } = updateSchema.validate(req.body);
      if (error) return res.status(400).json({ error: 'ValidationError', message: error.message });
      const order = await service.update(req.params.id, value, req.enterpriseId);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      res.json({ order });
    } catch (err: any) {
      if (err.message && isClientError(err.message)) return res.status(400).json({ error: err.message });
      logger.error('update wholesale order failed', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  const transition = (fn: (id: string, enterpriseId?: string) => Promise<any>) =>
    async (req: Request, res: Response) => {
      try {
        const order = await fn(req.params.id, req.enterpriseId);
        res.json({ order });
      } catch (err: any) {
        if (err.message && isClientError(err.message)) return res.status(400).json({ error: err.message });
        logger.error('wholesale order transition failed', err);
        res.status(500).json({ error: 'Internal Server Error' });
      }
    };

  router.post('/orders/:id/confirm', authenticateUser, requireRole(...MANAGE_ROLES), transition((id, e) => service.confirm(id, e)));
  router.post('/orders/:id/assemble', authenticateUser, requireRole(...SHIP_ROLES), transition((id, e) => service.assemble(id, e)));
  router.post('/orders/:id/deliver', authenticateUser, requireRole(...SHIP_ROLES), transition((id, e) => service.deliver(id, e)));
  router.post('/orders/:id/close', authenticateUser, requireRole(...MANAGE_ROLES), transition((id, e) => service.closeOrder(id, e)));
  router.post('/orders/:id/cancel', authenticateUser, requireRole(...MANAGE_ROLES), transition((id, e) => service.cancel(id, e)));

  router.post('/orders/:id/ship', authenticateUser, requireRole(...SHIP_ROLES), async (req: Request, res: Response) => {
    try {
      const schema = Joi.object({ driverId: Joi.string().uuid().allow(null) });
      const { error, value } = schema.validate(req.body);
      if (error) return res.status(400).json({ error: 'ValidationError', message: error.message });
      const order = await service.ship(req.params.id, value, req.userId, req.enterpriseId);
      res.json({ order });
    } catch (err: any) {
      if (err.message && isClientError(err.message)) return res.status(400).json({ error: err.message });
      logger.error('ship wholesale order failed', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  router.post('/orders/:id/pay', authenticateUser, requireRole(...SHIP_ROLES), async (req: Request, res: Response) => {
    try {
      const { error, value } = paySchema.validate(req.body);
      if (error) return res.status(400).json({ error: 'ValidationError', message: error.message });
      const result = await service.pay(req.params.id, value, req.userId, req.enterpriseId);

      // Наличные проводим через кассу в finance-service (не фатально при сбое)
      if (value.method === 'cash' && value.registerId) {
        try {
          const resp = await fetch(`${config.financeServiceUrl}/api/finance/registers/${value.registerId}/operations`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': req.headers.authorization || ''
            },
            body: JSON.stringify({
              operationType: 'cash_in',
              amount: value.amount,
              paymentMethod: 'cash',
              description: `Оплата оптового заказа ${result.order.invoice_number || result.order.id}`
            })
          });
          if (!resp.ok) logger.warn(`finance cash_in failed: ${resp.status} ${await resp.text()}`);
        } catch (e) {
          logger.warn('finance cash_in unreachable', e);
        }
      }

      res.json(result);
    } catch (err: any) {
      if (err.message && isClientError(err.message)) return res.status(400).json({ error: err.message });
      logger.error('pay wholesale order failed', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  return router;
}

export default orderRoutes;
