import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { OrderService, OrderError } from '../services/order.service';
import { authenticateUser, optionalAuth } from '../middleware/auth.middleware';
import { idempotencyCheck } from '../middleware/idempotency.middleware';
import { RabbitMQPublisher } from '../services/rabbitmq.service';
import { config } from '../config';

const router = Router();
const rabbitmq = new RabbitMQPublisher();
const orderService = new OrderService(config.database.url, rabbitmq);

// Connect RabbitMQ on startup
rabbitmq.connect().catch(err => console.warn('RabbitMQ not available:', err.message));

const createOrderSchema = Joi.object({
  restaurantId: Joi.string().uuid().required(),
  customerId: Joi.string().uuid().optional(),
  deliveryAddressId: Joi.string().uuid().allow(null).optional(),
  orderType: Joi.string().valid('delivery', 'pickup', 'dine_in').optional(),
  tableId: Joi.string().uuid().allow(null).optional(),
  waiterId: Joi.string().uuid().allow(null).optional(),
  guestsCount: Joi.number().integer().min(1).optional(),
  items: Joi.array().items(Joi.object({
    menuItemId: Joi.string().uuid().required(),
    quantity: Joi.number().integer().min(1).required(),
    specialInstructions: Joi.string().allow('').optional(),
    modifiers: Joi.array().items(Joi.object({
      modifierId: Joi.string().uuid().required(),
      name: Joi.string().required(),
      priceAdjustment: Joi.number().required()
    })).optional()
  })).min(1).required(),
  specialInstructions: Joi.string().allow('').optional(),
  paymentMethod: Joi.string().optional()
});

/**
 * GET /api/orders
 */
router.get('/', authenticateUser, async (req: Request, res: Response) => {
  try {
    const result = await orderService.list({
      enterpriseId: req.enterpriseId,
      restaurantId: req.query.restaurantId as string,
      customerId: req.query.customerId as string || req.userId,
      status: req.query.status as string,
      orderType: req.query.orderType as string,
      dateFrom: req.query.dateFrom as string,
      dateTo: req.query.dateTo as string,
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0
    });

    return res.json({ success: true, ...result });
  } catch (error) {
    console.error('Failed to get orders:', error);
    return res.status(500).json({ success: false, error: 'Failed to get orders' });
  }
});

/**
 * GET /api/orders/:id
 */
router.get('/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const order = await orderService.getById(req.params.id, req.enterpriseId);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    return res.json({ success: true, data: order });
  } catch (error) {
    console.error('Failed to get order:', error);
    return res.status(500).json({ success: false, error: 'Failed to get order' });
  }
});

/**
 * POST /api/orders
 */
router.post('/', optionalAuth, idempotencyCheck, async (req: Request, res: Response) => {
  try {
    const { error, value } = createOrderSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message });
    }

    // Set customerId from JWT if not provided
    if (!value.customerId) {
      value.customerId = req.userId;
    }
    // Propagate tenant from JWT claim
    value.enterpriseId = req.enterpriseId;

    const order = await orderService.create(value);

    return res.status(201).json({
      success: true,
      data: order,
      message: 'Order created successfully'
    });
  } catch (error) {
    if (error instanceof OrderError) {
      return res.status(error.statusCode).json({ success: false, error: error.message });
    }
    console.error('Failed to create order:', error);
    return res.status(500).json({ success: false, error: 'Failed to create order' });
  }
});

/**
 * PUT /api/orders/:id/status
 */
router.put('/:id/status', authenticateUser, async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }

    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ success: false, error: 'Status is required' });
    }

    const order = await orderService.updateStatus(req.params.id, status, req.enterpriseId);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    return res.json({ success: true, data: order });
  } catch (error) {
    if (error instanceof OrderError) {
      return res.status(error.statusCode).json({ success: false, error: error.message });
    }
    console.error('Failed to update order:', error);
    return res.status(500).json({ success: false, error: 'Failed to update order' });
  }
});

/**
 * PUT /api/orders/:id (legacy endpoint for backward compatibility)
 */
router.put('/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }

    const { status } = req.body;
    if (status) {
      const order = await orderService.updateStatus(req.params.id, status, req.enterpriseId);
      if (!order) {
        return res.status(404).json({ success: false, error: 'Order not found' });
      }
      return res.json({ success: true, data: order });
    }

    return res.status(400).json({ success: false, error: 'No update fields provided' });
  } catch (error) {
    if (error instanceof OrderError) {
      return res.status(error.statusCode).json({ success: false, error: error.message });
    }
    console.error('Failed to update order:', error);
    return res.status(500).json({ success: false, error: 'Failed to update order' });
  }
});

/**
 * POST /api/orders/:id/split
 */
router.post('/:id/split', authenticateUser, async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }

    const { itemGroups } = req.body;
    if (!itemGroups || !Array.isArray(itemGroups)) {
      return res.status(400).json({ success: false, error: 'itemGroups array is required' });
    }

    const childOrders = await orderService.splitOrder(req.params.id, itemGroups, req.enterpriseId);

    return res.json({ success: true, data: childOrders });
  } catch (error) {
    if (error instanceof OrderError) {
      return res.status(error.statusCode).json({ success: false, error: error.message });
    }
    console.error('Failed to split order:', error);
    return res.status(500).json({ success: false, error: 'Failed to split order' });
  }
});

/**
 * DELETE /api/orders/:id
 */
router.delete('/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }

    const order = await orderService.updateStatus(req.params.id, 'cancelled', req.enterpriseId);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    return res.json({ success: true, data: order });
  } catch (error) {
    console.error('Failed to cancel order:', error);
    return res.status(500).json({ success: false, error: 'Failed to cancel order' });
  }
});

export default router;
