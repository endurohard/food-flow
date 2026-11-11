import { Router, Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import { SupplierDeskService, SupplierDeskError } from '../services/supplier-desk.service';
import { SupplierService } from '../services/supplier.service';
import { authenticateUser } from '../middleware/auth.middleware';
import { requireStockWriter } from '../middleware/stock-writer';
import { config } from '../config';

/**
 * Поставщики: сводка, сверка, правка с проверкой полей, удаление черновика
 * накладной. Монтируется ДО маршрутов поставщиков: /overview иначе поймал
 * бы их GET /:id, а PUT /:id здесь — с проверкой (там тело шло в базу как есть).
 */
const router = Router();
const desk = new SupplierDeskService(config.database.url);
const suppliers = new SupplierService(config.database.url);

const uuid = Joi.string().uuid();
const opt = (max: number) => Joi.string().trim().max(max).allow('', null).optional();
const updateSchema = Joi.object({
  name: Joi.string().trim().min(1).max(255).optional(),
  contactPerson: opt(100),
  phone: opt(30),
  email: Joi.string().trim().email().max(255).allow('', null).optional(),
  taxId: opt(50),
  address: opt(500),
  paymentTerms: opt(50)
}).min(1);

function enterprise(req: Request, res: Response, next: NextFunction): any {
  if (!req.enterpriseId) return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
  if (req.params.id && uuid.validate(req.params.id).error) return res.status(404).json({ error: 'Не найдено' });
  return next();
}

function fail(res: Response, e: any, what: string) {
  if (e instanceof SupplierDeskError || e?.name === 'SupplierDeskError') {
    return res.status(e.status || 400).json({ error: e.message, message: e.message });
  }
  console.error(what, e);
  return res.status(500).json({ error: 'Internal server error' });
}

router.get('/overview', authenticateUser, enterprise, async (req: Request, res: Response) => {
  try { return res.json({ suppliers: await desk.overview(req.enterpriseId!) }); }
  catch (e) { return fail(res, e, 'Suppliers overview error:'); }
});

router.get('/:id/ledger', authenticateUser, enterprise, async (req: Request, res: Response) => {
  try {
    const l = await desk.ledger(req.params.id, req.enterpriseId!);
    if (!l) return res.status(404).json({ error: 'Поставщик не найден' });
    return res.json(l);
  } catch (e) { return fail(res, e, 'Supplier ledger error:'); }
});

router.put('/:id', authenticateUser, requireStockWriter, enterprise, async (req: Request, res: Response) => {
  try {
    const { error, value } = updateSchema.validate(req.body || {});
    if (error) return res.status(400).json({ error: error.details[0].message, message: error.details[0].message });
    for (const k of Object.keys(value)) if (value[k] === '') value[k] = null;
    const supplier = await suppliers.update(req.params.id, value, req.enterpriseId);
    if (!supplier) return res.status(404).json({ error: 'Поставщик не найден' });
    return res.json({ supplier });
  } catch (e) { return fail(res, e, 'Update supplier error:'); }
});

router.delete('/invoices/:id', authenticateUser, requireStockWriter, enterprise, async (req: Request, res: Response) => {
  try { return res.json({ deleted: await desk.deleteDraftInvoice(req.params.id, req.enterpriseId!, config.invoiceUploadDir) }); }
  catch (e) { return fail(res, e, 'Delete draft invoice error:'); }
});

export default router;
