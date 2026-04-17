import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { RestaurantService } from '../services/restaurant.service';
import { authenticateUser, optionalAuth, requireRole } from '../middleware/auth.middleware';
import { config } from '../config';

const router = Router();
const restaurantService = new RestaurantService(config.database.url);

const createSchema = Joi.object({
  name: Joi.string().min(1).max(255).required(),
  description: Joi.string().max(2000).optional(),
  phone: Joi.string().max(20).optional(),
  email: Joi.string().email().optional(),
  cuisineType: Joi.array().items(Joi.string()).optional(),
  opensAt: Joi.string().optional(),
  closesAt: Joi.string().optional(),
  deliveryFee: Joi.number().min(0).optional(),
  minimumOrder: Joi.number().min(0).optional(),
  estimatedDeliveryTime: Joi.number().integer().min(1).optional()
});

/**
 * @swagger
 * /api/restaurants:
 *   get:
 *     summary: List restaurants
 *     tags: [Restaurants]
 *     parameters:
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: cuisineType
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Restaurant list
 */
router.get('/', optionalAuth, async (req: Request, res: Response) => {
  try {
    const result = await restaurantService.list({
      enterpriseId: req.enterpriseId,
      isActive: true,
      cuisineType: req.query.cuisineType as string,
      search: req.query.search as string,
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0
    });

    return res.json(result);
  } catch (error) {
    console.error('List restaurants error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/restaurants/{id}:
 *   get:
 *     summary: Get restaurant details
 *     tags: [Restaurants]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Restaurant details
 *       404:
 *         description: Not found
 */
router.get('/:id', optionalAuth, async (req: Request, res: Response) => {
  try {
    const restaurant = await restaurantService.getById(req.params.id, req.enterpriseId);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }
    return res.json({ restaurant });
  } catch (error) {
    console.error('Get restaurant error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/restaurants:
 *   post:
 *     summary: Create restaurant
 *     tags: [Restaurants]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Restaurant created
 */
router.post('/', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const { error, value } = createSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: 'Validation error', message: error.details[0].message });
    }

    const restaurant = await restaurantService.create(req.userId!, value, req.enterpriseId);
    return res.status(201).json({ restaurant });
  } catch (error) {
    console.error('Create restaurant error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/restaurants/{id}:
 *   put:
 *     summary: Update restaurant
 *     tags: [Restaurants]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Restaurant updated
 */
router.put('/:id', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const restaurant = await restaurantService.update(req.params.id, req.body, req.enterpriseId);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }
    return res.json({ restaurant });
  } catch (error) {
    console.error('Update restaurant error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/restaurants/{id}:
 *   delete:
 *     summary: Deactivate restaurant
 *     tags: [Restaurants]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Restaurant deactivated
 */
router.delete('/:id', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const deleted = await restaurantService.delete(req.params.id, req.enterpriseId);
    if (!deleted) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }
    return res.json({ message: 'Restaurant deactivated' });
  } catch (error) {
    console.error('Delete restaurant error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
