import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { HRService } from '../services/hr.service';
import { authenticateUser, requireRole } from '../middleware/auth.middleware';
import { config } from '../config';

const router = Router();
const hrService = new HRService(config.database.url);

// ========== STAFF ==========
router.get('/staff', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const staff = await hrService.listStaff({
      enterpriseId: req.enterpriseId, position: req.query.position as string,
      isActive: req.query.isActive !== 'false'
    });
    return res.json({ staff });
  } catch (error) { console.error('List staff error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/staff/:userId', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const profile = await hrService.getStaffProfile(req.params.userId, req.enterpriseId);
    if (!profile) return res.status(404).json({ error: 'Staff profile not found' });
    return res.json({ profile });
  } catch (error) { console.error('Get staff error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/staff', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const schema = Joi.object({
      userId: Joi.string().uuid().required(),
      position: Joi.string().max(100).optional(), department: Joi.string().max(100).optional(),
      hireDate: Joi.string().optional(), hourlyRate: Joi.number().min(0).optional(),
      monthlySalary: Joi.number().min(0).optional(), notes: Joi.string().optional()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    const profile = await hrService.createStaffProfile(value, req.enterpriseId);
    return res.status(201).json({ profile });
  } catch (error) { console.error('Create staff error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

router.put('/staff/:userId', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const profile = await hrService.updateStaffProfile(req.params.userId, req.body, req.enterpriseId);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    return res.json({ profile });
  } catch (error) { console.error('Update staff error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

// ========== SCHEDULES ==========
router.get('/schedules', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const schedules = await hrService.getSchedules({
      userId: req.query.userId as string, restaurantId: req.query.restaurantId as string,
      dateFrom: req.query.dateFrom as string, dateTo: req.query.dateTo as string
    });
    return res.json({ schedules });
  } catch (error) { console.error('Get schedules error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/schedules', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const schema = Joi.object({
      userId: Joi.string().uuid().required(), restaurantId: Joi.string().uuid().optional(),
      shiftDate: Joi.string().required(), startTime: Joi.string().required(),
      endTime: Joi.string().required(), breakMinutes: Joi.number().integer().min(0).optional(),
      notes: Joi.string().optional()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    const schedule = await hrService.createSchedule(value, req.enterpriseId);
    return res.status(201).json({ schedule });
  } catch (error) { console.error('Create schedule error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

router.put('/schedules/:id', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const schedule = await hrService.updateSchedule(req.params.id, req.body, req.enterpriseId);
    if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
    return res.json({ schedule });
  } catch (error) { console.error('Update schedule error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

router.delete('/schedules/:id', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const deleted = await hrService.deleteSchedule(req.params.id, req.enterpriseId);
    if (!deleted) return res.status(404).json({ error: 'Schedule not found' });
    return res.json({ message: 'Schedule deleted' });
  } catch (error) { console.error('Delete schedule error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

// ========== TIME CLOCK ==========
router.post('/clock-in', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator', 'chef', 'waiter', 'employee'), async (req: Request, res: Response) => {
  try {
    const entry = await hrService.clockIn(req.userId!, req.body.restaurantId, req.enterpriseId);
    return res.status(201).json({ entry });
  } catch (error: any) {
    if (error.message === 'Already clocked in') return res.status(400).json({ error: error.message });
    console.error('Clock in error:', error); return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/clock-out', authenticateUser, requireRole('admin', 'owner', 'manager', 'operator', 'chef', 'waiter', 'employee'), async (req: Request, res: Response) => {
  try {
    const entry = await hrService.clockOut(req.userId!);
    if (!entry) return res.status(400).json({ error: 'No active clock-in found' });
    return res.json({ entry });
  } catch (error) { console.error('Clock out error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/time-entries', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const entries = await hrService.getTimeEntries({
      userId: req.query.userId as string || req.userId,
      dateFrom: req.query.dateFrom as string, dateTo: req.query.dateTo as string
    });
    return res.json({ entries });
  } catch (error) { console.error('Get entries error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

// ========== PAYROLL ==========
router.post('/payroll/calculate', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const { userId, periodStart, periodEnd } = req.body;
    if (!userId || !periodStart || !periodEnd) return res.status(400).json({ error: 'userId, periodStart, periodEnd are required' });
    const payroll = await hrService.calculatePayroll(userId, periodStart, periodEnd, req.enterpriseId);
    return res.status(201).json({ payroll });
  } catch (error: any) {
    if (error.message === 'Staff profile not found') return res.status(404).json({ error: error.message });
    console.error('Calculate payroll error:', error); return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/payroll', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const payroll = await hrService.getPayroll({
      userId: req.query.userId as string, enterpriseId: req.enterpriseId,
      status: req.query.status as string
    });
    return res.json({ payroll });
  } catch (error) { console.error('Get payroll error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

router.put('/payroll/:id/approve', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const payroll = await hrService.approvePayroll(req.params.id, req.enterpriseId);
    if (!payroll) return res.status(404).json({ error: 'Payroll not found' });
    return res.json({ payroll });
  } catch (error) { console.error('Approve payroll error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

router.put('/payroll/:id/pay', authenticateUser, requireRole('admin', 'owner', 'manager'), async (req: Request, res: Response) => {
  try {
    const payroll = await hrService.markPayrollPaid(req.params.id, req.enterpriseId);
    if (!payroll) return res.status(404).json({ error: 'Payroll not found' });
    return res.json({ payroll });
  } catch (error) { console.error('Pay payroll error:', error); return res.status(500).json({ error: 'Internal server error' }); }
});

export default router;
