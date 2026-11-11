import { Router, Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import { InvoiceItemService, InvoiceItemError } from '../services/invoice-item.service';
import { authenticateUser } from '../middleware/auth.middleware';
import { requireStockWriter } from '../middleware/stock-writer';
import { config } from '../config';

/**
 * Позиции накладной и фасовки: /api/suppliers/invoices/:id/items…,
 * /api/suppliers/packages. Монтируется ДО маршрутов поставщиков
 * (у тех есть GET /:id, он поймал бы /packages).
 */
const router = Router();
const service = new InvoiceItemService(config.database.url);

const uuid = Joi.string().uuid();
const packSchema = Joi.object({
  name: Joi.string().trim().min(1).max(60).required(),
  size: Joi.number().positive().max(1e6).required(),
  count: Joi.number().positive().max(1e6).required(),
  price: Joi.number().min(0).max(1e9).required()
});
const itemSchema = Joi.object({
  inventoryItemId: uuid.allow(null).optional(),
  name: Joi.string().trim().max(255).optional(),
  unit: Joi.string().max(20).allow(null, '').optional(),
  quantity: Joi.number().positive().max(1e7).optional(),
  pricePerUnit: Joi.number().min(0).max(1e9).optional(),
  // Сумму считает сервер; старые клиенты её присылают — принимаем и игнорируем
  totalPrice: Joi.any().strip(),
  pack: packSchema.allow(null).optional()
}).or('pack', 'quantity');

/** Своё предприятие; супер-админ без контекста видит любую накладную. */
function scope(req: Request, res: Response, next: NextFunction): any {
  const isSuper = req.userRole === 'super_admin';
  if (!isSuper && !req.enterpriseId) return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
  if (req.params.id && uuid.validate(req.params.id).error) return res.status(404).json({ error: 'Invoice not found' });
  if (req.params.itemId && uuid.validate(req.params.itemId).error) return res.status(404).json({ error: 'Позиция не найдена' });
  (req as any).scopeEnterprise = isSuper ? (req.enterpriseId || undefined) : req.enterpriseId;
  return next();
}

function fail(res: Response, e: any, what: string) {
  if (e instanceof InvoiceItemError || e?.name === 'InvoiceItemError') {
    return res.status(e.status || 400).json({ error: e.message, message: e.message });
  }
  console.error(what, e);
  return res.status(500).json({ error: 'Internal server error' });
}

function body(req: Request, res: Response): any | null {
  const { error, value } = itemSchema.validate(req.body || {});
  if (error) { res.status(400).json({ error: error.details[0].message, message: error.details[0].message }); return null; }
  return value;
}

router.post('/invoices/:id/items', authenticateUser, requireStockWriter, scope, async (req: Request, res: Response) => {
  try {
    const value = body(req, res); if (!value) return;
    const item = await service.add(req.params.id, (req as any).scopeEnterprise, value);
    return res.status(201).json({ item });
  } catch (e) { return fail(res, e, 'Add invoice item error:'); }
});

router.put('/invoices/:id/items/:itemId', authenticateUser, requireStockWriter, scope, async (req: Request, res: Response) => {
  try {
    const value = body(req, res); if (!value) return;
    const item = await service.update(req.params.id, (req as any).scopeEnterprise, req.params.itemId, value);
    return res.json({ item });
  } catch (e) { return fail(res, e, 'Update invoice item error:'); }
});

router.delete('/invoices/:id/items/:itemId', authenticateUser, requireStockWriter, scope, async (req: Request, res: Response) => {
  try {
    await service.remove(req.params.id, (req as any).scopeEnterprise, req.params.itemId);
    return res.json({ ok: true });
  } catch (e) { return fail(res, e, 'Delete invoice item error:'); }
});

router.get('/packages', authenticateUser, async (req: Request, res: Response) => {
  try {
    if (!req.enterpriseId) return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    const itemId = String(req.query.itemId || '');
    if (uuid.validate(itemId).error) return res.status(400).json({ error: 'itemId required' });
    const sup = typeof req.query.supplierId === 'string' && !uuid.validate(req.query.supplierId).error ? req.query.supplierId : null;
    return res.json({ packages: await service.packages(req.enterpriseId, itemId, sup) });
  } catch (e) { return fail(res, e, 'Packages error:'); }
});

export default router;
