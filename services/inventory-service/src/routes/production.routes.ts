import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { ProductionService } from '../services/production.service';
import { InventoryService } from '../services/inventory.service';
import { SupplierService } from '../services/supplier.service';
import { authenticateUser, requireRole, ROLES } from '../middleware/auth.middleware';
import { config } from '../config';

const router = Router();
const inventoryService = new InventoryService(config.database.url);
const productionService = new ProductionService(config.database.url, inventoryService);
const supplierService = new SupplierService(config.database.url);

const MANAGE_ROLES = [ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER, ROLES.CHEF];

// Журнал производства
router.get('/production', authenticateUser, async (req: Request, res: Response) => {
  try {
    const runs = await productionService.list({
      enterpriseId: req.enterpriseId,
      warehouseId: req.query.warehouseId as string | undefined,
      outputItemId: req.query.outputItemId as string | undefined,
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined
    });
    return res.json({ productionRuns: runs });
  } catch (error) {
    console.error('List production runs error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Запуск производства по техкарте
router.post('/production', authenticateUser, requireRole(...MANAGE_ROLES), async (req: Request, res: Response) => {
  try {
    const schema = Joi.object({
      techCardId: Joi.string().uuid().required(),
      warehouseId: Joi.string().uuid().required(),
      quantity: Joi.number().positive().required(),
      notes: Joi.string().allow('', null)
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const run = await productionService.produce({
      ...value,
      producedBy: req.userId,
      enterpriseId: req.enterpriseId
    });
    return res.status(201).json({ productionRun: run });
  } catch (error: any) {
    if (error.message && (error.message.includes('Insufficient') || error.message.includes('not found') || error.message.includes('no output') || error.message.includes('no ingredients'))) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Create production run error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Отмена выпуска (обратные проводки)
router.post('/production/:id/cancel', authenticateUser, requireRole(...MANAGE_ROLES), async (req: Request, res: Response) => {
  try {
    const run = await productionService.cancel(req.params.id, req.userId, req.enterpriseId);
    return res.json({ productionRun: run });
  } catch (error: any) {
    if (error.message && (error.message.includes('not found') || error.message.includes('consumed') || error.message.includes('Insufficient'))) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Cancel production run error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Назначение оптовой и розничной цены позиции
router.put('/items/:id/prices', authenticateUser, requireRole(...MANAGE_ROLES), async (req: Request, res: Response) => {
  try {
    const schema = Joi.object({
      wholesalePrice: Joi.number().min(0).allow(null),
      retailPrice: Joi.number().min(0).allow(null)
    }).or('wholesalePrice', 'retailPrice');
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const item = await inventoryService.updatePrices(req.params.id, value, req.enterpriseId);
    if (!item) return res.status(404).json({ error: 'Inventory item not found' });
    return res.json({ item });
  } catch (error) {
    console.error('Update prices error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Отчёт по маржинальности: себестоимость vs опт vs розница
router.get('/reports/margins', authenticateUser, async (req: Request, res: Response) => {
  try {
    const rows = await productionService.getMarginReport(req.enterpriseId);
    return res.json({ margins: rows });
  } catch (error) {
    console.error('Margin report error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// История закупочных цен позиции по поставкам (себестоимость от каждой поставки)
router.get('/items/:id/cost-history', authenticateUser, async (req: Request, res: Response) => {
  try {
    const history = await supplierService.getItemCostHistory(req.params.id, req.enterpriseId);
    if (!history) return res.status(404).json({ error: 'Inventory item not found' });
    return res.json(history);
  } catch (error) {
    console.error('Cost history error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Анализ позиций: топ списаний и аутсайдеры спроса
router.get('/reports/item-analysis', authenticateUser, async (req: Request, res: Response) => {
  try {
    const items = await supplierService.getItemAnalysis({
      enterpriseId: req.enterpriseId,
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined
    });
    return res.json({ items });
  } catch (error) {
    console.error('Item analysis error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Анализ блюд меню: спрос по заказам, наименее популярные
router.get('/reports/dish-analysis', authenticateUser, async (req: Request, res: Response) => {
  try {
    const dishes = await supplierService.getDishAnalysis({
      enterpriseId: req.enterpriseId,
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined
    });
    return res.json({ dishes });
  } catch (error) {
    console.error('Dish analysis error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
