import { ThermalPrinter, PrinterTypes } from 'node-thermal-printer';
import QRCode from 'qrcode';
import { logger } from '../utils/logger';
import { config } from '../config';

export interface OrderItem {
  name: string;
  quantity: number;
  price: number;
  specialInstructions?: string;
}

export interface OrderPrintData {
  orderNumber: string;
  restaurant: {
    name: string;
    address: string;
    phone: string;
  };
  customer: {
    name: string;
    phone?: string;
  };
  items: OrderItem[];
  subtotal: number;
  deliveryFee: number;
  tax: number;
  total: number;
  orderType: 'delivery' | 'pickup' | 'dine-in';
  deliveryAddress?: string;
  specialInstructions?: string;
  timestamp: Date;
}

export class PrinterService {
  private printer: ThermalPrinter | null = null;
  private isConnected: boolean = false;

  constructor() {
    this.initializePrinter();
  }

  private async initializePrinter() {
    try {
      // Initialize thermal printer
      this.printer = new ThermalPrinter({
        type: PrinterTypes.EPSON,
        interface: config.printer.interface,
        characterSet: 'UTF8',
        removeSpecialCharacters: false,
        lineCharacter: '-',
        options: {
          timeout: 5000,
        },
      });

      this.isConnected = await this.printer.isPrinterConnected();

      if (this.isConnected) {
        logger.info('Printer connected successfully');
      } else {
        logger.warn('Printer not connected. Running in simulation mode.');
      }
    } catch (error) {
      logger.error('Failed to initialize printer:', error);
      logger.warn('Printer will run in simulation mode');
      this.isConnected = false;
    }
  }

  /**
   * Print kitchen order receipt
   */
  async printKitchenOrder(order: OrderPrintData): Promise<boolean> {
    try {
      if (!this.printer) {
        logger.warn('Printer not initialized');
        return false;
      }

      this.printer.clear();

      // Header
      this.printer.alignCenter();
      this.printer.setTextSize(1, 1);
      this.printer.bold(true);
      this.printer.println('=== KITCHEN ORDER ===');
      this.printer.bold(false);
      this.printer.newLine();

      // Order number (large and bold)
      this.printer.setTextSize(2, 2);
      this.printer.bold(true);
      this.printer.println(`#${order.orderNumber}`);
      this.printer.bold(false);
      this.printer.setTextSize(1, 1);
      this.printer.newLine();

      // Order type
      this.printer.println(`Type: ${order.orderType.toUpperCase()}`);
      this.printer.newLine();

      // Timestamp
      this.printer.alignLeft();
      this.printer.println(`Time: ${order.timestamp.toLocaleTimeString()}`);
      this.printer.println(`Date: ${order.timestamp.toLocaleDateString()}`);
      this.printer.drawLine();

      // Customer info
      this.printer.bold(true);
      this.printer.println('CUSTOMER:');
      this.printer.bold(false);
      this.printer.println(order.customer.name);
      if (order.customer.phone) {
        this.printer.println(`Tel: ${order.customer.phone}`);
      }

      if (order.orderType === 'delivery' && order.deliveryAddress) {
        this.printer.println(`Address: ${order.deliveryAddress}`);
      }
      this.printer.drawLine();

      // Items
      this.printer.bold(true);
      this.printer.setTextSize(1, 1);
      this.printer.println('ITEMS:');
      this.printer.bold(false);
      this.printer.newLine();

      order.items.forEach((item) => {
        // Item name and quantity
        this.printer.setTextSize(1, 1);
        this.printer.bold(true);
        this.printer.println(`${item.quantity}x ${item.name}`);
        this.printer.bold(false);

        // Special instructions
        if (item.specialInstructions) {
          this.printer.println(`   >>> ${item.specialInstructions}`);
        }
        this.printer.newLine();
      });

      this.printer.drawLine();

      // Special instructions for entire order
      if (order.specialInstructions) {
        this.printer.bold(true);
        this.printer.println('SPECIAL INSTRUCTIONS:');
        this.printer.bold(false);
        this.printer.println(order.specialInstructions);
        this.printer.drawLine();
      }

      // Generate QR code for order tracking
      const qrCodeDataUrl = await QRCode.toDataURL(
        `ORDER:${order.orderNumber}`,
        { width: 200, margin: 1 }
      );

      // Footer
      this.printer.alignCenter();
      this.printer.newLine();
      this.printer.println('Scan for order details:');

      // Print QR code (if supported)
      try {
        await this.printer.printImageBuffer(
          Buffer.from(qrCodeDataUrl.split(',')[1], 'base64')
        );
      } catch (error) {
        logger.warn('QR code printing not supported');
      }

      this.printer.newLine();
      this.printer.println('========================');
      this.printer.newLine();
      this.printer.newLine();
      this.printer.newLine();

      // Cut paper
      this.printer.cut();

      // Execute print
      if (this.isConnected) {
        await this.printer.execute();
        logger.info(`Kitchen order ${order.orderNumber} printed successfully`);
        return true;
      } else {
        // Simulation mode - just log
        const receipt = await this.printer.getText();
        logger.info('SIMULATION MODE - Receipt content:\n' + receipt);
        return true;
      }
    } catch (error) {
      logger.error('Failed to print kitchen order:', error);
      return false;
    }
  }

  /**
   * Print customer receipt
   */
  async printCustomerReceipt(order: OrderPrintData): Promise<boolean> {
    try {
      if (!this.printer) {
        logger.warn('Printer not initialized');
        return false;
      }

      this.printer.clear();

      // Header - Restaurant info
      this.printer.alignCenter();
      this.printer.setTextSize(1, 1);
      this.printer.bold(true);
      this.printer.println(order.restaurant.name);
      this.printer.bold(false);
      this.printer.println(order.restaurant.address);
      this.printer.println(`Tel: ${order.restaurant.phone}`);
      this.printer.drawLine();

      // Order info
      this.printer.bold(true);
      this.printer.println(`Order #${order.orderNumber}`);
      this.printer.bold(false);
      this.printer.println(`${order.timestamp.toLocaleString()}`);
      this.printer.println(`Type: ${order.orderType}`);
      this.printer.drawLine();

      // Items with prices
      this.printer.alignLeft();
      this.printer.tableCustom([
        { text: 'Item', align: 'LEFT', width: 0.6 },
        { text: 'Qty', align: 'CENTER', width: 0.1 },
        { text: 'Price', align: 'RIGHT', width: 0.3 },
      ]);
      this.printer.drawLine();

      order.items.forEach((item) => {
        this.printer.tableCustom([
          { text: item.name, align: 'LEFT', width: 0.6 },
          { text: item.quantity.toString(), align: 'CENTER', width: 0.1 },
          { text: `$${(item.price * item.quantity).toFixed(2)}`, align: 'RIGHT', width: 0.3 },
        ]);

        if (item.specialInstructions) {
          this.printer.println(`  * ${item.specialInstructions}`);
        }
      });

      this.printer.drawLine();

      // Totals
      this.printer.alignRight();
      this.printer.println(`Subtotal: $${order.subtotal.toFixed(2)}`);
      this.printer.println(`Delivery: $${order.deliveryFee.toFixed(2)}`);
      this.printer.println(`Tax:      $${order.tax.toFixed(2)}`);
      this.printer.drawLine();
      this.printer.bold(true);
      this.printer.setTextSize(1, 1);
      this.printer.println(`TOTAL:    $${order.total.toFixed(2)}`);
      this.printer.bold(false);
      this.printer.setTextSize(1, 1);
      this.printer.drawLine();

      // QR Code for order tracking
      this.printer.alignCenter();
      const trackingUrl = `https://foodflow.com/track/${order.orderNumber}`;
      const qrCodeDataUrl = await QRCode.toDataURL(trackingUrl, { width: 200 });

      try {
        await this.printer.printImageBuffer(
          Buffer.from(qrCodeDataUrl.split(',')[1], 'base64')
        );
        this.printer.println('Scan to track your order');
      } catch (error) {
        this.printer.println(`Track: ${trackingUrl}`);
      }

      this.printer.newLine();
      this.printer.println('Thank you for your order!');
      this.printer.newLine();
      this.printer.newLine();

      // Cut paper
      this.printer.cut();

      // Execute print
      if (this.isConnected) {
        await this.printer.execute();
        logger.info(`Customer receipt ${order.orderNumber} printed successfully`);
        return true;
      } else {
        const receipt = await this.printer.getText();
        logger.info('SIMULATION MODE - Receipt content:\n' + receipt);
        return true;
      }
    } catch (error) {
      logger.error('Failed to print customer receipt:', error);
      return false;
    }
  }

  /**
   * Test print to verify printer is working
   */
  async testPrint(): Promise<boolean> {
    try {
      if (!this.printer) {
        return false;
      }

      this.printer.clear();
      this.printer.alignCenter();
      this.printer.bold(true);
      this.printer.println('PRINTER TEST');
      this.printer.bold(false);
      this.printer.drawLine();
      this.printer.println('Printer is working correctly!');
      this.printer.newLine();
      this.printer.println(new Date().toLocaleString());
      this.printer.newLine();
      this.printer.cut();

      if (this.isConnected) {
        await this.printer.execute();
        logger.info('Test print successful');
        return true;
      } else {
        const receipt = await this.printer.getText();
        logger.info('SIMULATION MODE - Test print:\n' + receipt);
        return true;
      }
    } catch (error) {
      logger.error('Test print failed:', error);
      return false;
    }
  }

  /**
   * Get printer status
   */
  async getStatus(): Promise<{
    connected: boolean;
    type: string;
    interface: string;
  }> {
    return {
      connected: this.isConnected,
      type: config.printer.type,
      interface: config.printer.interface,
    };
  }

  /**
   * Reconnect to printer
   */
  async reconnect(): Promise<boolean> {
    await this.initializePrinter();
    return this.isConnected;
  }
}
