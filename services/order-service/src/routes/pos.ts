import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { authenticateUser, requireRole } from '../middleware/auth.middleware';
import {
  createCashRegisterSessionMiddleware,
  QueryablePool,
} from '../middleware/cash-register.middleware';
import { PosSaleError, PosSaleService } from '../services/pos-sale.service';
import { OpenCheckService } from '../services/open-check.service';
import { PosRefundError, PosRefundService } from '../services/pos-refund.service';

const checkItemsSchema = Joi.array()
  .items(
    Joi.object({
      menuItemId: Joi.string().uuid().required(),
      quantity: Joi.number().integer().min(1).max(999).required(),
    })
  )
  .min(1)
  .max(200)
  .required();

export const openCheckCreateSchema = Joi.object({
  restaurantId: Joi.string().uuid().required(),
  label: Joi.string().trim().max(100).allow('').optional(),
  items: checkItemsSchema,
});

export const openCheckUpdateSchema = Joi.object({
  label: Joi.string().trim().max(100).allow('').optional(),
  items: checkItemsSchema,
});

export const posSaleSchema = Joi.object({
  saleId: Joi.string().uuid().required(),
  restaurantId: Joi.string().uuid().required(),
  registerId: Joi.when('paymentMethod', {
    is: 'cash',
    then: Joi.string().uuid().required(),
    otherwise: Joi.string().uuid().allow(null).optional(),
  }),
  orderType: Joi.string().valid('pickup', 'dine_in').required(),
  paymentMethod: Joi.string().valid('cash', 'card').required(),
  openCheckId: Joi.string().uuid().allow(null).optional(),
  items: Joi.array()
    .items(
      Joi.object({
        menuItemId: Joi.string().uuid().required(),
        quantity: Joi.number().integer().min(1).required(),
        specialInstructions: Joi.string().max(1000).allow('').optional(),
        modifiers: Joi.array()
          .items(
            Joi.object({
              modifierId: Joi.string().uuid().required(),
            })
          )
          .unique('modifierId')
          .optional(),
      })
    )
    .min(1)
    .required(),
});

/** Фабрика не создаёт соединения при импорте — тесты схемы остаются чистыми. */
export const refundSchema = Joi.object({
  refundId: Joi.string().uuid().required(),
  approvalToken: Joi.string().max(2000).required(),
  reason: Joi.string().trim().max(500).allow('').optional(),
  items: Joi.array().items(Joi.object({
    orderItemId: Joi.string().uuid().required(),
    quantity: Joi.number().integer().min(1).max(999).required(),
  })).min(1).max(200).unique('orderItemId').required(),
});

export const paymentChangeSchema = Joi.object({
  refundId: Joi.string().uuid().required(),
  approvalToken: Joi.string().max(2000).required(),
  reason: Joi.string().trim().max(500).allow('').optional(),
  paymentMethod: Joi.string().valid('cash', 'card').required(),
});

export function createPosRouter(
  posSaleService: PosSaleService,
  pool: QueryablePool,
  refunds?: PosRefundService
): Router {
  const router = Router();
  const cashRegisterMiddleware = createCashRegisterSessionMiddleware(pool);

  router.post(
    '/sales',
    authenticateUser,
    requireRole('admin', 'owner', 'manager', 'operator', 'waiter', 'cashier'),
    cashRegisterMiddleware,
    async (req: Request, res: Response) => {
      const { error, value } = posSaleSchema.validate(req.body, { abortEarly: false });
      if (error) {
        return res.status(400).json({
          error: 'Validation error',
          message: error.details.map((detail) => detail.message).join('; '),
        });
      }
      if (!req.enterpriseId || !req.userId) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Для продажи требуется контекст предприятия и кассира',
        });
      }

      try {
        const sale = await posSaleService.create(value, req.enterpriseId, req.userId);
        return res.status(sale.replayed ? 200 : 201).json({ sale });
      } catch (err) {
        if (err instanceof PosSaleError) {
          return res
            .status(err.statusCode)
            .json({ error: 'POS sale rejected', message: err.message });
        }
        console.error('POS sale error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  // ── Отложенные чеки ──────────────────────────────────────────────────
  // Те же права и та же сессия кассы, что у продажи: заблокированный
  // планшет не видит и не правит чеки.
  const checks = new OpenCheckService(pool);
  const POS_ROLES = ['admin', 'owner', 'manager', 'operator', 'waiter', 'cashier'];
  const guard = [authenticateUser, requireRole(...POS_ROLES), cashRegisterMiddleware];

  const tenant = (req: Request, res: Response): boolean => {
    // Не-UUID в пути иначе долетает до Postgres и превращается в 500
    if (req.params.id && Joi.string().uuid().validate(req.params.id).error) {
      res.status(400).json({ error: 'Validation error', message: 'Некорректный id чека' });
      return false;
    }
    if (!req.enterpriseId || !req.userId) {
      res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия и кассира' });
      return false;
    }
    return true;
  };

  router.get('/checks', ...guard, async (req: Request, res: Response) => {
    if (!tenant(req, res)) return;
    try {
      const list = await checks.list(req.enterpriseId!, req.query.restaurantId as string | undefined);
      return res.json({ checks: list });
    } catch (err) {
      console.error('List open checks error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/checks', ...guard, async (req: Request, res: Response) => {
    const { error, value } = openCheckCreateSchema.validate(req.body);
    if (error) return res.status(400).json({ error: 'Validation error', message: error.details[0].message });
    if (!tenant(req, res)) return;
    try {
      const check = await checks.create(req.enterpriseId!, req.userId!, value);
      if (!check) return res.status(404).json({ error: 'Not found', message: 'Точка не найдена в вашей организации' });
      return res.status(201).json({ check });
    } catch (err) {
      console.error('Create open check error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/checks/:id', ...guard, async (req: Request, res: Response) => {
    const { error, value } = openCheckUpdateSchema.validate(req.body);
    if (error) return res.status(400).json({ error: 'Validation error', message: error.details[0].message });
    if (!tenant(req, res)) return;
    try {
      const check = await checks.update(req.enterpriseId!, req.userId!, req.params.id, value);
      if (!check) return res.status(404).json({ error: 'Not found', message: 'Чек не найден или уже закрыт' });
      return res.json({ check });
    } catch (err) {
      console.error('Update open check error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/checks/:id', ...guard, async (req: Request, res: Response) => {
    if (!tenant(req, res)) return;
    try {
      const ok = await checks.cancel(req.enterpriseId!, req.userId!, req.params.id);
      if (!ok) return res.status(404).json({ error: 'Not found', message: 'Чек не найден или уже закрыт' });
      return res.json({ success: true });
    } catch (err) {
      console.error('Cancel open check error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Чеки смены: просмотр, возврат, смена оплаты ─────────────────────
  // Возврат и смену оплаты подтверждает PIN владельца/админа (допуск из
  // POST /api/auth/cash-register/approve). Кассир один деньги не вернёт.
  if (refunds) {
    const refundErr = (res: Response, err: any, what: string) => {
      if (err instanceof PosRefundError) return res.status(err.statusCode).json({ error: 'Rejected', message: err.message });
      console.error(what, err);
      return res.status(500).json({ error: 'Internal server error' });
    };

    router.get('/receipts', ...guard, async (req: Request, res: Response) => {
      if (!tenant(req, res)) return;
      const q = Joi.object({
        restaurantId: Joi.string().uuid().required(),
        date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
        search: Joi.string().max(40).allow('').optional(),
      }).validate(req.query);
      if (q.error) return res.status(400).json({ error: 'Validation error', message: q.error.details[0].message });
      try {
        const receipts = await refunds.list(req.enterpriseId!, q.value.restaurantId, q.value.date, q.value.search || undefined);
        return res.json({ receipts });
      } catch (err) { return refundErr(res, err, 'List receipts error:'); }
    });

    const withApproval = (action: 'refund' | 'payment_change', req: Request) =>
      refunds.verifyApproval(req.body.approvalToken, {
        enterpriseId: req.enterpriseId!, cashierId: req.userId!,
        sessionId: (req as any).registerSession?.id, action,
      });

    router.post('/receipts/:id/refund', ...guard, async (req: Request, res: Response) => {
      if (!tenant(req, res)) return;
      const { error, value } = refundSchema.validate(req.body);
      if (error) return res.status(400).json({ error: 'Validation error', message: error.details[0].message });
      try {
        const approval = withApproval('refund', req);
        const r = await refunds.refund({ enterpriseId: req.enterpriseId!, cashierId: req.userId!, orderId: req.params.id,
          refundId: value.refundId, approval, items: value.items, reason: value.reason });
        return res.status(r.replayed ? 200 : 201).json({ refund: r });
      } catch (err) { return refundErr(res, err, 'Refund error:'); }
    });

    router.post('/receipts/:id/payment-method', ...guard, async (req: Request, res: Response) => {
      if (!tenant(req, res)) return;
      const { error, value } = paymentChangeSchema.validate(req.body);
      if (error) return res.status(400).json({ error: 'Validation error', message: error.details[0].message });
      try {
        const approval = withApproval('payment_change', req);
        const r = await refunds.changePayment({ enterpriseId: req.enterpriseId!, cashierId: req.userId!, orderId: req.params.id,
          refundId: value.refundId, approval, paymentMethod: value.paymentMethod, reason: value.reason });
        return res.status(r.replayed ? 200 : 201).json({ change: r });
      } catch (err) { return refundErr(res, err, 'Payment change error:'); }
    });
  }

  return router;
}

export default createPosRouter;
