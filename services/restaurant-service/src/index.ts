import express from 'express';
import pkg from 'pg';
const { Pool } = pkg;

const app = express();
const PORT = process.env.PORT || 3002;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'restaurant-service' });
});

// Get PBX settings for a restaurant
app.get('/api/restaurants/:id/pbx-settings', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT pbx_enabled, pbx_server, pbx_port, pbx_transport,
              pbx_rtp_port_min, pbx_rtp_port_max,
              pbx_websocket_url, pbx_use_websocket
       FROM restaurants
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    res.json(result.rows[0]);
  } catch (error: any) {
    console.error('Failed to get PBX settings:', error);
    res.status(500).json({ error: 'Failed to get PBX settings' });
  }
});

// Update PBX settings for a restaurant
app.put('/api/restaurants/:id/pbx-settings', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      pbx_enabled,
      pbx_server,
      pbx_port,
      pbx_transport,
      pbx_rtp_port_min,
      pbx_rtp_port_max,
      pbx_websocket_url,
      pbx_use_websocket
    } = req.body;

    const result = await pool.query(
      `UPDATE restaurants
       SET pbx_enabled = $1, pbx_server = $2, pbx_port = $3,
           pbx_transport = $4, pbx_rtp_port_min = $5, pbx_rtp_port_max = $6,
           pbx_websocket_url = $7, pbx_use_websocket = $8,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $9
       RETURNING *`,
      [
        pbx_enabled,
        pbx_server,
        pbx_port,
        pbx_transport,
        pbx_rtp_port_min,
        pbx_rtp_port_max,
        pbx_websocket_url,
        pbx_use_websocket,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    res.json({ success: true, restaurant: result.rows[0] });
  } catch (error: any) {
    console.error('Failed to update PBX settings:', error);
    res.status(500).json({ error: 'Failed to update PBX settings' });
  }
});

app.listen(PORT, () => {
  console.log(`Restaurant service listening on port ${PORT}`);
});
