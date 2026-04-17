import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { config } from '../config';
import { authenticateUser, requireRole } from '../middleware/auth.middleware';
import { StationService } from '../services/station.service';
import { logger } from '../utils/logger';

const router = Router();
router.use(authenticateUser);
router.use(requireRole('admin', 'owner', 'manager', 'operator', 'chef'));

const stationService = new StationService(config.database.url);

// ─── Validation schemas ────────────────────────────────────────

const createStationSchema = Joi.object({
  restaurantId: Joi.string().uuid().required(),
  name: Joi.string().max(100).required(),
  stationType: Joi.string().max(50).optional(),
  displayOrder: Joi.number().integer().min(0).optional(),
});

const updateStationSchema = Joi.object({
  name: Joi.string().max(100).optional(),
  stationType: Joi.string().max(50).optional(),
  displayOrder: Joi.number().integer().min(0).optional(),
  isActive: Joi.boolean().optional(),
}).min(1);

const assignItemSchema = Joi.object({
  menuItemId: Joi.string().uuid().required(),
  preparationOrder: Joi.number().integer().min(1).optional(),
});

const updateStatusSchema = Joi.object({
  status: Joi.string().valid('pending', 'in_progress', 'done', 'recalled').required(),
});

// ─── STATION CRUD ──────────────────────────────────────────────

/**
 * @swagger
 * /api/stations:
 *   get:
 *     summary: List kitchen stations for a restaurant
 *     tags: [Stations]
 *     parameters:
 *       - in: query
 *         name: restaurantId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of stations
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { restaurantId } = req.query;
    if (!restaurantId) {
      return res.status(400).json({ error: 'restaurantId query parameter is required' });
    }

    const stations = await stationService.listStations(
      restaurantId as string,
      req.enterpriseId,
    );
    res.json(stations);
  } catch (error) {
    logger.error('Error listing stations:', error);
    res.status(500).json({ error: 'Failed to list stations' });
  }
});

/**
 * @swagger
 * /api/stations:
 *   post:
 *     summary: Create a kitchen station
 *     tags: [Stations]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [restaurantId, name]
 *             properties:
 *               restaurantId:
 *                 type: string
 *               name:
 *                 type: string
 *               stationType:
 *                 type: string
 *               displayOrder:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Station created
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { error, value } = createStationSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const station = await stationService.createStation({
      ...value,
      enterpriseId: req.enterpriseId,
    });
    res.status(201).json(station);
  } catch (error) {
    logger.error('Error creating station:', error);
    res.status(500).json({ error: 'Failed to create station' });
  }
});

/**
 * @swagger
 * /api/stations/{id}:
 *   put:
 *     summary: Update a kitchen station
 *     tags: [Stations]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Station updated
 */
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { error, value } = updateStationSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const station = await stationService.updateStation(req.params.id, value, req.enterpriseId);
    if (!station) {
      return res.status(404).json({ error: 'Station not found or access denied' });
    }
    res.json(station);
  } catch (error) {
    logger.error('Error updating station:', error);
    res.status(500).json({ error: 'Failed to update station' });
  }
});

/**
 * @swagger
 * /api/stations/{id}:
 *   delete:
 *     summary: Delete a kitchen station
 *     tags: [Stations]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Station deleted
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const deleted = await stationService.deleteStation(req.params.id, req.enterpriseId);
    if (!deleted) {
      return res.status(404).json({ error: 'Station not found or access denied' });
    }
    res.json({ message: 'Station deleted' });
  } catch (error) {
    logger.error('Error deleting station:', error);
    res.status(500).json({ error: 'Failed to delete station' });
  }
});

// ─── MENU-ITEM ↔ STATION ASSIGNMENTS ──────────────────────────

/**
 * @swagger
 * /api/stations/{stationId}/items:
 *   post:
 *     summary: Assign a menu item to a station
 *     tags: [Stations]
 *     parameters:
 *       - in: path
 *         name: stationId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [menuItemId]
 *             properties:
 *               menuItemId:
 *                 type: string
 *               preparationOrder:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Item assigned to station
 */
router.post('/:stationId/items', async (req: Request, res: Response) => {
  try {
    const { error, value } = assignItemSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const assignment = await stationService.assignItemToStation(
      value.menuItemId,
      req.params.stationId,
      value.preparationOrder,
    );
    res.status(201).json(assignment);
  } catch (error) {
    logger.error('Error assigning item to station:', error);
    res.status(500).json({ error: 'Failed to assign item to station' });
  }
});

/**
 * @swagger
 * /api/stations/{stationId}/items/{menuItemId}:
 *   delete:
 *     summary: Remove a menu item from a station
 *     tags: [Stations]
 *     parameters:
 *       - in: path
 *         name: stationId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: menuItemId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Item removed from station
 */
router.delete('/:stationId/items/:menuItemId', async (req: Request, res: Response) => {
  try {
    const removed = await stationService.removeItemFromStation(
      req.params.menuItemId,
      req.params.stationId,
    );
    if (!removed) {
      return res.status(404).json({ error: 'Assignment not found' });
    }
    res.json({ message: 'Item removed from station' });
  } catch (error) {
    logger.error('Error removing item from station:', error);
    res.status(500).json({ error: 'Failed to remove item from station' });
  }
});

// ─── STATION-SPECIFIC KDS VIEW ────────────────────────────────

/**
 * @swagger
 * /api/stations/{stationId}/orders:
 *   get:
 *     summary: Get orders filtered by station (station-specific KDS view)
 *     tags: [Stations]
 *     parameters:
 *       - in: path
 *         name: stationId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Station orders
 */
router.get('/:stationId/orders', async (req: Request, res: Response) => {
  try {
    const orders = await stationService.getStationOrders(
      req.params.stationId,
      req.enterpriseId,
    );
    res.json(orders);
  } catch (error) {
    logger.error('Error fetching station orders:', error);
    res.status(500).json({ error: 'Failed to fetch station orders' });
  }
});

// ─── UPDATE ITEM STATUS AT A STATION ──────────────────────────

/**
 * @swagger
 * /api/stations/{stationId}/items/{orderItemId}/status:
 *   put:
 *     summary: Update order-item status at a station
 *     tags: [Stations]
 *     parameters:
 *       - in: path
 *         name: stationId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: orderItemId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [pending, in_progress, done, recalled]
 *     responses:
 *       200:
 *         description: Status updated
 */
router.put('/:stationId/items/:orderItemId/status', async (req: Request, res: Response) => {
  try {
    const { error, value } = updateStatusSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const result = await stationService.updateItemStationStatus(
      req.params.orderItemId,
      req.params.stationId,
      value.status,
      req.userId,
    );
    res.json(result);
  } catch (error) {
    logger.error('Error updating item station status:', error);
    res.status(500).json({ error: 'Failed to update item station status' });
  }
});

export default router;
