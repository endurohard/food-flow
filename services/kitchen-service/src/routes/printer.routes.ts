import { Router, Request, Response } from 'express';
import pkg from 'pg';
const { Pool } = pkg;
import { PrinterService } from '../services/printer.service';
import { authenticateUser, requireRole } from '../middleware/auth.middleware';
import { config } from '../config';
import { logger } from '../utils/logger';

const router = Router();
router.use(authenticateUser);
router.use(requireRole('admin', 'owner', 'manager', 'operator', 'chef'));
// Принтерные станции/настройки — данные предприятия. Требуем enterprise-контекст
// (роли выше — enterprise-роли, enterpriseId в токене есть).
router.use((req: Request, res: Response, next) => {
  if (!req.enterpriseId) {
    return res.status(403).json({ success: false, error: 'Требуется контекст предприятия' });
  }
  next();
});
const printerService = new PrinterService();
const db = new Pool({ connectionString: config.database.url });

// БД (snake_case) → API-форма (camelCase), как раньше отдавал in-memory слой
function mapStation(r: any) {
  return {
    id: r.id, name: r.name, type: r.type, address: r.address || undefined,
    device: r.device || undefined, bluetooth: r.bluetooth || undefined,
    categories: r.categories || [], copies: r.copies, enabled: r.enabled,
    status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function mapSettings(r: any) {
  return {
    autoPrint: r.auto_print, defaultCopies: r.default_copies, fontSize: r.font_size,
    paperWidth: r.paper_width, encoding: r.encoding, printLogo: r.print_logo,
  };
}
const DEFAULT_SETTINGS = {
  autoPrint: true, defaultCopies: 1, fontSize: 12, paperWidth: 80,
  encoding: 'SLOVENIA', printLogo: true,
};

/**
 * @swagger
 * /api/printers/test:
 *   post:
 *     summary: Test print to verify printer connection
 *     tags: [Printers]
 *     responses:
 *       200:
 *         description: Test print successful
 */
router.post('/test', async (req: Request, res: Response) => {
  try {
    const success = await printerService.testPrint();

    if (success) {
      res.json({ message: 'Test print sent successfully' });
    } else {
      res.status(500).json({ error: 'Test print failed' });
    }
  } catch (error) {
    console.error('Test print error:', error);
    res.status(500).json({ error: 'Failed to send test print' });
  }
});

/**
 * @swagger
 * /api/printers/status:
 *   get:
 *     summary: Get printer status
 *     tags: [Printers]
 *     responses:
 *       200:
 *         description: Printer status information
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    const status = await printerService.getStatus();
    res.json(status);
  } catch (error) {
    console.error('Get printer status error:', error);
    res.status(500).json({ error: 'Failed to get printer status' });
  }
});

/**
 * @swagger
 * /api/printers/reconnect:
 *   post:
 *     summary: Reconnect to printer
 *     tags: [Printers]
 *     responses:
 *       200:
 *         description: Reconnection attempt result
 */
router.post('/reconnect', async (req: Request, res: Response) => {
  try {
    const connected = await printerService.reconnect();

    res.json({
      message: connected ? 'Printer reconnected successfully' : 'Failed to reconnect',
      connected,
    });
  } catch (error) {
    console.error('Printer reconnect error:', error);
    res.status(500).json({ error: 'Failed to reconnect to printer' });
  }
});

/**
 * @swagger
 * /api/printers/print/receipt:
 *   post:
 *     summary: Print customer receipt manually
 *     tags: [Printers]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - orderId
 *     responses:
 *       200:
 *         description: Receipt printed successfully
 */
router.post('/print/receipt', async (req: Request, res: Response) => {
  try {
    const orderData = req.body;

    // TODO: Fetch order data from database if only orderId is provided

    const success = await printerService.printCustomerReceipt(orderData);

    if (success) {
      res.json({ message: 'Receipt printed successfully' });
    } else {
      res.status(500).json({ error: 'Failed to print receipt' });
    }
  } catch (error) {
    console.error('Print receipt error:', error);
    res.status(500).json({ error: 'Failed to print receipt' });
  }
});

/**
 * @swagger
 * /api/printers/print/kitchen:
 *   post:
 *     summary: Print kitchen order ticket manually
 *     tags: [Printers]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - orderId
 *     responses:
 *       200:
 *         description: Kitchen ticket printed successfully
 */
router.post('/print/kitchen', async (req: Request, res: Response) => {
  try {
    const orderData = req.body;

    const success = await printerService.printKitchenOrder(orderData);

    if (success) {
      res.json({ message: 'Kitchen ticket printed successfully' });
    } else {
      res.status(500).json({ error: 'Failed to print kitchen ticket' });
    }
  } catch (error) {
    console.error('Print kitchen ticket error:', error);
    res.status(500).json({ error: 'Failed to print kitchen ticket' });
  }
});

// ==================== PRINTER STATIONS MANAGEMENT ====================

/**
 * GET /api/printers/stations
 * Get all printer stations
 */
router.get('/stations', async (req: Request, res: Response) => {
  try {
    const r = await db.query(
      'SELECT * FROM printer_stations WHERE enterprise_id = $1 ORDER BY id',
      [req.enterpriseId]
    );
    res.json({ success: true, data: r.rows.map(mapStation) });
  } catch (error) {
    logger.error('Failed to get printer stations:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get printer stations',
    });
  }
});

/**
 * GET /api/printers/stations/:id
 * Get a specific printer station
 */
router.get('/stations/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const r = await db.query(
      'SELECT * FROM printer_stations WHERE id = $1 AND enterprise_id = $2',
      [id, req.enterpriseId]
    );

    if (r.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Printer station not found',
      });
    }

    res.json({
      success: true,
      data: mapStation(r.rows[0]),
    });
  } catch (error) {
    logger.error('Failed to get printer station:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get printer station',
    });
  }
});

/**
 * POST /api/printers/stations
 * Create a new printer station
 */
router.post('/stations', async (req: Request, res: Response) => {
  try {
    const { name, type, address, device, bluetooth, categories, copies, enabled } = req.body;

    if (!name || !type || !categories || categories.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
      });
    }

    const r = await db.query(
      `INSERT INTO printer_stations
         (enterprise_id, name, type, address, device, bluetooth, categories, copies, enabled, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'offline')
       RETURNING *`,
      [
        req.enterpriseId, name, type, address || null, device || null, bluetooth || null,
        JSON.stringify(categories), copies || 1, enabled !== undefined ? enabled : true,
      ]
    );

    logger.info(`Printer station created: ${name}`);

    res.status(201).json({
      success: true,
      data: mapStation(r.rows[0]),
    });
  } catch (error) {
    logger.error('Failed to create printer station:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create printer station',
    });
  }
});

/**
 * PUT /api/printers/stations/:id
 * Update a printer station
 */
router.put('/stations/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const { name, type, address, device, bluetooth, categories, copies, enabled } = req.body;

    const r = await db.query(
      `UPDATE printer_stations SET
         name = COALESCE($3, name),
         type = COALESCE($4, type),
         address = $5, device = $6, bluetooth = $7,
         categories = COALESCE($8::jsonb, categories),
         copies = COALESCE($9, copies),
         enabled = COALESCE($10, enabled),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND enterprise_id = $2
       RETURNING *`,
      [
        id, req.enterpriseId, name ?? null, type ?? null, address ?? null, device ?? null,
        bluetooth ?? null, categories ? JSON.stringify(categories) : null,
        copies ?? null, enabled ?? null,
      ]
    );

    if (r.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Printer station not found',
      });
    }

    logger.info(`Printer station updated: ${r.rows[0].name}`);

    res.json({
      success: true,
      data: mapStation(r.rows[0]),
    });
  } catch (error) {
    logger.error('Failed to update printer station:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update printer station',
    });
  }
});

/**
 * DELETE /api/printers/stations/:id
 * Delete a printer station
 */
router.delete('/stations/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const r = await db.query(
      'DELETE FROM printer_stations WHERE id = $1 AND enterprise_id = $2 RETURNING *',
      [id, req.enterpriseId]
    );

    if (r.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Printer station not found',
      });
    }

    logger.info(`Printer station deleted: ${r.rows[0].name}`);

    res.json({
      success: true,
      data: mapStation(r.rows[0]),
    });
  } catch (error) {
    logger.error('Failed to delete printer station:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete printer station',
    });
  }
});

/**
 * POST /api/printers/test-station
 * Test print to a specific printer configuration - sends real ESC/POS commands
 */
router.post('/test-station', async (req: Request, res: Response) => {
  try {
    const { type, address, device, bluetooth } = req.body;

    if (!type) {
      return res.status(400).json({
        success: false,
        error: 'Printer type is required',
      });
    }

    if (type === 'network' && !address) {
      return res.status(400).json({
        success: false,
        error: 'Network printer requires IP address and port',
      });
    }

    logger.info(`Test print requested for ${type} printer at ${address || device || bluetooth}`);

    // Test network connectivity and send test print
    if (type === 'network') {
      const [host, port] = address.split(':');
      const printerPort = parseInt(port) || 9100;

      try {
        const net = require('net');

        // Create test receipt with ESC/POS commands
        const ESC = '\x1B';
        const GS = '\x1D';

        let testReceipt = '';
        // Initialize printer
        testReceipt += ESC + '@'; // Initialize

        // Center align
        testReceipt += ESC + 'a' + '\x01';

        // Bold on
        testReceipt += ESC + 'E' + '\x01';

        // Large text
        testReceipt += GS + '!' + '\x11'; // 2x height and width
        testReceipt += 'TEST PRINT\n';

        // Normal text
        testReceipt += GS + '!' + '\x00';
        testReceipt += ESC + 'E' + '\x00'; // Bold off

        testReceipt += '\n';
        testReceipt += '========================\n';
        testReceipt += '\n';

        // Left align
        testReceipt += ESC + 'a' + '\x00';
        testReceipt += 'Принтер: ' + address + '\n';
        testReceipt += 'Время: ' + new Date().toLocaleString('ru-RU') + '\n';
        testReceipt += '\n';

        // Center align
        testReceipt += ESC + 'a' + '\x01';
        testReceipt += '========================\n';
        testReceipt += '\n';
        testReceipt += ESC + 'E' + '\x01'; // Bold on
        testReceipt += 'Принтер работает!\n';
        testReceipt += ESC + 'E' + '\x00'; // Bold off
        testReceipt += '\n';
        testReceipt += '========================\n';
        testReceipt += '\n\n\n';

        // Cut paper
        testReceipt += GS + 'V' + '\x41' + '\x03'; // Partial cut

        // Send to printer
        await new Promise((resolve, reject) => {
          const socket = new net.Socket();
          socket.setTimeout(5000);

          socket.on('connect', () => {
            logger.info(`Connected to printer ${address}, sending test print...`);
            socket.write(testReceipt, 'binary', (err: any) => {
              if (err) {
                socket.destroy();
                reject(new Error(`Failed to write to printer: ${err.message}`));
              } else {
                logger.info('Test print data sent successfully');
                socket.end();
                resolve(true);
              }
            });
          });

          socket.on('timeout', () => {
            socket.destroy();
            reject(new Error(`Timeout connecting to ${host}:${printerPort}`));
          });

          socket.on('error', (err: Error) => {
            reject(new Error(`Cannot connect to ${host}:${printerPort}: ${err.message}`));
          });

          socket.on('close', () => {
            resolve(true);
          });

          socket.connect(printerPort, host);
        });

        logger.info(`Test print sent successfully to ${address}`);

        res.json({
          success: true,
          message: `✅ Тестовый чек отправлен на принтер ${address}. Проверьте, напечатался ли чек.`,
          details: {
            host,
            port: printerPort,
            status: 'printed',
            timestamp: new Date().toISOString()
          }
        });

      } catch (error: any) {
        logger.error(`Printer test failed: ${error.message}`);

        return res.status(400).json({
          success: false,
          error: `❌ Не удалось отправить на принтер: ${error.message}`,
          details: {
            host,
            port: printerPort,
            status: 'failed'
          }
        });
      }
    } else {
      // For USB and Bluetooth, just log
      logger.info(`Test print completed for ${type} printer`);

      res.json({
        success: true,
        message: `Test configuration saved. ${type} printer requires proper device setup in Docker.`,
      });
    }
  } catch (error) {
    logger.error('Failed to test printer:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to test printer',
    });
  }
});

/**
 * GET /api/printers/settings
 * Get global printer settings
 */
router.get('/settings', async (req: Request, res: Response) => {
  try {
    const r = await db.query(
      'SELECT * FROM printer_settings WHERE enterprise_id = $1',
      [req.enterpriseId]
    );
    res.json({
      success: true,
      data: r.rows.length ? mapSettings(r.rows[0]) : DEFAULT_SETTINGS,
    });
  } catch (error) {
    logger.error('Failed to get printer settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get printer settings',
    });
  }
});

/**
 * PUT /api/printers/settings
 * Update global printer settings
 */
router.put('/settings', async (req: Request, res: Response) => {
  try {
    const { autoPrint, defaultCopies, fontSize, paperWidth, encoding, printLogo } = req.body;

    // upsert по предприятию; COALESCE сохраняет незаданные поля
    const r = await db.query(
      `INSERT INTO printer_settings
         (enterprise_id, auto_print, default_copies, font_size, paper_width, encoding, print_logo)
       VALUES ($1, COALESCE($2, true), COALESCE($3, 1), COALESCE($4, 12), COALESCE($5, 80), COALESCE($6, 'SLOVENIA'), COALESCE($7, true))
       ON CONFLICT (enterprise_id) DO UPDATE SET
         auto_print     = COALESCE($2, printer_settings.auto_print),
         default_copies = COALESCE($3, printer_settings.default_copies),
         font_size      = COALESCE($4, printer_settings.font_size),
         paper_width    = COALESCE($5, printer_settings.paper_width),
         encoding       = COALESCE($6, printer_settings.encoding),
         print_logo     = COALESCE($7, printer_settings.print_logo),
         updated_at     = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        req.enterpriseId,
        autoPrint ?? null, defaultCopies ?? null, fontSize ?? null,
        paperWidth ?? null, encoding ?? null, printLogo ?? null,
      ]
    );

    logger.info('Printer settings updated');

    res.json({
      success: true,
      data: mapSettings(r.rows[0]),
    });
  } catch (error) {
    logger.error('Failed to update printer settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update printer settings',
    });
  }
});

/**
 * GET /api/printers/stats
 * Get printer statistics
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const r = await db.query(
      `SELECT
         count(*)                                        AS "totalStations",
         count(*) FILTER (WHERE status = 'online')       AS "onlineStations",
         count(*) FILTER (WHERE status = 'offline')      AS "offlineStations",
         count(*) FILTER (WHERE enabled)                 AS "enabledStations",
         count(*) FILTER (WHERE NOT enabled)             AS "disabledStations"
       FROM printer_stations WHERE enterprise_id = $1`,
      [req.enterpriseId]
    );
    const row = r.rows[0];
    const stats = {
      totalStations: Number(row.totalStations),
      onlineStations: Number(row.onlineStations),
      offlineStations: Number(row.offlineStations),
      enabledStations: Number(row.enabledStations),
      disabledStations: Number(row.disabledStations),
    };

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    logger.error('Failed to get printer stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get printer stats',
    });
  }
});

export default router;
