import { Router, Request, Response } from 'express';
import { PrinterService } from '../services/printer.service';

const router = Router();
const printerService = new PrinterService();

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

export default router;
