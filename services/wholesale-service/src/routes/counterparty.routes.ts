import { Router, Request, Response } from 'express';
import Joi from 'joi';
import pkg from 'pg';
const { Pool } = pkg;
import { authenticateUser, requireRole, ROLES } from '../middleware/auth.middleware';
import { CounterpartyService } from '../services/counterparty.service';
import { logger } from '../utils/logger';

const createSchema = Joi.object({
  name: Joi.string().max(255).required(),
  legalName: Joi.string().max(255).allow('', null),
  taxId: Joi.string().max(50).allow('', null),
  contactPerson: Joi.string().max(255).allow('', null),
  phone: Joi.string().max(50).allow('', null),
  whatsappPhone: Joi.string().max(50).allow('', null),
  email: Joi.string().email().allow('', null),
  address: Joi.string().allow('', null),
  deliveryAddress: Joi.string().allow('', null),
  managerId: Joi.string().uuid().allow(null),
  paymentTerms: Joi.string().valid('prepaid', 'on_delivery', 'deferred'),
  paymentDeferralDays: Joi.number().integer().min(0).max(365),
  creditLimit: Joi.number().min(0),
  priceType: Joi.string().valid('wholesale', 'retail'),
  notes: Joi.string().allow('', null)
});

const updateSchema = createSchema.fork(['name'], (s) => s.optional()).keys({
  isActive: Joi.boolean()
});

export function counterpartyRoutes(pool: InstanceType<typeof Pool>): Router {
  const router = Router();
  const service = new CounterpartyService(pool);

  const MANAGE_ROLES = [ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER];

  // Список контрагентов
  router.get('/counterparties', authenticateUser, async (req: Request, res: Response) => {
    try {
      const rows = await service.list({
        enterpriseId: req.enterpriseId,
        managerId: req.query.managerId as string | undefined,
        search: req.query.search as string | undefined,
        includeInactive: req.query.includeInactive === 'true'
      });
      res.json({ counterparties: rows });
    } catch (err) {
      logger.error('list counterparties failed', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  router.get('/counterparties/:id', authenticateUser, async (req: Request, res: Response) => {
    try {
      const cp = await service.getById(req.params.id, req.enterpriseId);
      if (!cp) return res.status(404).json({ error: 'Counterparty not found' });
      res.json({ counterparty: cp });
    } catch (err) {
      logger.error('get counterparty failed', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // Баланс и взаиморасчёты
  router.get('/counterparties/:id/balance', authenticateUser, async (req: Request, res: Response) => {
    try {
      const balance = await service.getBalance(req.params.id, req.enterpriseId);
      if (!balance) return res.status(404).json({ error: 'Counterparty not found' });
      res.json(balance);
    } catch (err) {
      logger.error('get counterparty balance failed', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  router.post('/counterparties', authenticateUser, requireRole(...MANAGE_ROLES), async (req: Request, res: Response) => {
    try {
      const isSuper = req.userRole === 'super_admin';
      if (!isSuper && !req.enterpriseId) {
        return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
      }
      const { error, value } = createSchema.validate(req.body);
      if (error) return res.status(400).json({ error: 'ValidationError', message: error.message });
      // Менеджером по умолчанию становится создатель
      if (!value.managerId && req.userId) value.managerId = req.userId;
      const cp = await service.create(value, isSuper ? undefined : req.enterpriseId);
      res.status(201).json({ counterparty: cp });
    } catch (err) {
      logger.error('create counterparty failed', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  router.put('/counterparties/:id', authenticateUser, requireRole(...MANAGE_ROLES), async (req: Request, res: Response) => {
    try {
      const isSuper = req.userRole === 'super_admin';
      if (!isSuper && !req.enterpriseId) {
        return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
      }
      const { error, value } = updateSchema.validate(req.body);
      if (error) return res.status(400).json({ error: 'ValidationError', message: error.message });
      const cp = await service.update(req.params.id, value, isSuper ? undefined : req.enterpriseId);
      if (!cp) return res.status(404).json({ error: 'Counterparty not found or nothing to update' });
      res.json({ counterparty: cp });
    } catch (err) {
      logger.error('update counterparty failed', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  router.delete('/counterparties/:id', authenticateUser, requireRole(...MANAGE_ROLES), async (req: Request, res: Response) => {
    try {
      const isSuper = req.userRole === 'super_admin';
      if (!isSuper && !req.enterpriseId) {
        return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
      }
      const ok = await service.deactivate(req.params.id, isSuper ? undefined : req.enterpriseId);
      if (!ok) return res.status(404).json({ error: 'Counterparty not found' });
      res.json({ success: true });
    } catch (err) {
      logger.error('delete counterparty failed', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  return router;
}

export default counterpartyRoutes;
