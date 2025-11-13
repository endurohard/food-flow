import { Router } from 'express';
import { EnterpriseService } from '../services/enterprise.service';
import {
  authenticateUser,
  enterpriseContext,
  requireEnterpriseRole,
  requirePermission
} from '../middleware/enterprise.middleware';

const router = Router();
const enterpriseService = new EnterpriseService(process.env.DATABASE_URL!);

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
router.post('/', authenticateUser, async (req, res) => {
  try {
    const enterprise = await enterpriseService.createEnterprise(
      req.body,
      req.userId
    );

    return res.status(201).json({
      success: true,
      enterprise
    });
  } catch (error: any) {
    console.error('Failed to create enterprise:', error);
    return res.status(500).json({
      error: 'Failed to create enterprise',
      message: error.message
    });
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

export default router;
