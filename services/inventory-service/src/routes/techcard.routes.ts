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
    const techCard = await techCardService.getById(req.params.id);
    if (!techCard) return res.status(404).json({ error: 'Tech card not found' });
    return res.json({ techCard });
  } catch (error) {
    console.error('Get tech card error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id/cost', authenticateUser, async (req: Request, res: Response) => {
  try {
    const cost = await techCardService.getCostCalculation(req.params.id);
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
      menuItemId: Joi.string().uuid().required(),
      yieldWeight: Joi.number().min(0).optional(),
      cookingInstructions: Joi.string().optional(),
      ingredients: Joi.array().items(Joi.object({
        inventoryItemId: Joi.string().uuid().required(),
        quantity: Joi.number().positive().required(),
        unit: Joi.string().max(20).optional(),
        wastePercent: Joi.number().min(0).max(100).optional(),
        isOptional: Joi.boolean().optional()
      })).optional()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const techCard = await techCardService.create(value, req.enterpriseId);
    return res.status(201).json({ techCard });
  } catch (error) {
    console.error('Create tech card error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const techCard = await techCardService.update(req.params.id, req.body);
    if (!techCard) return res.status(404).json({ error: 'Tech card not found' });
    return res.json({ techCard });
  } catch (error) {
    console.error('Update tech card error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const deleted = await techCardService.delete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Tech card not found' });
    return res.json({ message: 'Tech card deactivated' });
  } catch (error) {
    console.error('Delete tech card error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
