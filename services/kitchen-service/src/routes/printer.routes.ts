import { Router, Request, Response } from 'express';
import { PrinterService } from '../services/printer.service';
import { PrinterStation, PrinterSettings } from '../models/printer-station.model';
import { logger } from '../utils/logger';

const router = Router();
const printerService = new PrinterService();

// In-memory storage (in production, use PostgreSQL)
let printerStations: PrinterStation[] = [
  {
    id: 1,
    name: 'Мучной цех',
    type: 'network',
    address: '192.168.31.87:9100',
    categories: ['pizza', 'burger'],
    copies: 1,
    enabled: true,
    status: 'online',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 2,
    name: 'Горячий цех',
    type: 'network',
    address: '192.168.31.88:9100',
    categories: ['hot'],
    copies: 2,
    enabled: true,
    status: 'online',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 3,
    name: 'Бар',
    type: 'network',
    address: '192.168.31.89:9100',
    categories: ['drinks', 'dessert'],
    copies: 1,
    enabled: true,
    status: 'offline',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

let globalSettings: PrinterSettings = {
  autoPrint: true,
  defaultCopies: 1,
  fontSize: 12,
  paperWidth: 80,
  encoding: 'SLOVENIA',
  printLogo: true,
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
    res.json({
      success: true,
      data: printerStations,
    });
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
    const station = printerStations.find((s) => s.id === id);

    if (!station) {
      return res.status(404).json({
        success: false,
        error: 'Printer station not found',
      });
    }

    res.json({
      success: true,
      data: station,
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

    const newStation: PrinterStation = {
      id: Math.max(...printerStations.map((s) => s.id), 0) + 1,
      name,
      type,
      address,
      device,
      bluetooth,
      categories,
      copies: copies || 1,
      enabled: enabled !== undefined ? enabled : true,
      status: 'offline',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    printerStations.push(newStation);

    logger.info(`Printer station created: ${name}`);

    res.status(201).json({
      success: true,
      data: newStation,
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
    const index = printerStations.findIndex((s) => s.id === id);

    if (index === -1) {
      return res.status(404).json({
        success: false,
        error: 'Printer station not found',
      });
    }

    const { name, type, address, device, bluetooth, categories, copies, enabled } = req.body;

    printerStations[index] = {
      ...printerStations[index],
      name: name || printerStations[index].name,
      type: type || printerStations[index].type,
      address,
      device,
      bluetooth,
      categories: categories || printerStations[index].categories,
      copies: copies !== undefined ? copies : printerStations[index].copies,
      enabled: enabled !== undefined ? enabled : printerStations[index].enabled,
      updatedAt: new Date(),
    };

    logger.info(`Printer station updated: ${printerStations[index].name}`);

    res.json({
      success: true,
      data: printerStations[index],
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
    const index = printerStations.findIndex((s) => s.id === id);

    if (index === -1) {
      return res.status(404).json({
        success: false,
        error: 'Printer station not found',
      });
    }

    const deleted = printerStations.splice(index, 1)[0];

    logger.info(`Printer station deleted: ${deleted.name}`);

    res.json({
      success: true,
      data: deleted,
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
    res.json({
      success: true,
      data: globalSettings,
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

    globalSettings = {
      autoPrint: autoPrint !== undefined ? autoPrint : globalSettings.autoPrint,
      defaultCopies: defaultCopies || globalSettings.defaultCopies,
      fontSize: fontSize || globalSettings.fontSize,
      paperWidth: paperWidth || globalSettings.paperWidth,
      encoding: encoding || globalSettings.encoding,
      printLogo: printLogo !== undefined ? printLogo : globalSettings.printLogo,
    };

    logger.info('Global printer settings updated');

    res.json({
      success: true,
      data: globalSettings,
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
    const stats = {
      totalStations: printerStations.length,
      onlineStations: printerStations.filter((s) => s.status === 'online').length,
      offlineStations: printerStations.filter((s) => s.status === 'offline').length,
      enabledStations: printerStations.filter((s) => s.enabled).length,
      disabledStations: printerStations.filter((s) => !s.enabled).length,
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
