import { Router, Request, Response } from 'express';
import pkg from 'pg';
const { Pool } = pkg;
import { authenticateUser } from '../middleware/auth.middleware';
import { config } from '../config';

const router = Router();
router.use(authenticateUser);
const pool = new Pool({ connectionString: config.database.url });

// Get PBX settings for a restaurant
router.get('/:id/pbx-settings', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    const scoped = !isSuper;
    const result = await pool.query(
      `SELECT pbx_enabled, pbx_server, pbx_port, pbx_transport,
              pbx_rtp_port_min, pbx_rtp_port_max,
              pbx_websocket_url, pbx_use_websocket
       FROM restaurants
       WHERE id = $1${scoped ? ' AND enterprise_id = $2' : ''}`,
      scoped ? [id, req.enterpriseId] : [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    return res.json(result.rows[0]);
  } catch (error: any) {
    console.error('Failed to get PBX settings:', error);
    return res.status(500).json({ error: 'Failed to get PBX settings' });
  }
});

// Update PBX settings for a restaurant
router.put('/:id/pbx-settings', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const isSuper = req.userRole === 'super_admin';
    if (!isSuper && !req.enterpriseId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
    }
    const {
      pbx_enabled, pbx_server, pbx_port, pbx_transport,
      pbx_rtp_port_min, pbx_rtp_port_max,
      pbx_websocket_url, pbx_use_websocket
    } = req.body;

    const scoped = !isSuper;
    const result = await pool.query(
      `UPDATE restaurants
       SET pbx_enabled = $1, pbx_server = $2, pbx_port = $3,
           pbx_transport = $4, pbx_rtp_port_min = $5, pbx_rtp_port_max = $6,
           pbx_websocket_url = $7, pbx_use_websocket = $8,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $9${scoped ? ' AND enterprise_id = $10' : ''}
       RETURNING *`,
      scoped
        ? [pbx_enabled, pbx_server, pbx_port, pbx_transport, pbx_rtp_port_min, pbx_rtp_port_max, pbx_websocket_url, pbx_use_websocket, id, req.enterpriseId]
        : [pbx_enabled, pbx_server, pbx_port, pbx_transport, pbx_rtp_port_min, pbx_rtp_port_max, pbx_websocket_url, pbx_use_websocket, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    return res.json({ success: true, restaurant: result.rows[0] });
  } catch (error: any) {
    console.error('Failed to update PBX settings:', error);
    return res.status(500).json({ error: 'Failed to update PBX settings' });
  }
});

export default router;
