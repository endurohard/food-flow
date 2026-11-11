import { Router, Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import { InventoryCountService, InventoryCountError } from '../services/inventory-count.service';
import { InventoryService } from '../services/inventory.service';
import { authenticateUser, requireRole } from '../middleware/auth.middleware';
import { config } from '../config';

/** Инвентаризация: /api/inventory/counts… */
const router = Router();
const service = new InventoryCountService(config.database.url);
const inventoryService = new InventoryService(config.database.url);

// Вводить факт может и оператор склада; проводить и отменять — руководитель:
// проведение меняет остатки и фиксирует недостачу в рублях.
const COUNT = requireRole('admin', 'owner', 'manager', 'operator');
const POST = requireRole('admin', 'owner', 'manager');

const uuid = Joi.string().uuid();
const createSchema = Joi.object({
  warehouseId: uuid.required(),
  category: Joi.string().max(100).allow(null, '').optional(),
  notes: Joi.string().max(1000).allow(null, '').optional()
});
const saveSchema = Joi.object({
  items: Joi.array().items(Joi.object({
    inventoryItemId: uuid.required(),
    countedQty: Joi.number().min(0).max(1e8).allow(null).required()
  })).min(1).max(2000).required()
});
const postSchema = Joi.object({ zeroUncounted: Joi.boolean().optional() });

function enterprise(req: Request, res: Response, next: NextFunction): any {
  if (!req.enterpriseId) return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
  if (req.params.id && uuid.validate(req.params.id).error) return res.status(404).json({ error: 'Инвентаризация не найдена' });
  return next();
}

function fail(res: Response, e: any, what: string) {
  if (e instanceof InventoryCountError || e?.name === 'InventoryCountError') {
    return res.status(e.status || 400).json({ error: e.message, message: e.message });
  }
  console.error(what, e);
  return res.status(500).json({ error: 'Internal server error' });
}

function valid(schema: Joi.ObjectSchema, req: Request, res: Response): any | null {
  const { error, value } = schema.validate(req.body || {});
  if (error) { res.status(400).json({ error: error.details[0].message, message: error.details[0].message }); return null; }
  return value;
}

router.get('/counts', authenticateUser, COUNT, enterprise, async (req: Request, res: Response) => {
  try {
    const wh = typeof req.query.warehouseId === 'string' && !uuid.validate(req.query.warehouseId).error ? req.query.warehouseId : undefined;
    return res.json({ counts: await service.list(req.enterpriseId!, { warehouseId: wh }) });
  } catch (e) { return fail(res, e, 'Counts list error:'); }
});

router.get('/counts/:id', authenticateUser, COUNT, enterprise, async (req: Request, res: Response) => {
  try {
    const count = await service.get(req.params.id, req.enterpriseId!);
    if (!count) return res.status(404).json({ error: 'Инвентаризация не найдена' });
    return res.json({ count });
  } catch (e) { return fail(res, e, 'Count get error:'); }
});

router.post('/counts', authenticateUser, COUNT, enterprise, async (req: Request, res: Response) => {
  try {
    const v = valid(createSchema, req, res); if (!v) return;
    return res.status(201).json({ count: await service.create(req.enterpriseId!, req.userId, v) });
  } catch (e) { return fail(res, e, 'Count create error:'); }
});

router.put('/counts/:id/items', authenticateUser, COUNT, enterprise, async (req: Request, res: Response) => {
  try {
    const v = valid(saveSchema, req, res); if (!v) return;
    return res.json({ saved: await service.saveCounts(req.params.id, req.enterpriseId!, v.items) });
  } catch (e) { return fail(res, e, 'Count save error:'); }
});

router.post('/counts/:id/post', authenticateUser, POST, enterprise, async (req: Request, res: Response) => {
  try {
    const v = valid(postSchema, req, res); if (!v) return;
    return res.json({ count: await service.post(req.params.id, req.enterpriseId!, req.userId, inventoryService, v) });
  } catch (e) { return fail(res, e, 'Count post error:'); }
});

router.post('/counts/:id/cancel', authenticateUser, POST, enterprise, async (req: Request, res: Response) => {
  try { return res.json({ count: await service.cancel(req.params.id, req.enterpriseId!) }); }
  catch (e) { return fail(res, e, 'Count cancel error:'); }
});

export default router;
