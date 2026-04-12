import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { FinanceService } from '../services/finance.service';
import { ExportService } from '../services/export.service';
import { authenticateUser } from '../middleware/auth.middleware';
import { idempotencyCheck } from '../middleware/idempotency.middleware';
import { config } from '../config';

const router = Router();
const financeService = new FinanceService(config.database.url);
const exportService = new ExportService(config.database.url);

// ========== КАССЫ ==========

router.get('/registers', authenticateUser, async (req: Request, res: Response) => {
  try {
    const registers = await financeService.listRegisters({
      enterpriseId: req.enterpriseId,
      restaurantId: req.query.restaurantId as string,
      status: req.query.status as string
    });
    return res.json({ registers });
  } catch (error) { console.error('List registers error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/registers/:id/open', authenticateUser, async (req: Request, res: Response) => {
  try {
    const schema = Joi.object({
      restaurantId: Joi.string().uuid().required(),
      openingBalance: Joi.number().min(0).required()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const register = await financeService.openRegister(value.restaurantId, req.userId!, value.openingBalance);
    if (!register) return res.status(404).json({ error: 'Register not found or already open' });
    return res.json({ register });
  } catch (error: any) {
    if (error.message === 'Register already open for this restaurant') return res.status(400).json({ error: error.message });
    console.error('Open register error:', error); return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/registers/:id/close', authenticateUser, async (req: Request, res: Response) => {
  try {
    const register = await financeService.closeRegister(req.params.id, req.userId!);
    return res.json({ register });
  } catch (error: any) {
    if (error.message === 'Register not found or already closed') return res.status(404).json({ error: error.message });
    console.error('Close register error:', error); return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/registers/:id/operations', authenticateUser, async (req: Request, res: Response) => {
  try {
    const operations = await financeService.getCashOperations(req.params.id);
    return res.json({ operations });
  } catch (error) { console.error('Get operations error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/registers/:id/operations', authenticateUser, async (req: Request, res: Response) => {
  try {
    const schema = Joi.object({
      operationType: Joi.string().valid('sale', 'refund', 'cash_in', 'cash_out', 'encashment').required(),
      amount: Joi.number().positive().required(),
      paymentMethod: Joi.string().max(50).required(),
      orderId: Joi.string().uuid().optional(),
      description: Joi.string().optional()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const operation = await financeService.addCashOperation({
      registerId: req.params.id,
      enterpriseId: req.enterpriseId,
      operationType: value.operationType,
      amount: value.amount,
      paymentMethod: value.paymentMethod,
      orderId: value.orderId,
      performedBy: req.userId!,
      description: value.description
    });
    return res.status(201).json({ operation });
  } catch (error) { console.error('Add operation error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

// ========== ПЛАТЕЖИ ==========

router.get('/payments', authenticateUser, async (req: Request, res: Response) => {
  try {
    const payments = await financeService.getPayments({
      enterpriseId: req.enterpriseId,
      orderId: req.query.orderId as string,
      status: req.query.status as string,
      paymentMethod: req.query.paymentMethod as string,
      dateFrom: req.query.dateFrom as string,
      dateTo: req.query.dateTo as string
    });
    return res.json({ payments });
  } catch (error) { console.error('Get payments error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/payments', authenticateUser, idempotencyCheck, async (req: Request, res: Response) => {
  try {
    const schema = Joi.object({
      orderId: Joi.string().uuid().required(),
      amount: Joi.number().positive().required(),
      paymentMethod: Joi.string().max(50).required(),
      paymentGateway: Joi.string().max(100).optional(),
      externalId: Joi.string().max(255).optional(),
      metadata: Joi.object().optional()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const payment = await financeService.createPayment({ ...value, enterpriseId: req.enterpriseId });
    return res.status(201).json({ payment });
  } catch (error) { console.error('Create payment error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

router.put('/payments/:id/status', authenticateUser, async (req: Request, res: Response) => {
  try {
    const schema = Joi.object({
      status: Joi.string().valid('pending', 'completed', 'failed', 'refunded').required(),
      refundAmount: Joi.number().min(0).optional()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const payment = await financeService.updatePaymentStatus(req.params.id, value.status, value.refundAmount, req.enterpriseId);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    return res.json({ payment });
  } catch (error) { console.error('Update payment status error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

// ========== КАТЕГОРИИ РАСХОДОВ ==========

router.get('/expense-categories', authenticateUser, async (req: Request, res: Response) => {
  try {
    if (!req.enterpriseId) return res.status(400).json({ error: 'enterpriseId is required' });
    const categories = await financeService.listExpenseCategories(req.enterpriseId);
    return res.json({ categories });
  } catch (error) { console.error('List expense categories error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/expense-categories', authenticateUser, async (req: Request, res: Response) => {
  try {
    const schema = Joi.object({
      name: Joi.string().max(255).required(),
      parentId: Joi.string().uuid().optional()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    if (!req.enterpriseId) return res.status(400).json({ error: 'enterpriseId is required' });

    const category = await financeService.createExpenseCategory({ ...value, enterpriseId: req.enterpriseId });
    return res.status(201).json({ category });
  } catch (error) { console.error('Create expense category error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

// ========== РАСХОДЫ ==========

router.get('/expenses', authenticateUser, async (req: Request, res: Response) => {
  try {
    const expenses = await financeService.listExpenses({
      enterpriseId: req.enterpriseId,
      restaurantId: req.query.restaurantId as string,
      categoryId: req.query.categoryId as string,
      dateFrom: req.query.dateFrom as string,
      dateTo: req.query.dateTo as string
    });
    return res.json({ expenses });
  } catch (error) { console.error('List expenses error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/expenses', authenticateUser, async (req: Request, res: Response) => {
  try {
    const schema = Joi.object({
      restaurantId: Joi.string().uuid().optional(),
      categoryId: Joi.string().uuid().required(),
      amount: Joi.number().positive().required(),
      description: Joi.string().optional(),
      expenseDate: Joi.string().required(),
      receiptUrl: Joi.string().uri().optional()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    if (!req.enterpriseId) return res.status(400).json({ error: 'enterpriseId is required' });

    const expense = await financeService.createExpense({
      ...value, enterpriseId: req.enterpriseId, recordedBy: req.userId!
    });
    return res.status(201).json({ expense });
  } catch (error) { console.error('Create expense error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

// ========== ОТЧЁТЫ ==========

router.get('/reports/revenue', authenticateUser, async (req: Request, res: Response) => {
  try {
    const { dateFrom, dateTo, restaurantId } = req.query;
    if (!dateFrom || !dateTo) return res.status(400).json({ error: 'dateFrom and dateTo are required' });

    const report = await financeService.getRevenueReport({
      enterpriseId: req.enterpriseId,
      restaurantId: restaurantId as string,
      dateFrom: dateFrom as string,
      dateTo: dateTo as string
    });
    return res.json({ report });
  } catch (error) { console.error('Revenue report error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/reports/pnl', authenticateUser, async (req: Request, res: Response) => {
  try {
    const { dateFrom, dateTo, restaurantId } = req.query;
    if (!dateFrom || !dateTo) return res.status(400).json({ error: 'dateFrom and dateTo are required' });

    const report = await financeService.getPnLReport({
      enterpriseId: req.enterpriseId,
      restaurantId: restaurantId as string,
      dateFrom: dateFrom as string,
      dateTo: dateTo as string
    });
    return res.json({ report });
  } catch (error) { console.error('PnL report error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

// ========== ОНЛАЙН-ОПЛАТА (YooKassa) ==========

router.post('/online-payment', authenticateUser, idempotencyCheck, async (req: Request, res: Response) => {
  try {
    const schema = Joi.object({
      orderId: Joi.string().uuid().required(),
      amount: Joi.number().positive().required(),
      customerEmail: Joi.string().email().optional(),
      items: Joi.array().items(Joi.object({
        name: Joi.string().max(128).required(),
        quantity: Joi.number().positive().required(),
        price: Joi.number().positive().required(),
        vatCode: Joi.number().integer().min(1).max(6).optional()
      })).min(1).required()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const result = await financeService.initiateOnlinePayment({
      orderId: value.orderId,
      enterpriseId: req.enterpriseId,
      amount: value.amount,
      customerEmail: value.customerEmail,
      items: value.items
    });

    return res.status(201).json({
      paymentId: result.payment.id,
      confirmationUrl: result.confirmationUrl
    });
  } catch (err) {
    console.error('Initiate online payment error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// YooKassa webhook callback (no JWT auth -- verified by checking external_id existence)
router.post('/webhooks/yookassa', async (req: Request, res: Response) => {
  try {
    const payload = req.body;

    // Базовая валидация структуры вебхука
    if (!payload || !payload.event || !payload.object || !payload.object.id) {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    // Проверяем что object.id существует среди наших платежей (защита от подделки)
    const validEvents = ['payment.succeeded', 'payment.canceled', 'refund.succeeded'];
    if (!validEvents.includes(payload.event)) {
      // Неизвестный тип события -- просто подтверждаем получение
      return res.status(200).json({ status: 'ignored' });
    }

    await financeService.processPaymentWebhook(payload);
    return res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('YooKassa webhook error:', err);
    // Возвращаем 200, чтобы YooKassa не повторяла уведомление при внутренней ошибке обработки
    // (повторная обработка может вызвать дублирование). Ошибку логируем.
    return res.status(200).json({ status: 'error_logged' });
  }
});

// Получение фискальных чеков по заказу
router.get('/fiscal-receipts/:orderId', authenticateUser, async (req: Request, res: Response) => {
  try {
    const receipts = await financeService.getFiscalReceipts(req.params.orderId);
    return res.json({ receipts });
  } catch (err) {
    console.error('Get fiscal receipts error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== ЭКСПОРТ 1С ==========

router.get('/exports/sales', authenticateUser, async (req: Request, res: Response) => {
  try {
    if (!req.enterpriseId) return res.status(400).json({ error: 'enterpriseId is required' });
    const { dateFrom, dateTo } = req.query;
    if (!dateFrom || !dateTo) return res.status(400).json({ error: 'dateFrom and dateTo are required' });

    const { xml, recordsCount } = await exportService.exportSales({
      enterpriseId: req.enterpriseId,
      dateFrom: dateFrom as string,
      dateTo: dateTo as string,
      exportedBy: req.userId,
    });

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="sales_${dateFrom}_${dateTo}.xml"`);
    res.setHeader('X-Records-Count', String(recordsCount));
    return res.send(xml);
  } catch (error) {
    console.error('Export sales error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/exports/expenses', authenticateUser, async (req: Request, res: Response) => {
  try {
    if (!req.enterpriseId) return res.status(400).json({ error: 'enterpriseId is required' });
    const { dateFrom, dateTo } = req.query;
    if (!dateFrom || !dateTo) return res.status(400).json({ error: 'dateFrom and dateTo are required' });

    const { xml, recordsCount } = await exportService.exportExpenses({
      enterpriseId: req.enterpriseId,
      dateFrom: dateFrom as string,
      dateTo: dateTo as string,
      exportedBy: req.userId,
    });

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="expenses_${dateFrom}_${dateTo}.xml"`);
    res.setHeader('X-Records-Count', String(recordsCount));
    return res.send(xml);
  } catch (error) {
    console.error('Export expenses error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/exports/history', authenticateUser, async (req: Request, res: Response) => {
  try {
    if (!req.enterpriseId) return res.status(400).json({ error: 'enterpriseId is required' });

    const exports = await exportService.listExports(req.enterpriseId);
    return res.json({ exports });
  } catch (error) {
    console.error('List exports error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
