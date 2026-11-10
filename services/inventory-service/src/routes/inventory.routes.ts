import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { InventoryService } from '../services/inventory.service';
import { authenticateUser, authenticateInternal, requireRole } from '../middleware/auth.middleware';
import { config } from '../config';
import { stockAlerts, checkStockLater } from '../services/stock-alerts.instance';

const router = Router();
const inventoryService = new InventoryService(config.database.url);

// ========== «ПОРА ЗАКАЗАТЬ» ==========
// Колокольчик в админке: позиции, у которых остаток на складе дошёл до минимума

const STOCK_ALERT_ROLES = ['admin', 'owner', 'manager', 'operator'];

// Видят руководящие роли и ответственные за закуп (enterprise_users.is_purchaser)
// с любой ролью: предупреждение адресовано в первую очередь закупщику.
router.get('/stock-alerts', authenticateUser, async (req: Request, res: Response) => {
  try {
    if (!req.enterpriseId) return res.json({ alerts: [] });
    const byRole = ['admin', 'restaurant_owner'].includes(req.userRole || '')
      || STOCK_ALERT_ROLES.includes(req.enterpriseRole || '') || STOCK_ALERT_ROLES.includes(req.userRole || '');
    if (!byRole && !(req.userId && await stockAlerts.isPurchaser(req.enterpriseId, req.userId))) {
      return res.status(403).json({ error: 'Forbidden', message: 'Insufficient role' });
    }
    return res.json({ alerts: await stockAlerts.listOpen(req.enterpriseId) });
  } catch (error) {
    console.error('List stock alerts error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

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
    // Без restaurantId отдаём все склады предприятия, а не 400: экран склада
    // грузит список, не выбирая точку, и получал «restaurantId is required» —
    // приход и списание выглядели недоступными при существующих складах.
    // super_admin обязан указать точку: без тенанта отбирать нечем.
    if (!restaurantId) {
      if (isSuper) return res.status(400).json({ error: 'restaurantId is required' });
      const warehouses = await inventoryService.listWarehousesByEnterprise(req.enterpriseId!);
      return res.json({ warehouses });
    }
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
      // «Перемещение» — отдельным запросом POST /transfers: отсюда оно только
      // уменьшало бы остаток, и товар пропадал бы, не дойдя до второго склада
      movementType: Joi.string().valid('receipt', 'write_off', 'sale', 'adjustment_plus', 'adjustment_minus', 'return')
        .required().messages({ 'any.only': 'Тип движения: приход, списание или корректировка. Перемещение — через «Перемещение между складами»' }),
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
    if (error) return res.status(400).json({ error: error.details[0].message, message: error.details[0].message });

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
    checkStockLater(value.warehouseId, [value.inventoryItemId]);
    return res.status(201).json({ movement });
  } catch (error) {
    console.error('Create movement error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Возврат на склад по возврату чека (вызывает order-service, internal-token)
router.post('/return-by-order', authenticateInternal, requireRole('admin', 'owner'), async (req: Request, res: Response) => {
  try {
    const { error, value } = Joi.object({
      orderId: Joi.string().uuid().required(),
      refundId: Joi.string().uuid().required(),
      enterpriseId: Joi.string().uuid().optional(),
      performedBy: Joi.string().uuid().optional(),
      items: Joi.array().items(Joi.object({
        orderItemId: Joi.string().uuid().required(),
        quantity: Joi.number().positive().required()
      })).min(1).required()
    }).validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    const enterpriseId = req.isInternal ? value.enterpriseId : req.enterpriseId;
    if (!enterpriseId) return res.status(400).json({ error: 'enterpriseId required' });
    const r = await inventoryService.returnByOrder({ ...value, enterpriseId });
    const whs = await inventoryService.warehousesOfOrder(value.orderId);
    for (const w of whs) checkStockLater(w.warehouse_id, w.items);
    return res.json(r);
  } catch (e: any) {
    if (e.message === 'ORDER_NOT_FOUND') return res.status(404).json({ error: 'Заказ не найден' });
    console.error('Return by order error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Перемещение между складами своего предприятия
router.post('/transfers', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator'), async (req: Request, res: Response) => {
  try {
    const { error, value } = Joi.object({
      fromWarehouseId: Joi.string().uuid().required(),
      toWarehouseId: Joi.string().uuid().required(),
      inventoryItemId: Joi.string().uuid().required(),
      quantity: Joi.number().positive().required(),
      notes: Joi.string().max(500).allow('').optional()
    }).validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message, message: error.details[0].message });
    if (!req.enterpriseId) return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    if (!(await inventoryService.itemBelongsTo(value.inventoryItemId, req.enterpriseId))) {
      return res.status(403).json({ error: 'Forbidden', message: 'Позиция не принадлежит предприятию' });
    }
    const r = await inventoryService.transfer({ ...value, performedBy: req.userId, enterpriseId: req.enterpriseId });
    checkStockLater(value.fromWarehouseId, [value.inventoryItemId]);
    checkStockLater(value.toWarehouseId, [value.inventoryItemId]);
    return res.status(201).json(r);
  } catch (e: any) {
    const m = String(e.message || '');
    if (m === 'TRANSFER_SAME_WAREHOUSE') return res.status(400).json({ error: m, message: 'Склады отправки и получения совпадают' });
    if (m === 'TRANSFER_WAREHOUSE_NOT_FOUND') return res.status(403).json({ error: m, message: 'Склад не найден в вашем предприятии' });
    if (m.startsWith('TRANSFER_INSUFFICIENT')) {
      return res.status(409).json({ error: 'TRANSFER_INSUFFICIENT', message: `На складе отправки только ${parseFloat(m.split(':')[1]) || 0} — переместить больше нельзя` });
    }
    console.error('Transfer error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

const MOVEMENT_TYPE_RE = /^[a-z_]{2,40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Разбор фильтров журнала движений из query. Ошибка — текстом для 400. */
export function parseMovementQuery(q: Record<string, unknown>):
  { filters: import('../services/inventory.service').MovementFilters } | { error: string } {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
  const date = (v: unknown, name: string) => {
    const s = str(v);
    if (s === undefined) return { ok: true as const, value: undefined };
    const d = new Date(s);
    return isNaN(d.getTime()) ? { ok: false as const, error: `${name}: неверная дата` } : { ok: true as const, value: d.toISOString() };
  };
  const from = date(q.dateFrom, 'dateFrom'); if (!from.ok) return { error: from.error };
  const to = date(q.dateTo, 'dateTo'); if (!to.ok) return { error: to.error };
  const typesRaw = str(q.movementType);
  const movementTypes = typesRaw ? typesRaw.split(',').map((t) => t.trim()).filter(Boolean) : [];
  if (movementTypes.some((t) => !MOVEMENT_TYPE_RE.test(t))) return { error: 'movementType: неверный тип' };
  const warehouseId = str(q.warehouseId), inventoryItemId = str(q.inventoryItemId);
  if (warehouseId && !UUID_RE.test(warehouseId)) return { error: 'warehouseId: неверный id' };
  if (inventoryItemId && !UUID_RE.test(inventoryItemId)) return { error: 'inventoryItemId: неверный id' };
  const limit = Math.min(Math.max(parseInt(String(q.limit ?? ''), 10) || 100, 1), 1000);
  const offset = Math.max(parseInt(String(q.offset ?? ''), 10) || 0, 0);
  const search = str(q.search);
  return { filters: {
    warehouseId, inventoryItemId, movementTypes, dateFrom: from.value, dateTo: to.value,
    search: search ? search.slice(0, 100) : undefined, limit, offset
  } };
}

router.get('/movements', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator'), async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    const parsed = parseMovementQuery(req.query as Record<string, unknown>);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error, message: parsed.error });
    const filters = { ...parsed.filters, enterpriseId: isSuper ? undefined : req.enterpriseId };
    // total — только по просьбе (?withTotal=1): старые вызовы получают прежний ответ
    const [movements, total] = await Promise.all([
      inventoryService.getMovements(filters),
      req.query.withTotal ? inventoryService.countMovements(filters) : Promise.resolve(undefined)
    ]);
    return res.json(total === undefined ? { movements } : { movements, total });
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

// Списание ингредиентов по техкартам при продаже блюда.
// Вызывается order-service при закрытии заказа (internal-token) либо
// вручную менеджером. Идемпотентно по orderId.
router.post('/deduct-by-order', authenticateInternal, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const schema = Joi.object({
      orderId: Joi.string().uuid().required(),
      warehouseId: Joi.string().uuid().required(),
      // При internal-вызове тенант приходит в теле: JWT пользователя нет
      enterpriseId: Joi.string().uuid().optional(),
      performedBy: Joi.string().uuid().optional()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const isSuper = req.userRole === 'super_admin';
    const enterpriseId = req.isInternal
      ? value.enterpriseId
      : (isSuper ? undefined : req.enterpriseId);
    if (!req.isInternal && !isSuper && !enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }

    const result = await inventoryService.deductByTechCards(
      value.orderId,
      value.warehouseId,
      value.performedBy || req.userId,
      enterpriseId
    );
    checkStockLater(value.warehouseId, result.deducted.map((d) => d.inventoryItemId));
    return res.json(result);
  } catch (error: any) {
    if (error.message && (error.message.includes('Недостаточно') ||
        error.message.includes('Insufficient') || error.message.includes('not found') ||
        error.message.includes('enterpriseId'))) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Deduct by tech cards error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
