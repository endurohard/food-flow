import { Router, Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import { PurchaseOrderService, PurchaseOrderError } from '../services/purchase-order.service';
import { authenticateUser, requireRole } from '../middleware/auth.middleware';
import { config } from '../config';

/**
 * Заказы поставщикам: /api/suppliers/purchase-orders/…
 * Монтируется ДО маршрутов поставщиков: иначе /purchase-orders поймал бы
 * их GET /:id.
 */
const router = Router();
const service = new PurchaseOrderService(config.database.url);
const WRITE = requireRole('admin', 'owner', 'manager', 'operator');

const uuid = Joi.string().uuid();
const itemSchema = Joi.object({
  inventoryItemId: uuid.required(),
  quantity: Joi.number().positive().max(1e7).required(),
  pricePerUnit: Joi.number().min(0).max(1e9).allow(null).optional()
});
const headerSchema = {
  supplierId: uuid.allow(null, '').optional(),
  warehouseId: uuid.allow(null, '').optional(),
  expectedDate: Joi.date().iso().allow(null, '').optional(),
  notes: Joi.string().max(1000).allow(null, '').optional()
};
const createSchema = Joi.object({ ...headerSchema, items: Joi.array().items(itemSchema).max(500).optional() });
const updateSchema = Joi.object(headerSchema).min(1);

/** Только своё предприятие; у супер-админа контекста предприятия нет — сюда ему нельзя. */
function enterprise(req: Request, res: Response, next: NextFunction): any {
  if (!req.enterpriseId) return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
  if (req.params.id && uuid.validate(req.params.id).error) return res.status(404).json({ error: 'Заказ не найден' });
  return next();
}

function fail(res: Response, e: any, what: string) {
  if (e instanceof PurchaseOrderError || e?.name === 'PurchaseOrderError') {
    return res.status(e.status || 400).json({ error: e.message, message: e.message });
  }
  console.error(what, e);
  return res.status(500).json({ error: 'Internal server error' });
}

const isoDate = (v: any) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);

router.get('/purchase-orders/suggestions', authenticateUser, enterprise, async (req: Request, res: Response) => {
  try { return res.json({ suggestions: await service.suggestions(req.enterpriseId!) }); }
  catch (e) { return fail(res, e, 'PO suggestions error:'); }
});

router.get('/purchase-orders', authenticateUser, enterprise, async (req: Request, res: Response) => {
  try {
    const status = typeof req.query.status === 'string' && /^[a-z_]{3,20}$/.test(req.query.status) ? req.query.status : undefined;
    const supplierId = typeof req.query.supplierId === 'string' && !uuid.validate(req.query.supplierId).error ? req.query.supplierId : undefined;
    return res.json({ orders: await service.list(req.enterpriseId!, { status, supplierId }) });
  } catch (e) { return fail(res, e, 'PO list error:'); }
});

router.get('/purchase-orders/:id', authenticateUser, enterprise, async (req: Request, res: Response) => {
  try {
    const order = await service.get(req.params.id, req.enterpriseId!);
    if (!order) return res.status(404).json({ error: 'Заказ не найден' });
    return res.json({ order });
  } catch (e) { return fail(res, e, 'PO get error:'); }
});

router.post('/purchase-orders', authenticateUser, enterprise, WRITE, async (req: Request, res: Response) => {
  try {
    const { error, value } = createSchema.validate(req.body);
    if (error) return res.status(400).json({ error: 'Validation error', message: error.details[0].message });
    value.expectedDate = isoDate(value.expectedDate);
    const order = await service.create(req.enterpriseId!, req.userId, value);
    return res.status(201).json({ order });
  } catch (e) { return fail(res, e, 'PO create error:'); }
});

router.put('/purchase-orders/:id', authenticateUser, enterprise, WRITE, async (req: Request, res: Response) => {
  try {
    const { error, value } = updateSchema.validate(req.body);
    if (error) return res.status(400).json({ error: 'Validation error', message: error.details[0].message });
    value.expectedDate = isoDate(value.expectedDate);
    return res.json({ order: await service.updateHeader(req.params.id, req.enterpriseId!, value) });
  } catch (e) { return fail(res, e, 'PO update error:'); }
});

router.post('/purchase-orders/:id/items', authenticateUser, enterprise, WRITE, async (req: Request, res: Response) => {
  try {
    const { error, value } = itemSchema.validate(req.body);
    if (error) return res.status(400).json({ error: 'Validation error', message: error.details[0].message });
    await service.setItem(req.params.id, req.enterpriseId!, value);
    return res.json({ order: await service.get(req.params.id, req.enterpriseId!) });
  } catch (e) { return fail(res, e, 'PO item error:'); }
});

router.delete('/purchase-orders/:id/items/:itemId', authenticateUser, enterprise, WRITE, async (req: Request, res: Response) => {
  try {
    if (uuid.validate(req.params.itemId).error) return res.status(404).json({ error: 'Позиция не найдена' });
    await service.removeItem(req.params.id, req.enterpriseId!, req.params.itemId);
    return res.json({ order: await service.get(req.params.id, req.enterpriseId!) });
  } catch (e) { return fail(res, e, 'PO item delete error:'); }
});

router.post('/purchase-orders/:id/send', authenticateUser, enterprise, WRITE, async (req: Request, res: Response) => {
  try { return res.json({ order: await service.send(req.params.id, req.enterpriseId!) }); }
  catch (e) { return fail(res, e, 'PO send error:'); }
});

router.post('/purchase-orders/:id/cancel', authenticateUser, enterprise, WRITE, async (req: Request, res: Response) => {
  try { return res.json({ order: await service.cancel(req.params.id, req.enterpriseId!) }); }
  catch (e) { return fail(res, e, 'PO cancel error:'); }
});

router.post('/purchase-orders/:id/invoice', authenticateUser, enterprise, WRITE, async (req: Request, res: Response) => {
  try {
    const r = await service.createInvoice(req.params.id, req.enterpriseId!);
    return res.status(r.existing ? 200 : 201).json(r);
  } catch (e) { return fail(res, e, 'PO invoice error:'); }
});

export default router;
