import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { SupplierService } from '../services/supplier.service';
import { InventoryService } from '../services/inventory.service';
import express from 'express';
import { authenticateUser, authenticateInternal } from '../middleware/auth.middleware';
import { PHOTO_MIME } from '../services/supplier.service';
import { config } from '../config';

const router = Router();
const supplierService = new SupplierService(config.database.url);
const inventoryService = new InventoryService(config.database.url);

// ========== ОТЧЁТЫ (до параметрических маршрутов) ==========

// Взаиморасчёты со всеми поставщиками
router.get('/reports/settlements', authenticateUser, async (req: Request, res: Response) => {
  try {
    const settlements = await supplierService.getSettlementsReport({
      enterpriseId: req.enterpriseId,
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined
    });
    return res.json({ settlements });
  } catch (error) {
    console.error('Settlements report error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== ФОТО НАКЛАДНЫХ (Telegram) ==========

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Черновик накладной из фото. Только для user-service (бот организации):
 * тело — сам файл, сведения — в query. Не JSON: общий express.json()
 * ограничен 100 КБ, а фото весит мегабайты.
 */
router.post('/invoices/from-photo',
  authenticateInternal,
  express.raw({ type: PHOTO_MIME, limit: '10mb' }),
  async (req: Request, res: Response) => {
    if (!req.isInternal) return res.status(403).json({ error: 'Forbidden' });
    try {
      const enterpriseId = String(req.query.enterpriseId || '');
      const userId = req.query.userId ? String(req.query.userId) : undefined;
      const fileId = String(req.query.fileId || '').slice(0, 128);
      if (!UUID_RE.test(enterpriseId)) return res.status(400).json({ error: 'enterpriseId required' });
      if (userId && !UUID_RE.test(userId)) return res.status(400).json({ error: 'bad userId' });
      if (!fileId) return res.status(400).json({ error: 'fileId required' });
      const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
      const result = await supplierService.createDraftFromPhoto({
        enterpriseId, userId, fileId, mime, body: req.body as Buffer,
        caption: req.query.caption ? String(req.query.caption) : undefined
      }, config.invoiceUploadDir);
      return res.status(result.duplicate ? 200 : 201).json(result);
    } catch (error: any) {
      if (error.name === 'InvoiceError') return res.status(400).json({ error: error.message, message: error.message });
      console.error('Invoice from photo error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

// Фото накладной для админки (по токену пользователя, только своя организация)
router.get('/invoices/:id/photo', authenticateUser, async (req: Request, res: Response) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const isSuper = req.userRole === 'super_admin';
    const file = await supplierService.getInvoicePhotoPath(req.params.id, config.invoiceUploadDir, isSuper ? undefined : req.enterpriseId);
    if (!file) return res.status(404).json({ error: 'Фото нет' });
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.sendFile(file, (err) => { if (err && !res.headersSent) res.status(404).json({ error: 'Фото нет' }); });
  } catch (error) {
    console.error('Invoice photo error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== SUPPLIERS ==========

router.get('/', authenticateUser, async (req: Request, res: Response) => {
  try {
    const suppliers = await supplierService.list(req.enterpriseId);
    return res.json({ suppliers });
  } catch (error) {
    console.error('List suppliers error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', authenticateUser, async (req: Request, res: Response) => {
  try {
    const schema = Joi.object({
      name: Joi.string().min(1).max(255).required(),
      contactPerson: Joi.string().max(100).optional(),
      phone: Joi.string().max(20).optional(),
      email: Joi.string().email().optional(),
      taxId: Joi.string().max(50).optional(),
      address: Joi.string().optional(),
      paymentTerms: Joi.string().max(50).optional()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const supplier = await supplierService.create(value, req.enterpriseId);
    return res.status(201).json({ supplier });
  } catch (error) {
    console.error('Create supplier error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const supplier = await supplierService.update(req.params.id, req.body, req.enterpriseId);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    return res.json({ supplier });
  } catch (error) {
    console.error('Update supplier error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const deleted = await supplierService.delete(req.params.id, req.enterpriseId);
    if (!deleted) return res.status(404).json({ error: 'Supplier not found' });
    return res.json({ message: 'Supplier deactivated' });
  } catch (error) {
    console.error('Delete supplier error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== INVOICES ==========

router.get('/invoices', authenticateUser, async (req: Request, res: Response) => {
  try {
    const invoices = await supplierService.listInvoices({
      enterpriseId: req.enterpriseId,
      supplierId: req.query.supplierId as string,
      status: req.query.status as string
    });
    return res.json({ invoices });
  } catch (error) {
    console.error('List invoices error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Следующий свободный номер накладной для своего предприятия.
 * Нужен, когда у поставки нет бумаги со своим номером: вводить номера
 * руками означает рано или поздно получить дубль и задвоенный долг.
 */
router.get('/invoices/next-number', authenticateUser, async (req: Request, res: Response) => {
  try {
    if (!req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    const number = await supplierService.nextInvoiceNumber(req.enterpriseId);
    return res.json({ number });
  } catch (error) {
    console.error('Next invoice number error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/invoices', authenticateUser, async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    if (!isSuper) {
      if (req.body.warehouseId && !(await inventoryService.warehouseBelongsTo(req.body.warehouseId, req.enterpriseId!))) {
        return res.status(403).json({ error: 'Forbidden', message: 'Склад не принадлежит предприятию' });
      }
      if (req.body.supplierId && !(await supplierService.supplierBelongsTo(req.body.supplierId, req.enterpriseId!))) {
        return res.status(403).json({ error: 'Forbidden', message: 'Поставщик не принадлежит предприятию' });
      }
    }
    const invoice = await supplierService.createInvoice(req.body, req.enterpriseId);
    return res.status(201).json({ invoice });
  } catch (error) {
    console.error('Create invoice error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

const draftHeaderSchema = Joi.object({
  supplierId: Joi.string().uuid().allow(null, '').optional(),
  warehouseId: Joi.string().uuid().allow(null, '').optional(),
  invoiceNumber: Joi.string().trim().max(100).optional(),
  invoiceDate: Joi.date().iso().allow(null, '').optional(),
  notes: Joi.string().max(1000).allow(null, '').optional()
}).min(1);

router.put('/invoices/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    const { error, value } = draftHeaderSchema.validate(req.body);
    if (error) return res.status(400).json({ error: 'Validation error', message: error.details[0].message });
    if (!isSuper) {
      if (value.warehouseId && !(await inventoryService.warehouseBelongsTo(value.warehouseId, req.enterpriseId!))) {
        return res.status(403).json({ error: 'Forbidden', message: 'Склад не принадлежит предприятию' });
      }
      if (value.supplierId && !(await supplierService.supplierBelongsTo(value.supplierId, req.enterpriseId!))) {
        return res.status(403).json({ error: 'Forbidden', message: 'Поставщик не принадлежит предприятию' });
      }
    }
    if (value.invoiceDate instanceof Date) value.invoiceDate = value.invoiceDate.toISOString().slice(0, 10);
    const invoice = await supplierService.updateDraftHeader(req.params.id, value, isSuper ? undefined : req.enterpriseId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    return res.json({ invoice });
  } catch (error: any) {
    if (error.name === 'InvoiceError') return res.status(400).json({ error: error.message, message: error.message });
    console.error('Update invoice error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/invoices/:id/items', authenticateUser, async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    if (!isSuper && !(await supplierService.invoiceBelongsTo(req.params.id, req.enterpriseId!))) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    const items = await supplierService.getInvoiceItems(req.params.id);
    return res.json({ items });
  } catch (error) {
    console.error('Get invoice items error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /invoices/:id/items — в invoice-item.routes.ts (фасовки, сумма считается сервером)

router.post('/invoices/:id/confirm', authenticateUser, async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    const invoice = await supplierService.confirmInvoice(req.params.id, req.userId!, inventoryService, isSuper ? undefined : req.enterpriseId);
    return res.json({ invoice });
  } catch (error: any) {
    if (error.message === 'Invoice already confirmed' || error.message === 'Invoice not found') {
      return res.status(400).json({ error: error.message });
    }
    if (error.name === 'InvoiceError') {
      return res.status(400).json({ error: error.message, message: error.message });
    }
    // Накладная выписана на склад другого предприятия (заведена мимо API —
    // скриптом или импортом). Триггер миграции 045 не даёт оприходовать товар
    // на чужой склад; это ошибка данных, а не сбой сервиса.
    if (error.code === '23514' && /tenant_mismatch/.test(String(error.message))) {
      return res.status(400).json({
        error: 'TenantMismatch',
        message: 'Склад накладной принадлежит другому предприятию — приёмка невозможна. Укажите свой склад.'
      });
    }
    console.error('Confirm invoice error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== ВЗАИМОРАСЧЁТЫ ==========

// Баланс и история оплат поставщика
router.get('/:id/balance', authenticateUser, async (req: Request, res: Response) => {
  try {
    const balance = await supplierService.getSupplierBalance(req.params.id, req.enterpriseId);
    if (!balance) return res.status(404).json({ error: 'Supplier not found' });
    return res.json(balance);
  } catch (error) {
    console.error('Supplier balance error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Оплата поставщику (по накладной или погашение долга)
router.post('/:id/payments', authenticateUser, async (req: Request, res: Response) => {
  try {
    const schema = Joi.object({
      amount: Joi.number().positive().required(),
      method: Joi.string().valid('cash', 'transfer', 'card', 'offset').default('transfer'),
      invoiceId: Joi.string().uuid().optional(),
      registerId: Joi.string().uuid().optional(),
      notes: Joi.string().allow('', null)
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const result = await supplierService.paySupplier(req.params.id, value, req.userId, req.enterpriseId);

    // Наличная оплата из кассы — проводим изъятие в finance-service (не фатально при сбое)
    if (value.method === 'cash' && value.registerId) {
      try {
        const resp = await fetch(`${config.financeServiceUrl}/api/finance/registers/${value.registerId}/operations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': req.headers.authorization || '' },
          body: JSON.stringify({
            operationType: 'cash_out',
            amount: value.amount,
            paymentMethod: 'cash',
            description: `Оплата поставщику${result.invoice ? ' по накладной ' + (result.invoice.invoice_number || '') : ''}`
          })
        });
        if (!resp.ok) console.warn('finance cash_out failed:', resp.status);
      } catch (e) {
        console.warn('finance cash_out unreachable', e);
      }
    }

    return res.status(201).json(result);
  } catch (error: any) {
    if (error.message && /not found/i.test(error.message)) return res.status(400).json({ error: error.message });
    console.error('Pay supplier error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
