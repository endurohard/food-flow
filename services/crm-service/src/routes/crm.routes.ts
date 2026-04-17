import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { CRMService } from '../services/crm.service';
import { authenticateUser, requireRole } from '../middleware/auth.middleware';
import { idempotencyCheck } from '../middleware/idempotency.middleware';
import { config } from '../config';

const router = Router();
const crmService = new CRMService(config.database.url);

// ========== CUSTOMERS ==========

router.get('/customers', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const customers = await crmService.listCustomers({
      enterpriseId: req.enterpriseId,
      loyaltyTier: req.query.loyaltyTier as string,
      tag: req.query.tag as string
    });
    return res.json({ customers });
  } catch (error) { console.error('List customers error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/customers/:userId', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const profile = await crmService.getCustomerProfile(req.params.userId);
    if (!profile) return res.status(404).json({ error: 'Customer profile not found' });
    return res.json({ profile });
  } catch (error) { console.error('Get customer error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/customers', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const schema = Joi.object({
      userId: Joi.string().uuid().required(),
      enterpriseId: Joi.string().uuid().optional(),
      birthday: Joi.string().optional(),
      preferences: Joi.object().optional(),
      tags: Joi.array().items(Joi.string()).optional(),
      source: Joi.string().max(100).optional(),
      notes: Joi.string().optional()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    // Используем enterpriseId из токена если не передан явно
    if (!value.enterpriseId) value.enterpriseId = req.enterpriseId;
    const profile = await crmService.createProfile(value);
    return res.status(201).json({ profile });
  } catch (error) { console.error('Create customer error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

router.put('/customers/:userId', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const profile = await crmService.updateProfile(req.params.userId, req.body, req.enterpriseId);
    if (!profile) return res.status(404).json({ error: 'Customer profile not found' });
    return res.json({ profile });
  } catch (error) { console.error('Update customer error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

// ========== LOYALTY PROGRAMS ==========

router.get('/loyalty-programs', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    if (!req.enterpriseId) return res.status(400).json({ error: 'enterpriseId is required' });
    const programs = await crmService.listLoyaltyPrograms(req.enterpriseId);
    return res.json({ programs });
  } catch (error) { console.error('List loyalty programs error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/loyalty-programs', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const schema = Joi.object({
      name: Joi.string().max(200).required(),
      programType: Joi.string().valid('points', 'cashback', 'discount', 'stamp_card').required(),
      pointsPerCurrency: Joi.number().min(0).optional(),
      redemptionRate: Joi.number().min(0).optional(),
      tierThresholds: Joi.object().optional(),
      rules: Joi.object().optional(),
      isActive: Joi.boolean().optional()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    value.enterpriseId = req.enterpriseId;
    const program = await crmService.createLoyaltyProgram(value);
    return res.status(201).json({ program });
  } catch (error) { console.error('Create loyalty program error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

router.put('/loyalty-programs/:id', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const program = await crmService.updateLoyaltyProgram(req.params.id, req.body, req.enterpriseId);
    if (!program) return res.status(404).json({ error: 'Loyalty program not found' });
    return res.json({ program });
  } catch (error) { console.error('Update loyalty program error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

// ========== PROMOTIONS ==========

// ВАЖНО: маршрут validate-code должен быть ДО маршрута /:id, иначе Express поглотит его как id
router.get('/promotions/validate-code', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator', 'waiter'), async (req: Request, res: Response) => {
  try {
    const code = req.query.code as string;
    if (!code) return res.status(400).json({ error: 'code query parameter is required' });
    const promotion = await crmService.validatePromoCode(code, req.enterpriseId);
    if (!promotion) return res.status(404).json({ error: 'Promo code not found or expired' });
    return res.json({ promotion, valid: true });
  } catch (error) { console.error('Validate promo code error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

// Атомарное применение промокода: инкрементирует used_count только если лимит не исчерпан.
// Должен вызываться при реальном применении промо к заказу, а не для preview (для preview — validate-code).
router.post('/promotions/apply', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator', 'waiter'), idempotencyCheck, async (req: Request, res: Response) => {
  try {
    const schema = Joi.object({
      code: Joi.string().max(50).required()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const promotion = await crmService.redeemPromoCode(value.code, req.enterpriseId);
    if (!promotion) {
      return res.status(410).json({
        error: 'Promo code not found, expired, or usage limit exhausted'
      });
    }
    return res.json({ promotion, applied: true });
  } catch (error) {
    console.error('Apply promo code error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/promotions', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const promotions = await crmService.listPromotions({
      enterpriseId: req.enterpriseId,
      isActive: req.query.isActive !== 'false',
      promoType: req.query.promoType as string
    });
    return res.json({ promotions });
  } catch (error) { console.error('List promotions error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/promotions', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const schema = Joi.object({
      name: Joi.string().max(200).required(),
      promoType: Joi.string().valid('percentage', 'fixed_amount', 'bogo', 'combo', 'happy_hour').required(),
      discountValue: Joi.number().min(0).required(),
      conditions: Joi.object().optional(),
      promoCode: Joi.string().max(50).optional(),
      usageLimit: Joi.number().integer().min(1).optional(),
      validFrom: Joi.string().isoDate().optional(),
      validUntil: Joi.string().isoDate().optional(),
      isActive: Joi.boolean().optional()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    value.enterpriseId = req.enterpriseId;
    const promotion = await crmService.createPromotion(value);
    return res.status(201).json({ promotion });
  } catch (error) { console.error('Create promotion error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

router.put('/promotions/:id', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const promotion = await crmService.updatePromotion(req.params.id, req.body, req.enterpriseId);
    if (!promotion) return res.status(404).json({ error: 'Promotion not found' });
    return res.json({ promotion });
  } catch (error) { console.error('Update promotion error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

// ========== POINTS ==========

router.post('/points/earn', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator', 'waiter'), async (req: Request, res: Response) => {
  try {
    const schema = Joi.object({
      customerId: Joi.string().uuid().required(),
      orderId: Joi.string().uuid().required(),
      amount: Joi.number().min(0).required()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    const transaction = await crmService.earnPoints(value.customerId, value.orderId, value.amount);
    return res.status(201).json({ transaction });
  } catch (error: any) {
    if (error.message === 'Customer profile not found') return res.status(404).json({ error: error.message });
    console.error('Earn points error:', error); return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/points/redeem', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator', 'waiter'), idempotencyCheck, async (req: Request, res: Response) => {
  try {
    const schema = Joi.object({
      customerId: Joi.string().uuid().required(),
      points: Joi.number().integer().min(1).required()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    const transaction = await crmService.redeemPoints(value.customerId, value.points);
    return res.status(201).json({ transaction });
  } catch (error: any) {
    if (error.message === 'Customer profile not found') return res.status(404).json({ error: error.message });
    if (error.message === 'Insufficient loyalty points') return res.status(400).json({ error: error.message });
    console.error('Redeem points error:', error); return res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== TRANSACTIONS ==========

router.get('/transactions', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const customerId = req.query.customerId as string;
    if (!customerId) return res.status(400).json({ error: 'customerId query parameter is required' });
    const transactions = await crmService.getTransactions(customerId);
    return res.json({ transactions });
  } catch (error) { console.error('Get transactions error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

export default router;
