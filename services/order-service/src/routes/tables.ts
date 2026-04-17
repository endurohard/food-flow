import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { TableService } from '../services/table.service';
import { authenticateUser, requireRole } from '../middleware/auth.middleware';
import { config } from '../config';

const router = Router();
const tableService = new TableService(config.database.url);

const createTableSchema = Joi.object({
  tableNumber: Joi.string().min(1).max(20).required(),
  section: Joi.string().max(50).optional(),
  seats: Joi.number().integer().min(1).optional(),
  posX: Joi.number().integer().optional(),
  posY: Joi.number().integer().optional(),
  width: Joi.number().integer().min(10).optional(),
  height: Joi.number().integer().min(10).optional(),
  shape: Joi.string().valid('rectangle', 'circle', 'square').optional()
});

/**
 * GET /api/tables?restaurantId=
 */
router.get('/', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator', 'waiter'), async (req: Request, res: Response) => {
  try {
    const restaurantId = req.query.restaurantId as string;
    if (!restaurantId) {
      return res.status(400).json({ error: 'restaurantId query parameter is required' });
    }

    const tables = await tableService.list(restaurantId);
    return res.json({ tables });
  } catch (error) {
    console.error('Failed to get tables:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/tables
 */
router.post('/', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const restaurantId = req.body.restaurantId;
    if (!restaurantId) {
      return res.status(400).json({ error: 'restaurantId is required' });
    }

    const { error, value } = createTableSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: 'Validation error', message: error.details[0].message });
    }

    const table = await tableService.create(restaurantId, value, req.enterpriseId);
    return res.status(201).json({ table });
  } catch (error) {
    console.error('Failed to create table:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/tables/:id
 */
router.put('/:id', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator', 'waiter'), async (req: Request, res: Response) => {
  try {
    const table = await tableService.update(req.params.id, req.body);
    if (!table) {
      return res.status(404).json({ error: 'Table not found' });
    }
    return res.json({ table });
  } catch (error) {
    console.error('Failed to update table:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/tables/:id
 */
router.delete('/:id', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const deleted = await tableService.delete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Table not found' });
    }
    return res.json({ message: 'Table deleted' });
  } catch (error) {
    console.error('Failed to delete table:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
