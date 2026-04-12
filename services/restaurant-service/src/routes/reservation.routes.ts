import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { ReservationService, OverlapError, ValidationError } from '../services/reservation.service';
import { authenticateUser } from '../middleware/auth.middleware';
import { config } from '../config';

const router = Router();
const reservationService = new ReservationService(config.database.url);

const createReservationSchema = Joi.object({
  restaurantId: Joi.string().uuid().required(),
  tableId: Joi.string().uuid().allow(null).optional(),
  customerName: Joi.string().min(1).max(255).required(),
  customerPhone: Joi.string().min(1).max(50).required(),
  customerEmail: Joi.string().email().allow('', null).optional(),
  partySize: Joi.number().integer().min(1).required(),
  reservationDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required()
    .messages({ 'string.pattern.base': 'reservationDate must be in YYYY-MM-DD format' }),
  reservationTime: Joi.string().pattern(/^\d{2}:\d{2}(:\d{2})?$/).required()
    .messages({ 'string.pattern.base': 'reservationTime must be in HH:MM or HH:MM:SS format' }),
  durationMinutes: Joi.number().integer().min(15).max(480).optional(),
  depositAmount: Joi.number().min(0).optional(),
  notes: Joi.string().max(2000).allow('', null).optional()
});

const updateStatusSchema = Joi.object({
  status: Joi.string().valid('pending', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show').required()
});

// List reservations
router.get('/', authenticateUser, async (req: Request, res: Response) => {
  try {
    const restaurantId = req.query.restaurantId as string;
    if (!restaurantId) {
      return res.status(400).json({ error: 'Validation error', message: 'restaurantId query parameter is required' });
    }

    const reservations = await reservationService.list({
      restaurantId,
      enterpriseId: req.enterpriseId,
      date: req.query.date as string,
      status: req.query.status as string
    });
    return res.json({ reservations });
  } catch (error) {
    console.error('List reservations error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Get reservation by ID
router.get('/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const reservation = await reservationService.getById(req.params.id, req.enterpriseId);
    if (!reservation) {
      return res.status(404).json({ error: 'Reservation not found' });
    }
    return res.json({ reservation });
  } catch (error) {
    console.error('Get reservation error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Create reservation
router.post('/', authenticateUser, async (req: Request, res: Response) => {
  try {
    const { error, value } = createReservationSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: 'Validation error', message: error.details[0].message });
    }

    const reservation = await reservationService.create({
      ...value,
      enterpriseId: req.enterpriseId,
      createdBy: req.userId!
    });
    return res.status(201).json({ reservation });
  } catch (error) {
    if (error instanceof OverlapError) {
      return res.status(409).json({ error: 'Conflict', message: error.message });
    }
    console.error('Create reservation error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Update reservation status
router.put('/:id/status', authenticateUser, async (req: Request, res: Response) => {
  try {
    const { error, value } = updateStatusSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: 'Validation error', message: error.details[0].message });
    }

    const reservation = await reservationService.updateStatus(req.params.id, value.status, req.enterpriseId);
    if (!reservation) {
      return res.status(404).json({ error: 'Reservation not found' });
    }
    return res.json({ reservation });
  } catch (error) {
    if (error instanceof ValidationError) {
      return res.status(400).json({ error: 'Validation error', message: error.message });
    }
    console.error('Update reservation status error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Cancel reservation (soft delete)
router.delete('/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const reservation = await reservationService.cancel(req.params.id, req.enterpriseId);
    if (!reservation) {
      return res.status(404).json({ error: 'Reservation not found' });
    }
    return res.json({ reservation });
  } catch (error) {
    if (error instanceof ValidationError) {
      return res.status(400).json({ error: 'Validation error', message: error.message });
    }
    console.error('Cancel reservation error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
