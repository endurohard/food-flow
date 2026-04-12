import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { MenuService } from '../services/menu.service';
import { authenticateUser, optionalAuth } from '../middleware/auth.middleware';
import { config } from '../config';

const router = Router();
const menuService = new MenuService(config.database.url);

const categorySchema = Joi.object({
  name: Joi.string().min(1).max(100).required(),
  description: Joi.string().max(500).optional(),
  displayOrder: Joi.number().integer().min(0).optional()
});

const menuItemSchema = Joi.object({
  categoryId: Joi.string().uuid().allow(null).optional(),
  name: Joi.string().min(1).max(255).required(),
  description: Joi.string().max(2000).optional(),
  price: Joi.number().min(0).required(),
  imageUrl: Joi.string().uri().allow('', null).optional(),
  isVegetarian: Joi.boolean().optional(),
  isVegan: Joi.boolean().optional(),
  isGlutenFree: Joi.boolean().optional(),
  calories: Joi.number().integer().min(0).optional(),
  preparationTime: Joi.number().integer().min(1).optional(),
  sku: Joi.string().max(50).optional(),
  costPrice: Joi.number().min(0).optional(),
  taxRate: Joi.number().min(0).max(100).optional(),
  unit: Joi.string().max(20).optional(),
  weightGrams: Joi.number().integer().min(0).optional()
});

const modifierSchema = Joi.object({
  name: Joi.string().min(1).max(100).required(),
  modifierGroup: Joi.string().max(100).optional(),
  priceAdjustment: Joi.number().optional(),
  isDefault: Joi.boolean().optional()
});

// ========== FULL MENU ==========

/**
 * @swagger
 * /api/restaurants/{restaurantId}/menu:
 *   get:
 *     summary: Get full menu with categories, items, and modifiers
 *     tags: [Menu]
 *     parameters:
 *       - in: path
 *         name: restaurantId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Full menu structure
 */
router.get('/:restaurantId/menu', async (req: Request, res: Response) => {
  try {
    const menu = await menuService.getFullMenu(req.params.restaurantId);
    return res.json({ menu });
  } catch (error) {
    console.error('Get menu error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== CATEGORIES ==========

router.get('/:restaurantId/menu-categories', async (req: Request, res: Response) => {
  try {
    const categories = await menuService.getCategories(req.params.restaurantId);
    return res.json({ categories });
  } catch (error) {
    console.error('Get categories error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:restaurantId/menu-categories', authenticateUser, async (req: Request, res: Response) => {
  try {
    const { error, value } = categorySchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: 'Validation error', message: error.details[0].message });
    }
    const category = await menuService.createCategory(req.params.restaurantId, value, req.enterpriseId);
    return res.status(201).json({ category });
  } catch (error) {
    console.error('Create category error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/menu-categories/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const category = await menuService.updateCategory(req.params.id, req.body);
    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }
    return res.json({ category });
  } catch (error) {
    console.error('Update category error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/menu-categories/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const deleted = await menuService.deleteCategory(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Category not found' });
    }
    return res.json({ message: 'Category deleted' });
  } catch (error) {
    console.error('Delete category error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== MENU ITEMS ==========

router.get('/:restaurantId/menu-items', async (req: Request, res: Response) => {
  try {
    const items = await menuService.getItems(
      req.params.restaurantId,
      req.query.categoryId as string
    );
    return res.json({ items });
  } catch (error) {
    console.error('Get items error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/menu-items/:id', async (req: Request, res: Response) => {
  try {
    const item = await menuService.getItemById(req.params.id);
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }
    return res.json({ item });
  } catch (error) {
    console.error('Get item error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:restaurantId/menu-items', authenticateUser, async (req: Request, res: Response) => {
  try {
    const { error, value } = menuItemSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: 'Validation error', message: error.details[0].message });
    }
    const item = await menuService.createItem(req.params.restaurantId, value, req.enterpriseId);
    return res.status(201).json({ item });
  } catch (error) {
    console.error('Create item error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/menu-items/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const item = await menuService.updateItem(req.params.id, req.body);
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }
    return res.json({ item });
  } catch (error) {
    console.error('Update item error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/menu-items/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const deleted = await menuService.deleteItem(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Item not found' });
    }
    return res.json({ message: 'Item deleted' });
  } catch (error) {
    console.error('Delete item error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== STOP-LIST ==========

const stopItemSchema = Joi.object({
  reason: Joi.string().min(1).max(500).required(),
  stopUntil: Joi.string().isoDate().optional()
});

router.post('/menu-items/:id/stop', authenticateUser, async (req: Request, res: Response) => {
  try {
    const { error, value } = stopItemSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: 'Validation error', message: error.details[0].message });
    }
    const item = await menuService.stopMenuItem(
      req.params.id,
      value.reason,
      req.userId!,
      value.stopUntil,
      req.enterpriseId
    );
    if (!item) {
      return res.status(404).json({ error: 'Menu item not found' });
    }
    return res.json({ item });
  } catch (error) {
    console.error('Stop menu item error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/menu-items/:id/unstop', authenticateUser, async (req: Request, res: Response) => {
  try {
    const item = await menuService.unstopMenuItem(req.params.id, req.enterpriseId);
    if (!item) {
      return res.status(404).json({ error: 'Menu item not found' });
    }
    return res.json({ item });
  } catch (error) {
    console.error('Unstop menu item error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/stop-list', authenticateUser, async (req: Request, res: Response) => {
  try {
    const restaurantId = req.query.restaurantId as string;
    if (!restaurantId) {
      return res.status(400).json({ error: 'Validation error', message: 'restaurantId query parameter is required' });
    }
    const items = await menuService.getStopList(restaurantId, req.enterpriseId);
    return res.json({ items });
  } catch (error) {
    console.error('Get stop-list error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== MODIFIERS ==========

router.get('/menu-items/:itemId/modifiers', async (req: Request, res: Response) => {
  try {
    const modifiers = await menuService.getModifiers(req.params.itemId);
    return res.json({ modifiers });
  } catch (error) {
    console.error('Get modifiers error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/menu-items/:itemId/modifiers', authenticateUser, async (req: Request, res: Response) => {
  try {
    const { error, value } = modifierSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: 'Validation error', message: error.details[0].message });
    }
    const modifier = await menuService.createModifier(req.params.itemId, value, req.enterpriseId);
    return res.status(201).json({ modifier });
  } catch (error) {
    console.error('Create modifier error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/modifiers/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const modifier = await menuService.updateModifier(req.params.id, req.body);
    if (!modifier) {
      return res.status(404).json({ error: 'Modifier not found' });
    }
    return res.json({ modifier });
  } catch (error) {
    console.error('Update modifier error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/modifiers/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const deleted = await menuService.deleteModifier(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Modifier not found' });
    }
    return res.json({ message: 'Modifier deleted' });
  } catch (error) {
    console.error('Delete modifier error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
