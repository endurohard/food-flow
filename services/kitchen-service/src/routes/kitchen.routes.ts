import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { config } from '../config';
import { authenticateUser, requireRole } from '../middleware/auth.middleware';

const router = Router();

router.use(authenticateUser);
router.use(requireRole('admin', 'owner', 'manager', 'operator', 'chef'));
const db = new Pool({ connectionString: config.database.url });

/**
 * @swagger
 * /api/kitchen/orders:
 *   get:
 *     summary: Get active orders for kitchen display
 *     tags: [Kitchen]
 *     parameters:
 *       - in: query
 *         name: restaurantId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of active orders
 */
router.get('/orders', async (req: Request, res: Response) => {
  try {
    const { restaurantId } = req.query;

    if (!restaurantId) {
      return res.status(400).json({ error: 'restaurantId is required' });
    }

    const conds = [`o.restaurant_id = $1`, `o.status IN ('confirmed', 'preparing', 'ready')`];
    const vals: any[] = [restaurantId];
    if (req.enterpriseId) {
      conds.push(`o.enterprise_id = $${vals.length + 1}`);
      vals.push(req.enterpriseId);
    }

    const result = await db.query(
      `SELECT
        o.id,
        o.order_number as "orderNumber",
        o.status,
        o.created_at as "createdAt",
        o.special_instructions as "specialInstructions",
        u.first_name || ' ' || u.last_name as "customerName",
        json_agg(
          json_build_object(
            'name', mi.name,
            'quantity', oi.quantity,
            'specialInstructions', oi.special_instructions
          )
        ) as items
      FROM orders o
      JOIN users u ON o.customer_id = u.id
      JOIN order_items oi ON o.id = oi.order_id
      JOIN menu_items mi ON oi.menu_item_id = mi.id
      WHERE ${conds.join(' AND ')}
      GROUP BY o.id, o.order_number, o.status, o.created_at,
               o.special_instructions, u.first_name, u.last_name
      ORDER BY o.created_at ASC`,
      vals
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching kitchen orders:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

/**
 * @swagger
 * /api/kitchen/orders/{orderId}/status:
 *   put:
 *     summary: Update order status from kitchen
 *     tags: [Kitchen]
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [preparing, ready, completed]
 *     responses:
 *       200:
 *         description: Status updated successfully
 */
const KITCHEN_ALLOWED_STATUSES = ['preparing', 'ready', 'completed'] as const;

router.put('/orders/:orderId/status', async (req: Request, res: Response) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    if (!status || !(KITCHEN_ALLOWED_STATUSES as readonly string[]).includes(status)) {
      return res.status(400).json({
        error: `status must be one of: ${KITCHEN_ALLOWED_STATUSES.join(', ')}`
      });
    }

    // Tenant guard: fail if JWT tenant doesn't match the order's enterprise
    const whereConds = ['id = $2'];
    const vals: any[] = [status, orderId];
    if (req.enterpriseId) {
      whereConds.push(`enterprise_id = $3`);
      vals.push(req.enterpriseId);
    }

    const upd = await db.query(
      `UPDATE orders SET status = $1, updated_at = NOW() WHERE ${whereConds.join(' AND ')}`,
      vals
    );
    if (upd.rowCount === 0) {
      return res.status(404).json({ error: 'Order not found or access denied' });
    }

    res.json({ message: 'Order status updated', orderId, status });
  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

/**
 * @swagger
 * /api/kitchen/stats:
 *   get:
 *     summary: Get kitchen statistics
 *     tags: [Kitchen]
 *     parameters:
 *       - in: query
 *         name: restaurantId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Kitchen statistics
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const { restaurantId } = req.query;

    if (!restaurantId) {
      return res.status(400).json({ error: 'restaurantId is required' });
    }

    const conds = [
      `restaurant_id = $1`,
      `status IN ('confirmed', 'preparing', 'ready')`,
      `created_at > NOW() - INTERVAL '1 day'`
    ];
    const vals: any[] = [restaurantId];
    if (req.enterpriseId) {
      conds.push(`enterprise_id = $${vals.length + 1}`);
      vals.push(req.enterpriseId);
    }

    const result = await db.query(
      `SELECT
        COUNT(CASE WHEN status = 'confirmed' THEN 1 END) as pending,
        COUNT(CASE WHEN status = 'preparing' THEN 1 END) as preparing,
        COUNT(CASE WHEN status = 'ready' THEN 1 END) as ready,
        COALESCE(AVG(EXTRACT(EPOCH FROM (updated_at - created_at))), 0) as "averageTime"
      FROM orders
      WHERE ${conds.join(' AND ')}`,
      vals
    );

    res.json({
      pending: parseInt(result.rows[0].pending),
      preparing: parseInt(result.rows[0].preparing),
      ready: parseInt(result.rows[0].ready),
      averageTime: Math.round(parseFloat(result.rows[0].averageTime) / 60), // minutes
    });
  } catch (error) {
    console.error('Error fetching kitchen stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;
