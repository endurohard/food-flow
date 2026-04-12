import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { DeliveryService } from '../services/delivery.service';
import { authenticateUser } from '../middleware/auth.middleware';
import { config } from '../config';

const router = Router();
const deliveryService = new DeliveryService(config.database.url);

// ========== DELIVERIES ==========

router.get('/', authenticateUser, async (req: Request, res: Response) => {
  try {
    const result = await deliveryService.list({
      enterpriseId: req.enterpriseId,
      driverId: req.query.driverId as string || (req.userRole === 'delivery_driver' ? req.userId : undefined),
      status: req.query.status as string,
      restaurantId: req.query.restaurantId as string,
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0
    });
    return res.json(result);
  } catch (error) {
    console.error('List deliveries error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const delivery = await deliveryService.getById(req.params.id, req.enterpriseId);
    if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
    return res.json({ delivery });
  } catch (error) {
    console.error('Get delivery error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', authenticateUser, async (req: Request, res: Response) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId is required' });
    const delivery = await deliveryService.createFromOrder(orderId);
    return res.status(201).json({ delivery });
  } catch (error) {
    console.error('Create delivery error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id/assign', authenticateUser, async (req: Request, res: Response) => {
  try {
    const { driverId } = req.body;
    if (!driverId) return res.status(400).json({ error: 'driverId is required' });
    const delivery = await deliveryService.assignDriver(req.params.id, driverId, req.enterpriseId);
    if (!delivery) return res.status(404).json({ error: 'Delivery not found or access denied' });
    return res.json({ delivery });
  } catch (error) {
    console.error('Assign driver error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id/status', authenticateUser, async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    const validStatuses = ['assigned', 'picked_up', 'in_transit', 'delivered', 'failed'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${validStatuses.join(', ')}` });
    }
    const delivery = await deliveryService.updateStatus(req.params.id, status, req.enterpriseId);
    if (!delivery) return res.status(404).json({ error: 'Delivery not found or access denied' });
    return res.json({ delivery });
  } catch (error) {
    console.error('Update status error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== GPS TRACKING ==========

router.post('/:id/track', authenticateUser, async (req: Request, res: Response) => {
  try {
    const schema = Joi.object({
      latitude: Joi.number().min(-90).max(90).required(),
      longitude: Joi.number().min(-180).max(180).required(),
      speed: Joi.number().min(0).optional(),
      heading: Joi.number().integer().min(0).max(360).optional()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    await deliveryService.updateLocation(req.params.id, value.latitude, value.longitude, value.speed, value.heading);
    return res.json({ message: 'Location updated' });
  } catch (error) {
    console.error('Track error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id/track', authenticateUser, async (req: Request, res: Response) => {
  try {
    const history = await deliveryService.getTrackingHistory(req.params.id);
    return res.json({ tracking: history });
  } catch (error) {
    console.error('Get tracking error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== DRIVERS ==========

router.get('/drivers/available', authenticateUser, async (req: Request, res: Response) => {
  try {
    const drivers = await deliveryService.getAvailableDrivers(req.enterpriseId);
    return res.json({ drivers });
  } catch (error) {
    console.error('Get drivers error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/drivers/shift/start', authenticateUser, async (req: Request, res: Response) => {
  try {
    const shift = await deliveryService.startShift(req.userId!, req.enterpriseId);
    return res.status(201).json({ shift });
  } catch (error) {
    console.error('Start shift error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/drivers/shift/end', authenticateUser, async (req: Request, res: Response) => {
  try {
    const shift = await deliveryService.endShift(req.userId!);
    if (!shift) return res.status(404).json({ error: 'No active shift found' });
    return res.json({ shift });
  } catch (error) {
    console.error('End shift error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ========== DELIVERY ZONES ==========

router.get('/zones', authenticateUser, async (req: Request, res: Response) => {
  try {
    const restaurantId = req.query.restaurantId as string;
    if (!restaurantId) return res.status(400).json({ error: 'restaurantId is required' });
    const zones = await deliveryService.listZones(restaurantId);
    return res.json({ zones });
  } catch (error) {
    console.error('List zones error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/zones', authenticateUser, async (req: Request, res: Response) => {
  try {
    const { restaurantId, ...data } = req.body;
    if (!restaurantId) return res.status(400).json({ error: 'restaurantId is required' });
    const zone = await deliveryService.createZone(restaurantId, data, req.enterpriseId);
    return res.status(201).json({ zone });
  } catch (error) {
    console.error('Create zone error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/zones/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const zone = await deliveryService.updateZone(req.params.id, req.body);
    if (!zone) return res.status(404).json({ error: 'Zone not found' });
    return res.json({ zone });
  } catch (error) {
    console.error('Update zone error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/zones/:id', authenticateUser, async (req: Request, res: Response) => {
  try {
    const deleted = await deliveryService.deleteZone(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Zone not found' });
    return res.json({ message: 'Zone deleted' });
  } catch (error) {
    console.error('Delete zone error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
