import { Router, Request, Response } from 'express';
import Joi from 'joi';
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { MenuService } from '../services/menu.service';
import { authenticateUser, optionalAuth, requireRole } from '../middleware/auth.middleware';
import { config } from '../config';

const router = Router();
const menuService = new MenuService(config.database.url);

const categorySchema = Joi.object({
  name: Joi.string().min(1).max(100).required(),
  description: Joi.string().max(500).optional(),
  displayOrder: Joi.number().integer().min(0).optional()
});

// Значки блюд и цвета плашек — тот же набор, что в админке (menu.html)
export const MENU_ITEM_ICONS = ['pizza', 'burger', 'roll', 'soup', 'salad', 'coffee', 'cake', 'drink'];
export const MENU_ITEM_ICON_COLORS = ['green', 'tomato', 'yellow', 'cream'];

// Фото: внешний URL или путь к файлу, загруженному через /menu-items/:id/image
const imageUrlSchema = Joi.alternatives()
  .try(Joi.string().uri({ scheme: ['http', 'https'] }), Joi.string().pattern(/^\/api\/restaurants\/media\/[\w\-./]+$/))
  .allow('', null);

const menuItemSchema = Joi.object({
  categoryId: Joi.string().uuid().allow(null).optional(),
  name: Joi.string().min(1).max(255).required(),
  description: Joi.string().max(2000).optional(),
  price: Joi.number().min(0).required(),
  imageUrl: imageUrlSchema.optional(),
  icon: Joi.string().valid(...MENU_ITEM_ICONS).allow(null).optional(),
  iconColor: Joi.string().valid(...MENU_ITEM_ICON_COLORS).allow(null).optional(),
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

const menuItemVisualSchema = Joi.object({
  imageUrl: imageUrlSchema.optional(),
  icon: Joi.string().valid(...MENU_ITEM_ICONS).allow(null).optional(),
  iconColor: Joi.string().valid(...MENU_ITEM_ICON_COLORS).allow(null).optional()
});

export const modifierSchema = Joi.object({
  name: Joi.string().min(1).max(100).required(),
  modifierGroup: Joi.string().max(100).optional(),
  priceAdjustment: Joi.number().optional(),
  isDefault: Joi.boolean().optional(),
  inventoryItemId: Joi.string().uuid().allow(null).optional(),
  techCardId: Joi.string().uuid().allow(null).optional(),
  // Расход на ОДИН выбор модификатора. Строго больше нуля: нулевой расход
  // означал бы «учитываем, но ничего не списываем» — это молчаливая ошибка.
  // `when` вместо `with`: правило `with` считается выполненным и при
  // quantity: null, поэтому источник без расхода проскакивал бы в БД.
  // В ветке `then` схема задаётся ЗАНОВО, без allow(null): иначе разрешение
  // null из базового правила переносится в ветку и снова пропускает пустой
  // расход при заданном источнике.
  quantity: Joi.alternatives().conditional(
    Joi.ref('inventoryItemId'),
    {
      is: Joi.string().uuid().required(),
      then: Joi.number().positive().required(),
      otherwise: Joi.alternatives().conditional(
        Joi.ref('techCardId'),
        {
          is: Joi.string().uuid().required(),
          then: Joi.number().positive().required(),
          otherwise: Joi.number().positive().allow(null).optional()
        }
      )
    }
  )
})
  .oxor('inventoryItemId', 'techCardId')
  .messages({
    'object.oxor': 'Укажите либо позицию склада, либо техкарту — но не оба источника сразу',
    'any.required': 'Для складского учёта модификатора нужно указать расход больше нуля'
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

router.post('/:restaurantId/menu-categories', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
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

router.put('/menu-categories/:id', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    const category = await menuService.updateCategory(req.params.id, req.body, isSuper ? undefined : req.enterpriseId);
    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }
    return res.json({ category });
  } catch (error) {
    console.error('Update category error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/menu-categories/:id', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    const deleted = await menuService.deleteCategory(req.params.id, isSuper ? undefined : req.enterpriseId);
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

router.post('/:restaurantId/menu-items', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
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

router.put('/menu-items/:id', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    const { error: visualError } = menuItemVisualSchema.validate(
      { imageUrl: req.body.imageUrl, icon: req.body.icon, iconColor: req.body.iconColor }
    );
    if (visualError) {
      return res.status(400).json({ error: 'Validation error', message: visualError.details[0].message });
    }
    const item = await menuService.updateItem(req.params.id, req.body, isSuper ? undefined : req.enterpriseId);
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }
    return res.json({ item });
  } catch (error) {
    console.error('Update item error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/menu-items/:id', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    const deleted = await menuService.deleteItem(req.params.id, isSuper ? undefined : req.enterpriseId);
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

// ========== ФОТО БЛЮДА ==========
// Файл приходит JSON-ом как data URL: так не нужен multer, а лимит тела
// поднят только для этого маршрута (см. index.ts). Файлы лежат в томе
// UPLOAD_DIR и отдаются этим же сервисом по /api/restaurants/media/...

const MEDIA_URL_PREFIX = '/api/restaurants/media/';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
};

const imageUploadSchema = Joi.object({
  dataUrl: Joi.string().pattern(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/).required()
});

async function removeLocalImage(imageUrl: string | null | undefined): Promise<void> {
  if (!imageUrl || !imageUrl.startsWith(MEDIA_URL_PREFIX)) return;
  const rel = imageUrl.slice(MEDIA_URL_PREFIX.length);
  const file = path.resolve(config.uploadDir, rel);
  // Не выходим за пределы папки загрузок, даже если в базе окажется «../»
  if (!file.startsWith(path.resolve(config.uploadDir) + path.sep)) return;
  await fs.unlink(file).catch(() => undefined);
}

async function findOwnItem(req: Request, res: Response): Promise<any | null> {
  const item = await menuService.getItemById(req.params.id);
  const isSuper = req.userRole === 'super_admin';
  if (!item || (!isSuper && item.enterprise_id && item.enterprise_id !== req.enterpriseId)) {
    res.status(404).json({ error: 'Item not found' });
    return null;
  }
  return item;
}

router.post('/menu-items/:id/image', express.json({ limit: '8mb' }), authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const { error, value } = imageUploadSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: 'Validation error', message: 'Нужна картинка JPG, PNG или WebP' });
    }
    const item = await findOwnItem(req, res);
    if (!item) return;

    const [, mime, b64] = /^data:(image\/[a-z]+);base64,(.+)$/.exec(value.dataUrl) as RegExpExecArray;
    const ext = IMAGE_TYPES[mime];
    const buffer = Buffer.from(b64, 'base64');
    if (!ext || buffer.length === 0) {
      return res.status(400).json({ error: 'Validation error', message: 'Нужна картинка JPG, PNG или WebP' });
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
      return res.status(413).json({ error: 'Too large', message: 'Фото больше 5 МБ' });
    }

    const dir = path.join(config.uploadDir, 'menu');
    await fs.mkdir(dir, { recursive: true });
    const fileName = `${item.id}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
    await fs.writeFile(path.join(dir, fileName), buffer);

    const imageUrl = `${MEDIA_URL_PREFIX}menu/${fileName}`;
    const updated = await menuService.updateItem(item.id, { imageUrl });
    await removeLocalImage(item.image_url);
    return res.json({ item: updated, imageUrl });
  } catch (error) {
    console.error('Upload image error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/menu-items/:id/image', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const item = await findOwnItem(req, res);
    if (!item) return;
    const updated = await menuService.updateItem(item.id, { imageUrl: null });
    await removeLocalImage(item.image_url);
    return res.json({ item: updated });
  } catch (error) {
    console.error('Delete image error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

const stopItemSchema = Joi.object({
  reason: Joi.string().min(1).max(500).required(),
  stopUntil: Joi.string().isoDate().optional()
});

router.post('/menu-items/:id/stop', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator'), async (req: Request, res: Response) => {
  try {
    const { error, value } = stopItemSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: 'Validation error', message: error.details[0].message });
    }
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    const item = await menuService.stopMenuItem(
      req.params.id,
      value.reason,
      req.userId!,
      value.stopUntil,
      isSuper ? undefined : req.enterpriseId
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

router.post('/menu-items/:id/unstop', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator'), async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    const item = await menuService.unstopMenuItem(req.params.id, isSuper ? undefined : req.enterpriseId);
    if (!item) {
      return res.status(404).json({ error: 'Menu item not found' });
    }
    return res.json({ item });
  } catch (error) {
    console.error('Unstop menu item error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/stop-list', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator', 'chef'), async (req: Request, res: Response) => {
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

router.post('/menu-items/:itemId/modifiers', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const { error, value } = modifierSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: 'Validation error', message: error.details[0].message });
    }
    // Источник расхода должен принадлежать своему предприятию, иначе продажа
    // списала бы продукты с чужого склада.
    if (req.enterpriseId && (value.inventoryItemId || value.techCardId)) {
      const own = await menuService.modifierSourceBelongsTo(value, req.enterpriseId);
      if (!own.ok) {
        return res.status(400).json({ error: 'Validation error', message: own.reason });
      }
    }
    const modifier = await menuService.createModifier(req.params.itemId, value, req.enterpriseId);
    return res.status(201).json({ modifier });
  } catch (error: any) {
    // Нарушение CHECK'ов миграции 034 — ошибка ввода, а не сбой сервера:
    // пользователь должен прочитать, что именно поправить.
    if (error?.code === '23514') {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Проверьте складскую связь: нужен один источник расхода и количество больше нуля'
      });
    }
    console.error('Create modifier error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/modifiers/:id', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    if (req.enterpriseId && (req.body.inventoryItemId || req.body.techCardId)) {
      const own = await menuService.modifierSourceBelongsTo(req.body, req.enterpriseId);
      if (!own.ok) {
        return res.status(400).json({ error: 'Validation error', message: own.reason });
      }
    }
    const modifier = await menuService.updateModifier(req.params.id, req.body, isSuper ? undefined : req.enterpriseId);
    if (!modifier) {
      return res.status(404).json({ error: 'Modifier not found' });
    }
    return res.json({ modifier });
  } catch (error: any) {
    if (error?.code === '23514') {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Проверьте складскую связь: нужен один источник расхода и количество больше нуля'
      });
    }
    console.error('Update modifier error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/modifiers/:id', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    const deleted = await menuService.deleteModifier(req.params.id, isSuper ? undefined : req.enterpriseId);
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
