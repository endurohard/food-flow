import { Router } from 'express';
import Joi from 'joi';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import pkg from 'pg';
const { Pool } = pkg;
import { EnterpriseService } from '../services/enterprise.service';
import {
  authenticateUser,
  enterpriseContext,
  requireEnterpriseRole,
  requirePermission,
  requireSuperAdmin
} from '../middleware/enterprise.middleware';
import { config } from '../config';

const createEnterpriseSchema = Joi.object({
  name: Joi.string().min(1).max(200).required(),
  legal_name: Joi.string().max(200).allow('', null),
  tax_id: Joi.string().max(50).allow('', null),
  phone: Joi.string().max(20).allow('', null),
  email: Joi.string().email().allow('', null),
  website: Joi.string().max(200).allow('', null),
  business_type: Joi.string().valid('restaurant', 'cafe', 'coffee_shop', 'production').default('restaurant'),
  owner: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().min(8).max(100).required(),
    firstName: Joi.string().min(1).max(100).required(),
    lastName: Joi.string().max(100).allow('', null),
    phone: Joi.string().max(20).allow('', null)
  }).required()
});

const router = Router();
const enterpriseService = new EnterpriseService(config.database.url);
const pool = new Pool({ connectionString: config.database.url });

/**
 * @swagger
 * /api/enterprises:
 *   post:
 *     summary: Create a new enterprise
 *     tags: [Enterprises]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *               legal_name:
 *                 type: string
 *               tax_id:
 *                 type: string
 *               phone:
 *                 type: string
 *               email:
 *                 type: string
 *               website:
 *                 type: string
 *     responses:
 *       201:
 *         description: Enterprise created successfully
 */
router.post('/', authenticateUser, requireSuperAdmin, async (req, res) => {
  try {
    const { error, value } = createEnterpriseSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: 'Validation error', message: error.message });
    }
    const { owner, ...enterpriseData } = value;
    const result = await enterpriseService.createEnterpriseWithOwner(enterpriseData, owner);

    return res.status(201).json({
      success: true,
      enterprise: result.enterprise,
      owner: result.owner
    });
  } catch (error: any) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error('Failed to create enterprise:', error);
    return res.status(status).json({
      error: status >= 500 ? 'Failed to create enterprise' : error.message,
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/enterprises:
 *   get:
 *     summary: List all enterprises (super-admin only)
 *     tags: [Enterprises]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: All enterprises retrieved successfully
 */
router.get('/', authenticateUser, requireSuperAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const offset = parseInt(req.query.offset as string) || 0;
    const result = await enterpriseService.getAllEnterprises(limit, offset);
    return res.json({ success: true, ...result });
  } catch (error: any) {
    console.error('Failed to list enterprises:', error);
    return res.status(500).json({ error: 'Failed to list enterprises', message: error.message });
  }
});

// ═══════════════════ Super-admin management ═══════════════════
// Все ниже — только super_admin (requireSuperAdmin), без enterpriseContext.

function genPassword(): string {
  return crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) + '1a';
}

// Этап 1: сброс пароля владельцу организации
router.post('/:id/reset-owner-password', authenticateUser, requireSuperAdmin, async (req, res) => {
  try {
    const owner = await enterpriseService.getEnterpriseOwner(req.params.id);
    if (!owner) return res.status(404).json({ error: 'У организации нет владельца' });
    const provided = (req.body?.newPassword || '').trim();
    if (provided && provided.length < 8) return res.status(400).json({ error: 'Пароль минимум 8 символов' });
    const newPassword = provided || genPassword();
    await enterpriseService.resetMemberPassword(req.params.id, owner.userId, newPassword);
    return res.json({ success: true, ownerEmail: owner.email, newPassword });
  } catch (error: any) {
    console.error('reset-owner-password:', error);
    return res.status(500).json({ error: 'Не удалось сбросить пароль' });
  }
});

// Этап 2: редактирование организации супер-админом
router.patch('/:id', authenticateUser, requireSuperAdmin, async (req, res) => {
  try {
    const enterprise = await enterpriseService.updateEnterprise(req.params.id, req.body);
    return res.json({ success: true, enterprise });
  } catch (error: any) {
    if (error.message === 'Enterprise not found') return res.status(404).json({ error: error.message });
    console.error('super-admin patch enterprise:', error);
    return res.status(500).json({ error: 'Не удалось обновить организацию' });
  }
});

// Этап 3: пользователи организации + сброс пароля любому + деактивация
router.get('/:id/members', authenticateUser, requireSuperAdmin, async (req, res) => {
  try {
    const members = await enterpriseService.listEnterpriseMembers(req.params.id);
    return res.json({ success: true, members });
  } catch (error: any) {
    console.error('list members:', error);
    return res.status(500).json({ error: 'Не удалось получить пользователей' });
  }
});

router.post('/:id/members/:userId/reset-password', authenticateUser, requireSuperAdmin, async (req, res) => {
  try {
    const provided = (req.body?.newPassword || '').trim();
    if (provided && provided.length < 8) return res.status(400).json({ error: 'Пароль минимум 8 символов' });
    const newPassword = provided || genPassword();
    const ok = await enterpriseService.resetMemberPassword(req.params.id, req.params.userId, newPassword);
    if (!ok) return res.status(404).json({ error: 'Пользователь не найден в этой организации' });
    return res.json({ success: true, newPassword });
  } catch (error: any) {
    console.error('reset member password:', error);
    return res.status(500).json({ error: 'Не удалось сбросить пароль' });
  }
});

router.patch('/:id/members/:userId', authenticateUser, requireSuperAdmin, async (req, res) => {
  try {
    if (typeof req.body?.isActive !== 'boolean') return res.status(400).json({ error: 'isActive (boolean) обязателен' });
    const ok = await enterpriseService.setMemberActive(req.params.id, req.params.userId, req.body.isActive);
    if (!ok) return res.status(404).json({ error: 'Пользователь не найден в этой организации' });
    return res.json({ success: true });
  } catch (error: any) {
    console.error('set member active:', error);
    return res.status(500).json({ error: 'Не удалось обновить пользователя' });
  }
});

// Этап 4: «Войти в организацию» — impersonation-токен (супер-админ действует
// как владелец: role=restaurant_owner + enterpriseId → работает tenant-scope)
router.post('/:id/impersonate', authenticateUser, requireSuperAdmin, async (req, res) => {
  try {
    const enterprise = await enterpriseService.getEnterpriseById(req.params.id);
    if (!enterprise) return res.status(404).json({ error: 'Организация не найдена' });
    const owner = await enterpriseService.getEnterpriseOwner(req.params.id);
    const impUserId = owner ? owner.userId : req.userId!;
    const impEmail = owner ? owner.email : 'superadmin';
    const accessToken = jwt.sign(
      {
        userId: impUserId,
        email: impEmail,
        role: 'restaurant_owner',
        enterpriseId: req.params.id,
        enterpriseRole: 'owner',
        impersonatedBy: req.userId
      },
      config.jwt.secret,
      { expiresIn: config.jwt.accessExpiresIn } as jwt.SignOptions
    );
    return res.json({
      success: true,
      accessToken,
      user: {
        userId: impUserId, email: impEmail, role: 'restaurant_owner',
        enterpriseId: req.params.id, enterpriseRole: 'owner',
        first_name: enterprise.name, enterpriseName: enterprise.name
      },
      enterprise
    });
  } catch (error: any) {
    console.error('impersonate:', error);
    return res.status(500).json({ error: 'Не удалось войти в организацию' });
  }
});

/**
 * @swagger
 * /api/enterprises/my:
 *   get:
 *     summary: Get current user's enterprises
 *     tags: [Enterprises]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User enterprises retrieved successfully
 */
router.get('/my', authenticateUser, async (req, res) => {
  try {
    const enterprises = await enterpriseService.getUserEnterprises(req.userId!);

    return res.json({
      success: true,
      enterprises
    });
  } catch (error: any) {
    console.error('Failed to get user enterprises:', error);
    return res.status(500).json({
      error: 'Failed to get enterprises',
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/enterprises/{id}:
 *   get:
 *     summary: Get enterprise by ID
 *     tags: [Enterprises]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Enterprise retrieved successfully
 */
router.get(
  '/:id',
  authenticateUser,
  enterpriseContext(enterpriseService),
  async (req, res) => {
    try {
      const { id } = req.params;

      // Verify user has access
      const hasAccess = await enterpriseService.checkUserAccess(
        req.userId!,
        id
      );

      if (!hasAccess) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'You do not have access to this enterprise'
        });
      }

      const enterprise = await enterpriseService.getEnterpriseById(id);

      if (!enterprise) {
        return res.status(404).json({
          error: 'Enterprise not found'
        });
      }

      return res.json({
        success: true,
        enterprise
      });
    } catch (error: any) {
      console.error('Failed to get enterprise:', error);
      return res.status(500).json({
        error: 'Failed to get enterprise',
        message: error.message
      });
    }
  }
);

/**
 * @swagger
 * /api/enterprises/{id}:
 *   put:
 *     summary: Update enterprise
 *     tags: [Enterprises]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
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
 *     responses:
 *       200:
 *         description: Enterprise updated successfully
 */
router.put(
  '/:id',
  authenticateUser,
  enterpriseContext(enterpriseService),
  requireEnterpriseRole('owner', 'admin'),
  async (req, res) => {
    try {
      const { id } = req.params;

      const enterprise = await enterpriseService.updateEnterprise(id, req.body);

      return res.json({
        success: true,
        enterprise
      });
    } catch (error: any) {
      console.error('Failed to update enterprise:', error);
      return res.status(500).json({
        error: 'Failed to update enterprise',
        message: error.message
      });
    }
  }
);

/**
 * @swagger
 * /api/enterprises/{id}:
 *   delete:
 *     summary: Delete enterprise (soft delete)
 *     tags: [Enterprises]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Enterprise deleted successfully
 */
router.delete(
  '/:id',
  authenticateUser,
  enterpriseContext(enterpriseService),
  requireEnterpriseRole('owner'),
  async (req, res) => {
    try {
      const { id } = req.params;

      await enterpriseService.deleteEnterprise(id);

      return res.json({
        success: true,
        message: 'Enterprise deleted successfully'
      });
    } catch (error: any) {
      console.error('Failed to delete enterprise:', error);
      return res.status(500).json({
        error: 'Failed to delete enterprise',
        message: error.message
      });
    }
  }
);

/**
 * @swagger
 * /api/enterprises/{id}/users:
 *   get:
 *     summary: Get enterprise users
 *     tags: [Enterprises]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Enterprise users retrieved successfully
 */
router.get(
  '/:id/users',
  authenticateUser,
  enterpriseContext(enterpriseService),
  async (req, res) => {
    try {
      const { id } = req.params;

      const users = await enterpriseService.getEnterpriseUsers(id);

      return res.json({
        success: true,
        users
      });
    } catch (error: any) {
      console.error('Failed to get enterprise users:', error);
      return res.status(500).json({
        error: 'Failed to get enterprise users',
        message: error.message
      });
    }
  }
);

/**
 * @swagger
 * /api/enterprises/{id}/users:
 *   post:
 *     summary: Add user to enterprise
 *     tags: [Enterprises]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
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
 *             required: [userId, role]
 *             properties:
 *               userId:
 *                 type: string
 *                 format: uuid
 *               role:
 *                 type: string
 *                 enum: [owner, admin, manager, employee, viewer]
 *               permissions:
 *                 type: object
 *     responses:
 *       201:
 *         description: User added to enterprise successfully
 */
router.post(
  '/:id/users',
  authenticateUser,
  enterpriseContext(enterpriseService),
  requireEnterpriseRole('owner', 'admin'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { userId, role, permissions } = req.body;

      if (!userId || !role) {
        return res.status(400).json({
          error: 'Missing required fields',
          message: 'userId and role are required'
        });
      }

      const enterpriseUser = await enterpriseService.addUserToEnterprise(
        id,
        userId,
        role,
        permissions
      );

      return res.status(201).json({
        success: true,
        enterpriseUser
      });
    } catch (error: any) {
      console.error('Failed to add user to enterprise:', error);
      return res.status(500).json({
        error: 'Failed to add user to enterprise',
        message: error.message
      });
    }
  }
);

/**
 * @swagger
 * /api/enterprises/{id}/users/{userId}:
 *   put:
 *     summary: Update user role in enterprise
 *     tags: [Enterprises]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
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
 *             required: [role]
 *             properties:
 *               role:
 *                 type: string
 *               permissions:
 *                 type: object
 *     responses:
 *       200:
 *         description: User role updated successfully
 */
router.put(
  '/:id/users/:userId',
  authenticateUser,
  enterpriseContext(enterpriseService),
  requireEnterpriseRole('owner', 'admin'),
  async (req, res) => {
    try {
      const { id, userId } = req.params;
      const { role, permissions } = req.body;

      if (!role) {
        return res.status(400).json({
          error: 'Missing required field: role'
        });
      }

      const enterpriseUser = await enterpriseService.updateUserRole(
        id,
        userId,
        role,
        permissions
      );

      return res.json({
        success: true,
        enterpriseUser
      });
    } catch (error: any) {
      console.error('Failed to update user role:', error);
      return res.status(500).json({
        error: 'Failed to update user role',
        message: error.message
      });
    }
  }
);

/**
 * @swagger
 * /api/enterprises/{id}/users/{userId}:
 *   delete:
 *     summary: Remove user from enterprise
 *     tags: [Enterprises]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: User removed from enterprise successfully
 */
router.delete(
  '/:id/users/:userId',
  authenticateUser,
  enterpriseContext(enterpriseService),
  requireEnterpriseRole('owner', 'admin'),
  async (req, res) => {
    try {
      const { id, userId } = req.params;

      await enterpriseService.removeUserFromEnterprise(id, userId);

      return res.json({
        success: true,
        message: 'User removed from enterprise successfully'
      });
    } catch (error: any) {
      console.error('Failed to remove user from enterprise:', error);
      return res.status(500).json({
        error: 'Failed to remove user from enterprise',
        message: error.message
      });
    }
  }
);

/**
 * @swagger
 * /api/enterprises/{id}/stats:
 *   get:
 *     summary: Get enterprise statistics
 *     tags: [Enterprises]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Enterprise statistics retrieved successfully
 */
router.get(
  '/:id/stats',
  authenticateUser,
  enterpriseContext(enterpriseService),
  async (req, res) => {
    try {
      const { id } = req.params;

      const stats = await enterpriseService.getEnterpriseStats(id);

      return res.json({
        success: true,
        stats
      });
    } catch (error: any) {
      console.error('Failed to get enterprise stats:', error);
      return res.status(500).json({
        error: 'Failed to get enterprise stats',
        message: error.message
      });
    }
  }
);

// ============================================================
// Chain Management (Phase 9)
// ============================================================

/**
 * GET /api/enterprises/:id/restaurants
 * List all restaurants in the enterprise chain
 */
router.get(
  '/:id/restaurants',
  authenticateUser,
  enterpriseContext(enterpriseService),
  async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query(
        `SELECT r.*, ra.street_address, ra.city,
                (SELECT COUNT(*) FROM orders o WHERE o.restaurant_id = r.id AND o.status = 'completed') as total_orders,
                (SELECT COALESCE(SUM(total), 0) FROM orders o WHERE o.restaurant_id = r.id AND o.status = 'completed') as total_revenue
         FROM restaurants r
         LEFT JOIN restaurant_addresses ra ON ra.restaurant_id = r.id
         WHERE r.enterprise_id = $1 AND r.is_active = true
         ORDER BY r.name`,
        [id]
      );
      return res.json({ success: true, restaurants: result.rows });
    } catch (error: any) {
      console.error('Failed to get chain restaurants:', error);
      return res.status(500).json({ error: 'Failed to get restaurants' });
    }
  }
);

/**
 * GET /api/enterprises/:id/analytics
 * Cross-restaurant analytics for the chain
 */
router.get(
  '/:id/analytics',
  authenticateUser,
  enterpriseContext(enterpriseService),
  async (req, res) => {
    try {
      const { id } = req.params;
      const dateFrom = req.query.dateFrom as string || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const dateTo = req.query.dateTo as string || new Date().toISOString();

      // Summary across all restaurants
      const summary = await pool.query(
        `SELECT
          COUNT(*) as total_orders,
          COALESCE(SUM(total), 0) as total_revenue,
          COALESCE(AVG(total), 0) as average_check,
          COUNT(DISTINCT customer_id) as unique_customers
         FROM orders
         WHERE enterprise_id = $1 AND created_at >= $2 AND created_at <= $3 AND status = 'completed'`,
        [id, dateFrom, dateTo]
      );

      // Per-restaurant breakdown
      const perRestaurant = await pool.query(
        `SELECT r.id, r.name,
          COUNT(o.id) as order_count,
          COALESCE(SUM(o.total), 0) as revenue,
          COALESCE(AVG(o.total), 0) as avg_check
         FROM restaurants r
         LEFT JOIN orders o ON o.restaurant_id = r.id AND o.created_at >= $2 AND o.created_at <= $3 AND o.status = 'completed'
         WHERE r.enterprise_id = $1 AND r.is_active = true
         GROUP BY r.id, r.name
         ORDER BY revenue DESC`,
        [id, dateFrom, dateTo]
      );

      // Daily trend
      const daily = await pool.query(
        `SELECT DATE(created_at) as date,
          COUNT(*) as orders,
          COALESCE(SUM(total), 0) as revenue
         FROM orders
         WHERE enterprise_id = $1 AND created_at >= $2 AND created_at <= $3 AND status = 'completed'
         GROUP BY DATE(created_at)
         ORDER BY date ASC`,
        [id, dateFrom, dateTo]
      );

      return res.json({
        success: true,
        summary: summary.rows[0],
        perRestaurant: perRestaurant.rows,
        daily: daily.rows
      });
    } catch (error: any) {
      console.error('Failed to get chain analytics:', error);
      return res.status(500).json({ error: 'Failed to get analytics' });
    }
  }
);

/**
 * Menu Templates CRUD
 */
router.get(
  '/:id/menu-templates',
  authenticateUser,
  enterpriseContext(enterpriseService),
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT * FROM enterprise_menu_templates WHERE enterprise_id = $1 AND is_active = true ORDER BY name`,
        [req.params.id]
      );
      return res.json({ success: true, templates: result.rows });
    } catch (error: any) {
      return res.status(500).json({ error: 'Failed to get templates' });
    }
  }
);

router.post(
  '/:id/menu-templates',
  authenticateUser,
  enterpriseContext(enterpriseService),
  requireEnterpriseRole('owner', 'admin', 'manager'),
  async (req, res) => {
    try {
      const { name, description, templateData } = req.body;
      if (!name) return res.status(400).json({ error: 'name is required' });

      const result = await pool.query(
        `INSERT INTO enterprise_menu_templates (enterprise_id, name, description, template_data)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [req.params.id, name, description || null, JSON.stringify(templateData || {})]
      );
      return res.status(201).json({ success: true, template: result.rows[0] });
    } catch (error: any) {
      return res.status(500).json({ error: 'Failed to create template' });
    }
  }
);

router.put(
  '/:id/menu-templates/:templateId',
  authenticateUser,
  enterpriseContext(enterpriseService),
  requireEnterpriseRole('owner', 'admin', 'manager'),
  async (req, res) => {
    try {
      const fields: string[] = [];
      const values: any[] = [];
      let p = 1;

      if (req.body.name !== undefined) { fields.push(`name = $${p++}`); values.push(req.body.name); }
      if (req.body.description !== undefined) { fields.push(`description = $${p++}`); values.push(req.body.description); }
      if (req.body.templateData !== undefined) { fields.push(`template_data = $${p++}`); values.push(JSON.stringify(req.body.templateData)); }
      if (req.body.isActive !== undefined) { fields.push(`is_active = $${p++}`); values.push(req.body.isActive); }

      if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

      values.push(req.params.templateId);
      const templateParam = p++;
      values.push(req.enterpriseId);
      // Tenant guard: шаблон должен принадлежать предприятию из контекста,
      // иначе по чужому templateId можно обновить шаблон другого предприятия
      const result = await pool.query(
        `UPDATE enterprise_menu_templates SET ${fields.join(', ')}
         WHERE id = $${templateParam} AND enterprise_id = $${p} RETURNING *`,
        values
      );
      if (!result.rows[0]) return res.status(404).json({ error: 'Template not found' });
      return res.json({ success: true, template: result.rows[0] });
    } catch (error: any) {
      return res.status(500).json({ error: 'Failed to update template' });
    }
  }
);

/**
 * Restaurant benchmarks
 */
router.get(
  '/:id/benchmarks',
  authenticateUser,
  enterpriseContext(enterpriseService),
  async (req, res) => {
    try {
      const dateFrom = req.query.dateFrom as string;
      const dateTo = req.query.dateTo as string;

      let query = `SELECT rb.*, r.name as restaurant_name
         FROM restaurant_benchmarks rb
         INNER JOIN restaurants r ON rb.restaurant_id = r.id
         WHERE rb.enterprise_id = $1`;
      const values: any[] = [req.params.id];
      let p = 2;

      if (dateFrom) { query += ` AND rb.period_date >= $${p++}`; values.push(dateFrom); }
      if (dateTo) { query += ` AND rb.period_date <= $${p++}`; values.push(dateTo); }

      query += ' ORDER BY rb.period_date DESC, r.name';

      const result = await pool.query(query, values);
      return res.json({ success: true, benchmarks: result.rows });
    } catch (error: any) {
      return res.status(500).json({ error: 'Failed to get benchmarks' });
    }
  }
);

export default router;
