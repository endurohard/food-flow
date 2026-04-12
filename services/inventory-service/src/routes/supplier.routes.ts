import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { SupplierService } from '../services/supplier.service';
import { InventoryService } from '../services/inventory.service';
import { authenticateUser } from '../middleware/auth.middleware';
import { config } from '../config';

const router = Router();
const supplierService = new SupplierService(config.database.url);
const inventoryService = new InventoryService(config.database.url);

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
    const supplier = await supplierService.update(req.params.id, req.body);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    return res.json({ supplier });
  } catch (error) {
    console.error('Update supplier error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const deleted = await supplierService.delete(req.params.id);
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

router.post('/invoices', authenticateUser, async (req: Request, res: Response) => {
  try {
    const invoice = await supplierService.createInvoice(req.body, req.enterpriseId);
    return res.status(201).json({ invoice });
  } catch (error) {
    console.error('Create invoice error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/invoices/:id/items', authenticateUser, async (req: Request, res: Response) => {
  try {
    const items = await supplierService.getInvoiceItems(req.params.id);
    return res.json({ items });
  } catch (error) {
    console.error('Get invoice items error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/invoices/:id/items', authenticateUser, async (req: Request, res: Response) => {
  try {
    const item = await supplierService.addInvoiceItem(req.params.id, req.body);
    return res.status(201).json({ item });
  } catch (error) {
    console.error('Add invoice item error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/invoices/:id/confirm', authenticateUser, async (req: Request, res: Response) => {
  try {
    const invoice = await supplierService.confirmInvoice(req.params.id, req.userId!, inventoryService);
    return res.json({ invoice });
  } catch (error) {
    console.error('Confirm invoice error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
