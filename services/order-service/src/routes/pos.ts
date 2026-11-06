import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { authenticateUser, requireRole } from '../middleware/auth.middleware';
import {
  createCashRegisterSessionMiddleware,
  QueryablePool,
} from '../middleware/cash-register.middleware';
import { PosSaleError, PosSaleService } from '../services/pos-sale.service';

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
export function createPosRouter(
  posSaleService: PosSaleService,
  pool: QueryablePool
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

  return router;
}

export default createPosRouter;
