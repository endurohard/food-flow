import { Router, Request, Response } from 'express';
import Joi from 'joi';
import pkg from 'pg';
const { Pool } = pkg;
import { UserService } from '../services/user.service';
import { EnterpriseService } from '../services/enterprise.service';
import {
  authenticateUser,
  enterpriseContext,
  requireEnterpriseRole
} from '../middleware/enterprise.middleware';

import { config } from '../config';
import { logPiiAccess } from '../middleware/pii-audit.middleware';

const router = Router();
const userService = new UserService(config.database.url);
const enterpriseService = new EnterpriseService(config.database.url);

// ── Водители предприятия (управление для отгрузок опта/доставки) ──────────
const driverContext = [
  authenticateUser,
  enterpriseContext(enterpriseService),
  requireEnterpriseRole('owner', 'admin', 'manager')
];

const createDriverSchema = Joi.object({
  firstName: Joi.string().min(1).max(100).required(),
  lastName: Joi.string().max(100).allow('', null).optional(),
  phone: Joi.string().min(10).max(20).required()
});

// Список водителей предприятия (для выпадающего списка при отгрузке)
router.get('/drivers', ...driverContext, async (req: Request, res: Response) => {
  try {
    const drivers = await userService.listDrivers(req.enterpriseId!);
    return res.json({ drivers });
  } catch (error: any) {
    console.error('Failed to list drivers:', error);
    return res.status(500).json({ error: 'Failed to list drivers' });
  }
});

// Добавить водителя (веб-учётка служебная, вход — через Telegram-бот по телефону)
router.post('/drivers', ...driverContext, async (req: Request, res: Response) => {
  try {
    const { error, value } = createDriverSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    const driver = await userService.createDriver(req.enterpriseId!, value);
    return res.status(201).json({ driver });
  } catch (error: any) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error('Failed to create driver:', error);
    return res.status(status).json({ error: status >= 500 ? 'Не удалось создать водителя' : error.message });
  }
});

// Активировать / деактивировать водителя
router.patch('/drivers/:driverId', ...driverContext, async (req: Request, res: Response) => {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive (boolean) обязателен' });
    }
    const driver = await userService.setDriverActive(req.enterpriseId!, req.params.driverId, isActive);
    return res.json({ driver });
  } catch (error: any) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error('Failed to update driver:', error);
    return res.status(status).json({ error: status >= 500 ? 'Не удалось обновить водителя' : error.message });
  }
});

// Pool for PBX queries (preserving existing functionality)
const pool = new Pool({ connectionString: config.database.url });

// Validation schemas
const updateProfileSchema = Joi.object({
  firstName: Joi.string().min(1).max(100).optional(),
  lastName: Joi.string().min(1).max(100).optional(),
  phone: Joi.string().max(20).allow('', null).optional()
});

const createAddressSchema = Joi.object({
  title: Joi.string().max(100).optional(),
  streetAddress: Joi.string().max(255).required(),
  city: Joi.string().max(100).required(),
  state: Joi.string().max(100).optional(),
  postalCode: Joi.string().max(20).optional(),
  country: Joi.string().max(100).required(),
  latitude: Joi.number().min(-90).max(90).optional(),
  longitude: Joi.number().min(-180).max(180).optional(),
  isDefault: Joi.boolean().optional()
});

/**
 * @swagger
 * /api/users:
 *   get:
 *     summary: Get all users (admin only)
 *     tags: [Users]
 *     responses:
 *       200:
 *         description: Users list retrieved successfully
 */
router.get('/', authenticateUser, logPiiAccess('users', ['email', 'phone', 'pbx_extension']), async (req: Request, res: Response) => {
  try {
    const isSuper = req.userRole === 'super_admin';
    // Tenant isolation: обычный запрос отдаёт только пользователей своего
    // предприятия. Без super_admin и без enterprise-контекста — отказ,
    // иначе endpoint утёк бы всех пользователей всех предприятий.
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }

    const conds: string[] = [];
    const values: any[] = [];
    if (!isSuper) {
      values.push(req.enterpriseId);
      conds.push(`enterprise_id = $${values.length}`);
    }
    if (req.query.role) {
      values.push(req.query.role);
      conds.push(`role = $${values.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT id, email, first_name, last_name, phone, role,
              pbx_extension, pbx_username, pbx_display_name
       FROM users
       ${where}
       ORDER BY created_at DESC`,
      values
    );

    return res.json({ users: result.rows });
  } catch (error: any) {
    console.error('Failed to get users:', error);
    return res.status(500).json({ error: 'Failed to get users' });
  }
});

/**
 * @swagger
 * /api/users/profile:
 *   get:
 *     summary: Get current user profile
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User profile retrieved successfully
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: User not found
 */
router.get('/profile', authenticateUser, logPiiAccess('users', ['email', 'phone']), async (req: Request, res: Response) => {
  try {
    const profile = await userService.getProfile(req.userId!);

    if (!profile) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({ user: profile });
  } catch (error) {
    console.error('Get profile error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/users/profile:
 *   put:
 *     summary: Update current user profile
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               firstName:
 *                 type: string
 *               lastName:
 *                 type: string
 *               phone:
 *                 type: string
 *     responses:
 *       200:
 *         description: Profile updated successfully
 *       401:
 *         description: Unauthorized
 */
router.put('/profile', authenticateUser, async (req: Request, res: Response) => {
  try {
    const { error, value } = updateProfileSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Validation error',
        message: error.details[0].message
      });
    }

    const profile = await userService.updateProfile(req.userId!, value);

    if (!profile) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({ user: profile });
  } catch (error) {
    console.error('Update profile error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/users/addresses:
 *   get:
 *     summary: Get user addresses
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Addresses retrieved successfully
 *       401:
 *         description: Unauthorized
 */
router.get('/addresses', authenticateUser, async (req: Request, res: Response) => {
  try {
    const addresses = await userService.getAddresses(req.userId!);
    return res.json({ addresses });
  } catch (error) {
    console.error('Get addresses error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/users/addresses:
 *   post:
 *     summary: Add new address
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [streetAddress, city, country]
 *             properties:
 *               title:
 *                 type: string
 *               streetAddress:
 *                 type: string
 *               city:
 *                 type: string
 *               state:
 *                 type: string
 *               postalCode:
 *                 type: string
 *               country:
 *                 type: string
 *               latitude:
 *                 type: number
 *               longitude:
 *                 type: number
 *               isDefault:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Address added successfully
 *       401:
 *         description: Unauthorized
 */
router.post('/addresses', authenticateUser, async (req: Request, res: Response) => {
  try {
    const { error, value } = createAddressSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Validation error',
        message: error.details[0].message
      });
    }

    const address = await userService.createAddress(req.userId!, value);
    return res.status(201).json({ address });
  } catch (error) {
    console.error('Create address error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/users/addresses/{addressId}:
 *   put:
 *     summary: Update address
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: addressId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Address updated
 *       404:
 *         description: Address not found
 */
router.put('/addresses/:addressId', authenticateUser, async (req: Request, res: Response) => {
  try {
    const address = await userService.updateAddress(req.userId!, req.params.addressId, req.body);

    if (!address) {
      return res.status(404).json({ error: 'Address not found' });
    }

    return res.json({ address });
  } catch (error) {
    console.error('Update address error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/users/addresses/{addressId}:
 *   delete:
 *     summary: Delete address
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: addressId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Address deleted
 *       404:
 *         description: Address not found
 */
router.delete('/addresses/:addressId', authenticateUser, async (req: Request, res: Response) => {
  try {
    const deleted = await userService.deleteAddress(req.userId!, req.params.addressId);

    if (!deleted) {
      return res.status(404).json({ error: 'Address not found' });
    }

    return res.json({ message: 'Address deleted successfully' });
  } catch (error) {
    console.error('Delete address error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// PBX Settings (preserved from existing implementation)
// ============================================================

/**
 * @swagger
 * /api/users/{userId}/pbx-settings:
 *   get:
 *     summary: Get user PBX settings
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: PBX settings retrieved successfully
 */
router.get('/:userId/pbx-settings', authenticateUser, logPiiAccess('users', ['pbx_extension', 'pbx_username', 'pbx_password', 'pbx_ws_password']), async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const isSuper = req.userRole === 'super_admin';
    const isSelf = req.userId === userId;
    // Чужие PBX/SIP-креды доступны только в рамках своего предприятия
    if (!isSuper && !isSelf && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const scoped = !isSuper && !isSelf;
    const result = await pool.query(
      `SELECT pbx_extension, pbx_username, pbx_password, pbx_display_name, pbx_ws_password
       FROM users
       WHERE id = $1${scoped ? ' AND enterprise_id = $2' : ''}`,
      scoped ? [userId, req.enterpriseId] : [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json(result.rows[0]);
  } catch (error: any) {
    console.error('Failed to get user PBX settings:', error);
    return res.status(500).json({ error: 'Failed to get PBX settings' });
  }
});

/**
 * @swagger
 * /api/users/{userId}/pbx-settings:
 *   put:
 *     summary: Update user PBX settings
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               pbx_extension:
 *                 type: string
 *               pbx_username:
 *                 type: string
 *               pbx_password:
 *                 type: string
 *               pbx_display_name:
 *                 type: string
 *     responses:
 *       200:
 *         description: PBX settings updated successfully
 */
router.put('/:userId/pbx-settings', authenticateUser, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const isSuper = req.userRole === 'super_admin';
    // Только админ (в рамках своего предприятия) или платформенный супер-админ
    if (!isSuper && req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Forbidden', message: 'Admin role required' });
    }
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    const {
      pbx_extension,
      pbx_username,
      pbx_password,
      pbx_display_name,
      pbx_ws_password
    } = req.body;

    const scoped = !isSuper;
    const result = await pool.query(
      `UPDATE users
       SET pbx_extension = $1, pbx_username = $2, pbx_password = $3,
           pbx_display_name = $4, pbx_ws_password = $5, updated_at = CURRENT_TIMESTAMP
       WHERE id = $6${scoped ? ' AND enterprise_id = $7' : ''}
       RETURNING id, pbx_extension, pbx_username, pbx_display_name`,
      scoped
        ? [pbx_extension, pbx_username, pbx_password, pbx_display_name, pbx_ws_password, userId, req.enterpriseId]
        : [pbx_extension, pbx_username, pbx_password, pbx_display_name, pbx_ws_password, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({ success: true, user: result.rows[0] });
  } catch (error: any) {
    console.error('Failed to update user PBX settings:', error);
    return res.status(500).json({ error: 'Failed to update PBX settings' });
  }
});

export default router;
