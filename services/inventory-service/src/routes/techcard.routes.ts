import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { TechCardService } from '../services/techcard.service';
import { authenticateUser } from '../middleware/auth.middleware';
import { config } from '../config';

const router = Router();
const techCardService = new TechCardService(config.database.url);

router.get('/', authenticateUser, async (req: Request, res: Response) => {
  try {
    const techCards = await techCardService.list(req.enterpriseId);
    return res.json({ techCards });
  } catch (error) {
    console.error('List tech cards error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    const techCard = await techCardService.getById(req.params.id, isSuper ? undefined : req.enterpriseId);
    if (!techCard) return res.status(404).json({ error: 'Tech card not found' });
    return res.json({ techCard });
  } catch (error) {
    console.error('Get tech card error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id/cost', authenticateUser, async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    const cost = await techCardService.getCostCalculation(req.params.id, isSuper ? undefined : req.enterpriseId);
    if (!cost) return res.status(404).json({ error: 'Tech card not found' });
    return res.json({ cost });
  } catch (error) {
    console.error('Get cost error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', authenticateUser, async (req: Request, res: Response) => {
  try {
    const schema = Joi.object({
      menuItemId: Joi.string().uuid().optional(),
      name: Joi.string().max(255).optional(),
      outputItemId: Joi.string().uuid().optional(),
      outputQuantity: Joi.number().positive().optional(),
      // Срок действия версии. Без даты карта действует с сегодня бессрочно.
      effectiveFrom: Joi.string().isoDate().optional(),
      effectiveTo: Joi.string().isoDate().allow(null).optional(),
      yieldWeight: Joi.number().min(0).optional(),
      cookingInstructions: Joi.string().optional(),
      ingredients: Joi.array().items(Joi.object({
        inventoryItemId: Joi.string().uuid().required(),
        quantity: Joi.number().positive().required(),
        unit: Joi.string().max(20).optional(),
        // Потери холодной обработки (чистка, разделка) — % от брутто,
        // горячей (варка, жарка) — % от нетто. 100% запрещено: ингредиент
        // не может исчезнуть полностью.
        coldLossPercent: Joi.number().min(0).max(99.99).optional(),
        hotLossPercent: Joi.number().min(0).max(99.99).optional(),
        isOptional: Joi.boolean().optional()
      })).optional()
    }).or('menuItemId', 'outputItemId');
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const techCard = await techCardService.create(value, req.enterpriseId);
    return res.status(201).json({ techCard });
  } catch (error: any) {
    // Цикл в составе — ошибка пользователя, а не сервера
    if (error.message && (error.message.includes('Циклическая') || error.message.includes('сам себя'))) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Create tech card error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    const techCard = await techCardService.update(req.params.id, req.body, isSuper ? undefined : req.enterpriseId);
    if (!techCard) return res.status(404).json({ error: 'Tech card not found' });
    return res.json({ techCard });
  } catch (error: any) {
    if (error.message && (error.message.includes('Циклическая') || error.message.includes('сам себя'))) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Update tech card error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Новая версия техкарты с указанной даты.
 * Прежняя закрывается автоматически днём раньше.
 */
router.post('/:id/versions', authenticateUser, async (req: Request, res: Response) => {
  try {
    const schema = Joi.object({
      effectiveFrom: Joi.string().isoDate().required(),
      name: Joi.string().max(255).optional(),
      yieldWeight: Joi.number().min(0).optional(),
      cookingInstructions: Joi.string().optional(),
      ingredients: Joi.array().items(Joi.object({
        inventoryItemId: Joi.string().uuid().required(),
        quantity: Joi.number().positive().required(),
        unit: Joi.string().max(20).optional(),
        coldLossPercent: Joi.number().min(0).max(99.99).optional(),
        hotLossPercent: Joi.number().min(0).max(99.99).optional(),
        isOptional: Joi.boolean().optional()
      })).optional()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: 'Validation error', message: error.details[0].message });

    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    const card = await techCardService.createVersion(req.params.id, value, isSuper ? undefined : req.enterpriseId);
    if (!card) return res.status(404).json({ error: 'Tech card not found' });
    return res.status(201).json({ techCard: card });
  } catch (error: any) {
    // Пересечение периодов ловит EXCLUDE в БД — это ошибка ввода, не сбой
    if (error.code === '23P01') {
      return res.status(409).json({ error: 'На эту дату уже действует другая версия техкарты' });
    }
    if (error.message && error.message.includes('позже начала')) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Create tech card version error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** История версий техкарты блюда. */
router.get('/menu-item/:menuItemId/versions', authenticateUser, async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    const versions = await techCardService.getVersions(req.params.menuItemId, isSuper ? undefined : req.enterpriseId);
    return res.json({ versions });
  } catch (error) {
    console.error('Get tech card versions error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    const deleted = await techCardService.delete(req.params.id, isSuper ? undefined : req.enterpriseId);
    if (!deleted) return res.status(404).json({ error: 'Tech card not found' });
    return res.json({ message: 'Tech card deactivated' });
  } catch (error) {
    console.error('Delete tech card error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
