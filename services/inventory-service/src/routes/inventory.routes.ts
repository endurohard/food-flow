import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { InventoryService } from '../services/inventory.service';
import { authenticateUser, requireRole } from '../middleware/auth.middleware';
import { config } from '../config';

const router = Router();
const inventoryService = new InventoryService(config.database.url);

// ========== INVENTORY ITEMS ==========

router.get('/items', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator'), async (req: Request, res: Response) => {
  try {
    const items = await inventoryService.listItems({
      enterpriseId: req.enterpriseId,
      category: req.query.category as string,
      search: req.query.search as string,
      lowStock: req.query.lowStock === 'true'
    });
    return res.json({ items });
  } catch (error) {
    console.error('List items error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/items/:id', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator'), async (req: Request, res: Response) => {
  try {
    const item = await inventoryService.getItem(req.params.id, req.enterpriseId);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    return res.json({ item });
  } catch (error) {
    console.error('Get item error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/items', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator'), async (req: Request, res: Response) => {
  try {
    const schema = Joi.object({
      name: Joi.string().min(1).max(255).required(),
      sku: Joi.string().max(50).optional(),
      category: Joi.string().max(100).optional(),
      unit: Joi.string().max(20).required(),
      minStock: Joi.number().min(0).optional(),
      maxStock: Joi.number().min(0).optional(),
      costPrice: Joi.number().min(0).optional()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const item = await inventoryService.createItem(value, req.enterpriseId);
    return res.status(201).json({ item });
  } catch (error) {
    console.error('Create item error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/items/:id', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator'), async (req: Request, res: Response) => {
  try {
    const item = await inventoryService.updateItem(req.params.id, req.body, req.enterpriseId);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    return res.json({ item });
  } catch (error) {
    console.error('Update item error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/items/:id', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator'), async (req: Request, res: Response) => {
  try {
    const deleted = await inventoryService.deleteItem(req.params.id, req.enterpriseId);
    if (!deleted) return res.status(404).json({ error: 'Item not found' });
    return res.json({ message: 'Item deactivated' });
  } catch (error) {
    console.error('Delete item error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== WAREHOUSES ==========

router.get('/warehouses', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator'), async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    const restaurantId = req.query.restaurantId as string;
    if (!restaurantId) return res.status(400).json({ error: 'restaurantId is required' });
    const warehouses = await inventoryService.listWarehouses(restaurantId, isSuper ? undefined : req.enterpriseId);
    return res.json({ warehouses });
  } catch (error) {
    console.error('List warehouses error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/warehouses', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator'), async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    const { restaurantId, name, warehouseType } = req.body;
    if (!restaurantId || !name) return res.status(400).json({ error: 'restaurantId and name are required' });
    if (!isSuper && !(await inventoryService.restaurantBelongsTo(restaurantId, req.enterpriseId!))) {
      return res.status(403).json({ error: 'Forbidden', message: 'Ресторан не принадлежит предприятию' });
    }
    const warehouse = await inventoryService.createWarehouse(restaurantId, { name, warehouseType }, req.enterpriseId);
    return res.status(201).json({ warehouse });
  } catch (error) {
    console.error('Create warehouse error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/warehouses/:id', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator'), async (req: Request, res: Response) => {
  try {
    const warehouse = await inventoryService.updateWarehouse(req.params.id, req.body, req.enterpriseId);
    if (!warehouse) return res.status(404).json({ error: 'Warehouse not found' });
    return res.json({ warehouse });
  } catch (error) {
    console.error('Update warehouse error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== STOCK ==========

router.get('/stock/:warehouseId', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator'), async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    const stock = await inventoryService.getStock(req.params.warehouseId, isSuper ? undefined : req.enterpriseId);
    return res.json({ stock });
  } catch (error) {
    console.error('Get stock error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== STOCK MOVEMENTS ==========

router.post('/movements', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator'), async (req: Request, res: Response) => {
  try {
    const schema = Joi.object({
      warehouseId: Joi.string().uuid().required(),
      inventoryItemId: Joi.string().uuid().required(),
      movementType: Joi.string().valid('receipt', 'write_off', 'transfer', 'sale', 'adjustment_plus', 'adjustment_minus', 'return').required(),
      quantity: Joi.number().positive().required(),
      costPrice: Joi.number().min(0).optional(),
      referenceType: Joi.string().optional(),
      referenceId: Joi.string().uuid().optional(),
      notes: Joi.string().optional(),
      batchNumber: Joi.string().max(100).optional(),
      expiryDate: Joi.string().isoDate().optional(),
      supplierId: Joi.string().uuid().optional(),
      invoiceId: Joi.string().uuid().optional()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    if (!isSuper) {
      const [wOk, iOk] = await Promise.all([
        inventoryService.warehouseBelongsTo(value.warehouseId, req.enterpriseId!),
        inventoryService.itemBelongsTo(value.inventoryItemId, req.enterpriseId!)
      ]);
      if (!wOk || !iOk) {
        return res.status(403).json({ error: 'Forbidden', message: 'Склад или позиция не принадлежат предприятию' });
      }
    }

    const movement = await inventoryService.addStockMovement({
      ...value,
      performedBy: req.userId,
      enterpriseId: req.enterpriseId
    });
    return res.status(201).json({ movement });
  } catch (error) {
    console.error('Create movement error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/movements', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator'), async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    const movements = await inventoryService.getMovements({
      enterpriseId: isSuper ? undefined : req.enterpriseId,
      warehouseId: req.query.warehouseId as string,
      inventoryItemId: req.query.inventoryItemId as string,
      movementType: req.query.movementType as string,
      limit: parseInt(req.query.limit as string) || 100,
      offset: parseInt(req.query.offset as string) || 0
    });
    return res.json({ movements });
  } catch (error) {
    console.error('Get movements error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== BATCH TRACKING (FIFO) ==========

router.get('/batches', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator'), async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    const batches = await inventoryService.listBatches({
      enterpriseId: isSuper ? undefined : req.enterpriseId,
      inventoryItemId: req.query.inventoryItemId as string,
      warehouseId: req.query.warehouseId as string,
      includeExpired: req.query.includeExpired === 'true',
      includeDepleted: req.query.includeDepleted === 'true'
    });
    return res.json({ batches });
  } catch (error) {
    console.error('List batches error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/expiring', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator'), async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    const warehouseId = req.query.warehouseId as string;
    if (!warehouseId) return res.status(400).json({ error: 'warehouseId is required' });
    const days = req.query.days ? parseInt(req.query.days as string, 10) : undefined;
    const items = await inventoryService.getExpiringItems(warehouseId, days, isSuper ? undefined : req.enterpriseId);
    return res.json({ items });
  } catch (error) {
    console.error('Get expiring items error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
