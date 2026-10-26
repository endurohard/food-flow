import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { NomenclatureService, NomenclatureSource } from '../services/nomenclature.service';
import { authenticateUser } from '../middleware/auth.middleware';
import { config } from '../config';

const router = Router();
const service = new NomenclatureService(config.database.url);

/**
 * Номенклатура обязательно привязана к предприятию: справочник мультитенантный,
 * и без контекста запрос вернул бы чужие позиции. super_admin тоже обязан
 * указать предприятие — иначе дерево склеится из всех организаций разом.
 */
function enterpriseOf(req: Request, res: Response): string | null {
  if (!req.enterpriseId) {
    res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    return null;
  }
  return req.enterpriseId;
}

const ITEM_TYPES = ['dish', 'good', 'prepared'];
const SOURCES: NomenclatureSource[] = ['menu', 'inventory'];

function sourceOf(req: Request, res: Response): NomenclatureSource | null {
  const s = req.params.source as NomenclatureSource;
  if (!SOURCES.includes(s)) {
    res.status(400).json({ error: `Неизвестный раздел «${s}»: допустимы menu или inventory` });
    return null;
  }
  return s;
}

// ========== ДЕРЕВО ==========

router.get('/tree', authenticateUser, async (req: Request, res: Response) => {
  try {
    const eid = enterpriseOf(req, res);
    if (!eid) return;
    const itemType = req.query.itemType as string | undefined;
    if (itemType && !ITEM_TYPES.includes(itemType)) {
      return res.status(400).json({ error: `Неизвестный тип «${itemType}»` });
    }
    const tree = await service.getTree(eid, {
      itemType,
      includeDeleted: req.query.includeDeleted === 'true'
    });
    return res.json(tree);
  } catch (error) {
    console.error('Get nomenclature tree error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== ПОЗИЦИИ ==========

router.get('/items', authenticateUser, async (req: Request, res: Response) => {
  try {
    const eid = enterpriseOf(req, res);
    if (!eid) return;
    const itemType = req.query.itemType as string | undefined;
    if (itemType && !ITEM_TYPES.includes(itemType)) {
      return res.status(400).json({ error: `Неизвестный тип «${itemType}»` });
    }
    const items = await service.listItems(eid, {
      itemType,
      groupId: req.query.groupId as string | undefined,
      includeDeleted: req.query.includeDeleted === 'true',
      search: req.query.search as string | undefined
    });
    return res.json({ items });
  } catch (error) {
    console.error('List nomenclature items error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/items/:source/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const eid = enterpriseOf(req, res);
    if (!eid) return;
    const source = sourceOf(req, res);
    if (!source) return;
    const item = await service.getItem(req.params.id, source, eid);
    if (!item) return res.status(404).json({ error: 'Позиция не найдена' });
    return res.json({ item });
  } catch (error) {
    console.error('Get nomenclature item error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/items/:source/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const eid = enterpriseOf(req, res);
    if (!eid) return;
    const source = sourceOf(req, res);
    if (!source) return;

    // Блюда и товары продаются (menu_items), товары и заготовки хранятся
    // (inventory_items) — набор допустимых типов у таблиц разный.
    const allowedTypes = source === 'menu' ? ['dish', 'good'] : ['good', 'prepared'];
    const schema = Joi.object({
      groupId: Joi.string().uuid().allow(null).optional(),
      name: Joi.string().max(255).optional(),
      sku: Joi.string().max(50).allow(null, '').optional(),
      itemType: Joi.string().valid(...allowedTypes).optional(),
      accountingCategory: Joi.string().max(100).allow(null, '').optional(),
      taxCategory: Joi.string().max(100).allow(null, '').optional(),
      productCategory: Joi.string().max(100).allow(null, '').optional(),
      prepStationId: Joi.string().uuid().allow(null).optional(),
      cashOrder: Joi.number().integer().min(0).optional(),
      unit: Joi.string().max(20).optional()
    }).min(1);

    const { error: vErr, value } = schema.validate(req.body);
    if (vErr) return res.status(400).json({ error: vErr.details[0].message });

    // Пустая строка в артикуле — это «артикула нет», а не значение:
    // иначе два пустых артикула столкнутся на уникальном индексе.
    for (const k of ['sku', 'accountingCategory', 'taxCategory', 'productCategory']) {
      if (value[k] === '') value[k] = null;
    }

    const updated = await service.updateItem(req.params.id, source, value, eid);
    if (!updated) return res.status(404).json({ error: 'Позиция не найдена' });
    return res.json({ item: updated });
  } catch (error: any) {
    if (error.message === 'GROUP_NOT_FOUND') {
      return res.status(400).json({ error: 'Группа не найдена у этого предприятия' });
    }
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Такой артикул уже занят другой позицией' });
    }
    if (error.code === '23514') {
      return res.status(400).json({ error: 'Недопустимый тип позиции' });
    }
    console.error('Update nomenclature item error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/items/:source/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const eid = enterpriseOf(req, res);
    if (!eid) return;
    const source = sourceOf(req, res);
    if (!source) return;
    const ok = await service.deleteItem(req.params.id, source, eid);
    if (!ok) return res.status(404).json({ error: 'Позиция не найдена или уже удалена' });
    return res.json({ success: true });
  } catch (error) {
    console.error('Delete nomenclature item error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/items/:source/:id/restore', authenticateUser, async (req: Request, res: Response) => {
  try {
    const eid = enterpriseOf(req, res);
    if (!eid) return;
    const source = sourceOf(req, res);
    if (!source) return;
    const ok = await service.restoreItem(req.params.id, source, eid);
    if (!ok) return res.status(404).json({ error: 'Позиция не найдена' });
    return res.json({ success: true });
  } catch (error: any) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Артикул позиции занят: освободите его перед восстановлением' });
    }
    console.error('Restore nomenclature item error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** Порядок позиций на кассе (тумблер «Режим: порядок на кассе»). */
router.put('/cash-order', authenticateUser, async (req: Request, res: Response) => {
  try {
    const eid = enterpriseOf(req, res);
    if (!eid) return;
    const schema = Joi.object({
      items: Joi.array().items(Joi.object({
        id: Joi.string().uuid().required(),
        cashOrder: Joi.number().integer().min(0).required()
      })).min(1).required()
    });
    const { error: vErr, value } = schema.validate(req.body);
    if (vErr) return res.status(400).json({ error: vErr.details[0].message });
    const n = await service.reorderCash(value.items, eid);
    return res.json({ updated: n });
  } catch (error) {
    console.error('Reorder cash error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== ГРУППЫ ==========

router.get('/groups', authenticateUser, async (req: Request, res: Response) => {
  try {
    const eid = enterpriseOf(req, res);
    if (!eid) return;
    const groups = await service.listGroups(eid, req.query.includeDeleted === 'true');
    return res.json({ groups });
  } catch (error) {
    console.error('List nomenclature groups error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/groups', authenticateUser, async (req: Request, res: Response) => {
  try {
    const eid = enterpriseOf(req, res);
    if (!eid) return;
    const schema = Joi.object({
      parentId: Joi.string().uuid().allow(null).optional(),
      name: Joi.string().max(255).required(),
      sku: Joi.string().max(50).allow(null, '').optional(),
      displayOrder: Joi.number().integer().min(0).optional()
    });
    const { error: vErr, value } = schema.validate(req.body);
    if (vErr) return res.status(400).json({ error: vErr.details[0].message });
    if (value.sku === '') value.sku = null;
    const group = await service.createGroup(value, eid);
    return res.status(201).json({ group });
  } catch (error: any) {
    if (error.message === 'PARENT_NOT_FOUND') {
      return res.status(400).json({ error: 'Родительская группа не найдена у этого предприятия' });
    }
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Такой артикул уже занят другой группой' });
    }
    console.error('Create nomenclature group error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/groups/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const eid = enterpriseOf(req, res);
    if (!eid) return;
    const schema = Joi.object({
      parentId: Joi.string().uuid().allow(null).optional(),
      name: Joi.string().max(255).optional(),
      sku: Joi.string().max(50).allow(null, '').optional(),
      displayOrder: Joi.number().integer().min(0).optional()
    }).min(1);
    const { error: vErr, value } = schema.validate(req.body);
    if (vErr) return res.status(400).json({ error: vErr.details[0].message });
    if (value.sku === '') value.sku = null;
    const group = await service.updateGroup(req.params.id, value, eid);
    if (!group) return res.status(404).json({ error: 'Группа не найдена' });
    return res.json({ group });
  } catch (error: any) {
    if (error.message === 'PARENT_NOT_FOUND') {
      return res.status(400).json({ error: 'Родительская группа не найдена у этого предприятия' });
    }
    if (error.message === 'CYCLE') {
      return res.status(400).json({ error: 'Группу нельзя перенести внутрь самой себя или своей подгруппы' });
    }
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Такой артикул уже занят другой группой' });
    }
    if (error.code === '23514') {
      return res.status(400).json({ error: 'Группа не может быть сама себе родителем' });
    }
    console.error('Update nomenclature group error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/groups/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const eid = enterpriseOf(req, res);
    if (!eid) return;
    await service.deleteGroup(req.params.id, eid);
    return res.json({ success: true });
  } catch (error: any) {
    if (error.message === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Группа не найдена или уже удалена' });
    }
    if (error.message === 'HAS_CHILDREN') {
      return res.status(409).json({ error: 'В группе есть подгруппы — сначала удалите или перенесите их' });
    }
    if (error.message === 'HAS_ITEMS') {
      return res.status(409).json({ error: 'В группе есть позиции — сначала перенесите их в другую группу' });
    }
    console.error('Delete nomenclature group error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/groups/:id/restore', authenticateUser, async (req: Request, res: Response) => {
  try {
    const eid = enterpriseOf(req, res);
    if (!eid) return;
    const group = await service.restoreGroup(req.params.id, eid);
    if (!group) return res.status(404).json({ error: 'Группа не найдена' });
    return res.json({ group });
  } catch (error: any) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Артикул группы занят: освободите его перед восстановлением' });
    }
    console.error('Restore nomenclature group error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
