import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { DiscountService } from '../services/discount.service';
import { authenticateUser, requireRole } from '../middleware/auth.middleware';
import { config } from '../config';

const router = Router();
const discountService = new DiscountService(config.database.url);

const createDiscountSchema = Joi.object({
  restaurantId: Joi.string().uuid().allow(null).optional(),
  name: Joi.string().min(1).max(255).required(),
  discountType: Joi.string().valid('percentage', 'fixed_amount', 'bogo', 'combo').required(),
  value: Joi.number().positive().required(),
  minOrderAmount: Joi.number().min(0).optional(),
  maxDiscount: Joi.number().positive().allow(null).optional(),
  applicableTo: Joi.string().valid('order', 'item', 'category').optional(),
  targetId: Joi.string().uuid().allow(null).optional(),
  validFrom: Joi.string().isoDate().allow(null).optional(),
  validUntil: Joi.string().isoDate().allow(null).optional()
});

const updateDiscountSchema = Joi.object({
  restaurantId: Joi.string().uuid().allow(null).optional(),
  name: Joi.string().min(1).max(255).optional(),
  discountType: Joi.string().valid('percentage', 'fixed_amount', 'bogo', 'combo').optional(),
  value: Joi.number().positive().optional(),
  minOrderAmount: Joi.number().min(0).optional(),
  maxDiscount: Joi.number().positive().allow(null).optional(),
  applicableTo: Joi.string().valid('order', 'item', 'category').optional(),
  targetId: Joi.string().uuid().allow(null).optional(),
  validFrom: Joi.string().isoDate().allow(null).optional(),
  validUntil: Joi.string().isoDate().allow(null).optional()
}).min(1);

/**
 * GET /api/discounts?restaurantId=X
 * List active discounts for a restaurant.
 */
router.get('/', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const restaurantId = req.query.restaurantId as string;
    if (!restaurantId) {
      return res.status(400).json({ success: false, error: 'restaurantId query parameter is required' });
    }

    const discounts = await discountService.listDiscounts(restaurantId, req.enterpriseId);
    return res.json({ success: true, data: discounts });
  } catch (error) {
    console.error('Failed to list discounts:', error);
    return res.status(500).json({ success: false, error: 'Failed to list discounts' });
  }
});

/**
 * POST /api/discounts
 * Create a new discount rule.
 */
router.post('/', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const { error, value } = createDiscountSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message });
    }

    value.enterpriseId = req.enterpriseId;

    const discount = await discountService.createDiscount(value);
    return res.status(201).json({ success: true, data: discount, message: 'Discount created successfully' });
  } catch (error) {
    console.error('Failed to create discount:', error);
    return res.status(500).json({ success: false, error: 'Failed to create discount' });
  }
});

/**
 * PUT /api/discounts/:id
 * Update an existing discount.
 */
router.put('/:id', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }

    const { error, value } = updateDiscountSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message });
    }

    const discount = await discountService.updateDiscount(req.params.id, value, req.enterpriseId);
    if (!discount) {
      return res.status(404).json({ success: false, error: 'Discount not found or no fields to update' });
    }

    return res.json({ success: true, data: discount });
  } catch (error) {
    console.error('Failed to update discount:', error);
    return res.status(500).json({ success: false, error: 'Failed to update discount' });
  }
});

/**
 * DELETE /api/discounts/:id
 * Soft-delete (deactivate) a discount.
 */
router.delete('/:id', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }

    const deactivated = await discountService.deactivateDiscount(req.params.id, req.enterpriseId);
    if (!deactivated) {
      return res.status(404).json({ success: false, error: 'Discount not found or already inactive' });
    }

    return res.json({ success: true, message: 'Discount deactivated' });
  } catch (error) {
    console.error('Failed to deactivate discount:', error);
    return res.status(500).json({ success: false, error: 'Failed to deactivate discount' });
  }
});

export default router;
