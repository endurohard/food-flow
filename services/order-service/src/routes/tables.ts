import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { TableService, TableError } from '../services/table.service';
import { authenticateUser, requireRole } from '../middleware/auth.middleware';
import { config } from '../config';

const router = Router();
const tableService = new TableService(config.database.url);

// Номер стола храним строкой (бывает «12», «Б-3»), но форма шлёт число —
// принимаем оба вида и приводим к строке, иначе Joi.string() отвергал «3».
const tableNumberSchema = Joi.alternatives()
  .try(Joi.string().trim().min(1).max(20), Joi.number().integer().min(1).max(99999))
  .custom((v) => String(v));

const createTableSchema = Joi.object({
  // restaurantId приходит в том же теле: без него в схеме каждый POST
  // отвергался «"restaurantId" is not allowed», и стол не создавался никогда.
  restaurantId: Joi.string().uuid().required(),
  tableNumber: tableNumberSchema.required(),
  section: Joi.string().max(50).allow(null, '').optional(),
  seats: Joi.number().integer().min(1).max(100).optional(),
  posX: Joi.number().integer().optional(),
  posY: Joi.number().integer().optional(),
  width: Joi.number().integer().min(10).optional(),
  height: Joi.number().integer().min(10).optional(),
  shape: Joi.string().valid('rectangle', 'circle', 'square').optional()
});

const updateTableSchema = Joi.object({
  tableNumber: tableNumberSchema.optional(),
  section: Joi.string().max(50).allow(null, '').optional(),
  seats: Joi.number().integer().min(1).max(100).optional(),
  status: Joi.string().valid('free', 'occupied', 'reserved').optional(),
  posX: Joi.number().integer().optional(),
  posY: Joi.number().integer().optional(),
  width: Joi.number().integer().min(10).optional(),
  height: Joi.number().integer().min(10).optional(),
  shape: Joi.string().valid('rectangle', 'circle', 'square').optional()
}).min(1);

export { createTableSchema, updateTableSchema };

function sendError(res: Response, error: unknown, what: string) {
  if (error instanceof TableError) {
    return res.status(error.status).json({ error: error.message, message: error.message });
  }
  console.error(`Failed to ${what} table:`, error);
  return res.status(500).json({ error: 'Internal server error' });
}

/**
 * GET /api/tables?restaurantId=
 */
router.get('/', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator', 'waiter'), async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }

    const restaurantId = req.query.restaurantId as string;
    if (!restaurantId) {
      return res.status(400).json({ error: 'restaurantId query parameter is required' });
    }

    const tables = await tableService.list(restaurantId, req.enterpriseId);
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
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }

    const { error, value } = createTableSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: 'Validation error', message: error.details[0].message });
    }

    const { restaurantId, ...data } = value;
    const table = await tableService.create(restaurantId, data, req.enterpriseId);
    return res.status(201).json({ table });
  } catch (error) {
    return sendError(res, error, 'create');
  }
});

/**
 * PUT /api/tables/:id
 */
router.put('/:id', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator', 'waiter'), async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }

    const { error, value } = updateTableSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: 'Validation error', message: error.details[0].message });
    }

    const table = await tableService.update(req.params.id, value, req.enterpriseId);
    if (!table) {
      return res.status(404).json({ error: 'Table not found' });
    }
    return res.json({ table });
  } catch (error) {
    return sendError(res, error, 'update');
  }
});

/**
 * DELETE /api/tables/:id
 */
router.delete('/:id', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }

    const deleted = await tableService.delete(req.params.id, req.enterpriseId);
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
