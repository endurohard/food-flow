import { Router, Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import { SupplierDeskService, SupplierDeskError } from '../services/supplier-desk.service';
import { SupplierService } from '../services/supplier.service';
import { SupplierReturnService, SupplierReturnError } from '../services/supplier-return.service';
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
const returns = new SupplierReturnService(config.database.url);

const uuid = Joi.string().uuid();

const returnSchema = Joi.object({
  items: Joi.array().items(Joi.object({
    invoiceItemId: uuid.required(),
    quantity: Joi.number().positive().max(1e7).required()
  })).min(1).max(200).required(),
  reason: Joi.string().valid('defect', 'wrong', 'surplus', 'expired', 'other').allow(null).optional(),
  notes: Joi.string().trim().max(500).allow('', null).optional()
});
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

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
  if (e instanceof SupplierDeskError || e instanceof SupplierReturnError || e?.name === 'SupplierDeskError' || e?.name === 'SupplierReturnError') {
    return res.status(e.status || 400).json({ error: e.message, message: e.message });
  }
  console.error(what, e);
  return res.status(500).json({ error: 'Internal server error' });
}

router.get('/overview', authenticateUser, enterprise, async (req: Request, res: Response) => {
  try { return res.json({ suppliers: await desk.overview(req.enterpriseId!) }); }
  catch (e) { return fail(res, e, 'Suppliers overview error:'); }
});

// Закупки за период: принятые накладные минус возвраты поставщикам
router.get('/reports/purchases', authenticateUser, enterprise, async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const first = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
    const from = String(req.query.from || first);
    let to = String(req.query.to || '');
    if (!to) { const n = new Date(now.getFullYear(), now.getMonth() + 1, 1); to = `${n.getFullYear()}-${pad(n.getMonth() + 1)}-01`; }
    if (!isoDate.test(from) || !isoDate.test(to)) return res.status(400).json({ error: 'Даты в формате ГГГГ-ММ-ДД' });
    return res.json({ from, to, ...(await returns.purchasesReport(req.enterpriseId!, from, to)) });
  } catch (e) { return fail(res, e, 'Purchases report error:'); }
});

router.get('/invoices/:id/returns', authenticateUser, enterprise, async (req: Request, res: Response) => {
  try {
    const r = await returns.forInvoice(req.params.id, req.enterpriseId!);
    if (!r) return res.status(404).json({ error: 'Накладная не найдена' });
    return res.json(r);
  } catch (e) { return fail(res, e, 'Supplier returns list error:'); }
});

router.post('/invoices/:id/returns', authenticateUser, requireStockWriter, enterprise, async (req: Request, res: Response) => {
  try {
    const { error, value } = returnSchema.validate(req.body || {});
    if (error) return res.status(400).json({ error: error.details[0].message, message: error.details[0].message });
    const ret = await returns.create(req.params.id, req.enterpriseId!, req.userId, value);
    return res.status(201).json({ return: ret });
  } catch (e) { return fail(res, e, 'Supplier return error:'); }
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
