import { Router } from 'express';
import pkg from 'pg';
const { Pool } = pkg;

const router = Router();

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

/**
 * @swagger
 * /api/users:
 *   get:
 *     summary: Get all users
 *     tags: [Users]
 *     responses:
 *       200:
 *         description: Users list retrieved successfully
 */
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, first_name, last_name, phone, role,
              pbx_extension, pbx_username, pbx_display_name, pbx_ws_password
       FROM users
       ORDER BY created_at DESC`
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
 *     summary: Get user profile
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User profile retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/profile', (req, res) => {
  // TODO: Implement get profile logic
  res.status(200).json({
    message: 'Get profile endpoint - to be implemented'
  });
});

/**
 * @swagger
 * /api/users/profile:
 *   put:
 *     summary: Update user profile
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
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.put('/profile', (req, res) => {
  // TODO: Implement update profile logic
  res.status(200).json({
    message: 'Update profile endpoint - to be implemented',
    data: req.body
  });
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
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: string
 *                     format: uuid
 *                   title:
 *                     type: string
 *                   streetAddress:
 *                     type: string
 *                   city:
 *                     type: string
 *                   isDefault:
 *                     type: boolean
 *       401:
 *         description: Unauthorized
 */
router.get('/addresses', (req, res) => {
  // TODO: Implement get addresses logic
  res.status(200).json({
    message: 'Get addresses endpoint - to be implemented'
  });
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
 *               isDefault:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Address added successfully
 *       401:
 *         description: Unauthorized
 */
router.post('/addresses', (req, res) => {
  // TODO: Implement add address logic
  res.status(201).json({
    message: 'Add address endpoint - to be implemented',
    data: req.body
  });
});

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
router.get('/:userId/pbx-settings', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      `SELECT pbx_extension, pbx_username, pbx_password, pbx_display_name, pbx_ws_password
       FROM users
       WHERE id = $1`,
      [userId]
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
router.put('/:userId/pbx-settings', async (req, res) => {
  try {
    const { userId } = req.params;
    const {
      pbx_extension,
      pbx_username,
      pbx_password,
      pbx_display_name,
      pbx_ws_password
    } = req.body;

    const result = await pool.query(
      `UPDATE users
       SET pbx_extension = $1, pbx_username = $2, pbx_password = $3,
           pbx_display_name = $4, pbx_ws_password = $5, updated_at = CURRENT_TIMESTAMP
       WHERE id = $6
       RETURNING id, pbx_extension, pbx_username, pbx_display_name`,
      [
        pbx_extension,
        pbx_username,
        pbx_password,
        pbx_display_name,
        pbx_ws_password,
        userId
      ]
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
