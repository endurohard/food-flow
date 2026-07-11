import { Router, Request, Response } from 'express';
import Joi from 'joi';
import pkg from 'pg';
const { Pool } = pkg;
import { authenticateUser, requireRole, ROLES } from '../middleware/auth.middleware';
import { WholesaleReturnService } from '../services/return.service';
import { logger } from '../utils/logger';

const createSchema = Joi.object({
  reason: Joi.string().allow('', null),
  items: Joi.array().items(Joi.object({
    orderItemId: Joi.string().uuid().required(),
    quantity: Joi.number().positive().required(),
    disposition: Joi.string().valid('restock', 'write_off').required(),
    reason: Joi.string().allow('', null)
  })).min(1).required()
});

function isClientError(message: string): boolean {
  return /not found|Cannot|only possible|exceeds|draft/i.test(message);
}

export function returnRoutes(pool: InstanceType<typeof Pool>): Router {
  const router = Router();
  const service = new WholesaleReturnService(pool);

  const MANAGE_ROLES = [ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER, ROLES.OPERATOR];

  router.get('/returns', authenticateUser, async (req: Request, res: Response) => {
    try {
      const returns = await service.list({
        enterpriseId: req.enterpriseId,
        orderId: req.query.orderId as string | undefined,
        counterpartyId: req.query.counterpartyId as string | undefined,
        status: req.query.status as string | undefined,
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
        limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
        offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined
      });
      res.json({ returns });
    } catch (err) {
      logger.error('list returns failed', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  router.get('/reports/returns', authenticateUser, requireRole(...MANAGE_ROLES), async (req: Request, res: Response) => {
    try {
      const isSuper = req.userRole === 'super_admin';
      if (!isSuper && !req.enterpriseId) {
        return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
      }
      const report = await service.getReturnsReport({
        enterpriseId: isSuper ? undefined : req.enterpriseId,
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined
      });
      res.json(report);
    } catch (err) {
      logger.error('returns report failed', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  router.get('/returns/:id', authenticateUser, async (req: Request, res: Response) => {
    try {
      const ret = await service.getById(req.params.id, req.enterpriseId);
      if (!ret) return res.status(404).json({ error: 'Return not found' });
      res.json({ return: ret });
    } catch (err) {
      logger.error('get return failed', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  router.post('/orders/:orderId/returns', authenticateUser, requireRole(...MANAGE_ROLES), async (req: Request, res: Response) => {
    try {
      const isSuper = req.userRole === 'super_admin';
      if (!isSuper && !req.enterpriseId) {
        return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
      }
      const { error, value } = createSchema.validate(req.body);
      if (error) return res.status(400).json({ error: 'ValidationError', message: error.message });
      const ret = await service.create(req.params.orderId, value, req.userId, isSuper ? undefined : req.enterpriseId);
      res.status(201).json({ return: ret });
    } catch (err: any) {
      if (err.message && isClientError(err.message)) return res.status(400).json({ error: err.message });
      logger.error('create return failed', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  router.post('/returns/:id/confirm', authenticateUser, requireRole(...MANAGE_ROLES), async (req: Request, res: Response) => {
    try {
      const isSuper = req.userRole === 'super_admin';
      if (!isSuper && !req.enterpriseId) {
        return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
      }
      const ret = await service.confirm(req.params.id, req.userId, isSuper ? undefined : req.enterpriseId);
      res.json({ return: ret });
    } catch (err: any) {
      if (err.message && isClientError(err.message)) return res.status(400).json({ error: err.message });
      logger.error('confirm return failed', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  router.post('/returns/:id/cancel', authenticateUser, requireRole(...MANAGE_ROLES), async (req: Request, res: Response) => {
    try {
      const isSuper = req.userRole === 'super_admin';
      if (!isSuper && !req.enterpriseId) {
        return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
      }
      const ret = await service.cancel(req.params.id, isSuper ? undefined : req.enterpriseId);
      res.json({ return: ret });
    } catch (err: any) {
      if (err.message && isClientError(err.message)) return res.status(400).json({ error: err.message });
      logger.error('cancel return failed', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  return router;
}

export default returnRoutes;
