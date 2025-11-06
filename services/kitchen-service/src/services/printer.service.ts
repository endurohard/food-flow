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
        characterSet: 'SLOVENIA' as any,
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
   * Print kitchen order receipt (simplified production format)
   * Only order number and items - no address, no prices
   */
  async printKitchenOrder(order: OrderPrintData): Promise<boolean> {
    try {
      if (!this.printer) {
        logger.warn('Printer not initialized');
        return false;
      }

      this.printer.clear();

      // Order number - LARGE and centered
      this.printer.alignCenter();
      this.printer.setTextSize(3, 3);
      this.printer.bold(true);
      this.printer.println(`#${order.orderNumber}`);
      this.printer.bold(false);
      this.printer.setTextSize(1, 1);
      this.printer.newLine();

      // Timestamp
      this.printer.setTextSize(1, 1);
      const timeStr = order.timestamp.toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit'
      });
      this.printer.println(timeStr);
      this.printer.drawLine();

      // Items - simple list
      this.printer.alignLeft();
      this.printer.newLine();

      order.items.forEach((item) => {
        // Quantity and item name - bold and large
        this.printer.setTextSize(2, 2);
        this.printer.bold(true);
        this.printer.println(`${item.quantity}x`);
        this.printer.bold(false);

        this.printer.setTextSize(1, 1);
        this.printer.bold(true);
        this.printer.println(item.name.toUpperCase());
        this.printer.bold(false);

        // Special instructions if any
        if (item.specialInstructions) {
          this.printer.println(`>>> ${item.specialInstructions}`);
        }

        this.printer.newLine();
      });

      this.printer.drawLine();

      // Order-level special instructions
      if (order.specialInstructions) {
        this.printer.alignCenter();
        this.printer.bold(true);
        this.printer.println('КОММЕНТАРИЙ:');
        this.printer.bold(false);
        this.printer.println(order.specialInstructions);
        this.printer.drawLine();
      }

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
        logger.info('SIMULATION MODE - Kitchen receipt:\n' + receipt);
        return true;
      }
    } catch (error) {
      logger.error('Failed to print kitchen order:', error);
      return false;
    }
  }

  /**
   * Print customer receipt (format matching the example)
   */
  async printCustomerReceipt(order: OrderPrintData): Promise<boolean> {
    try {
      if (!this.printer) {
        logger.warn('Printer not initialized');
        return false;
      }

      this.printer.clear();

      // Header - Phone and Address
      this.printer.alignLeft();
      this.printer.setTextSize(1, 1);
      this.printer.println(order.restaurant.phone);
      this.printer.println(`Адрес: ${order.restaurant.address}`);
      this.printer.newLine();

      // Order number - centered and large
      this.printer.alignCenter();
      this.printer.setTextSize(2, 2);
      this.printer.bold(true);
      this.printer.println(`Заказ № ${order.orderNumber}`);
      this.printer.bold(false);
      this.printer.setTextSize(1, 1);

      // Courier info
      this.printer.alignLeft();
      this.printer.println(`Курьер: ${order.customer.name}`);

      // Date and time
      const dateStr = order.timestamp.toLocaleString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });
      this.printer.println(`Заказ принят: ${dateStr}`);

      // Number of people
      this.printer.println('Количество человек: 1');
      this.printer.drawLine();

      // Table header
      this.printer.alignLeft();
      this.printer.tableCustom([
        { text: 'Наименова', align: 'LEFT', width: 0.4 },
        { text: 'К-во', align: 'CENTER', width: 0.15 },
        { text: 'Цена', align: 'RIGHT', width: 0.22 },
        { text: 'Сумма', align: 'RIGHT', width: 0.23 },
      ]);
      this.printer.drawLine();

      // Items
      order.items.forEach((item) => {
        this.printer.bold(true);
        this.printer.println(item.name.toUpperCase());
        this.printer.bold(false);

        this.printer.tableCustom([
          { text: '', align: 'LEFT', width: 0.05 },
          { text: `${item.quantity} порц`, align: 'LEFT', width: 0.35 },
          { text: 'x', align: 'CENTER', width: 0.05 },
          { text: `${item.price.toFixed(2)}`, align: 'RIGHT', width: 0.27 },
          { text: `${(item.price * item.quantity).toFixed(2)}`, align: 'RIGHT', width: 0.28 },
        ]);

        if (item.specialInstructions) {
          this.printer.println(`  >>> ${item.specialInstructions}`);
        }
      });

      this.printer.drawLine();

      // Total
      this.printer.alignLeft();
      this.printer.tableCustom([
        { text: 'Итого к оплате:', align: 'LEFT', width: 0.55 },
        { text: `${order.total.toFixed(2)}`, align: 'RIGHT', width: 0.45 },
      ]);
      this.printer.drawLine();

      // Payment method
      this.printer.println(`Карта Интернет-эква ${order.total.toFixed(2)}`);
      this.printer.println('Яринг (проведена)');
      this.printer.newLine();

      // Special instructions
      if (order.specialInstructions) {
        this.printer.println('Комментарий к заказу:');
        this.printer.println(order.specialInstructions);
        this.printer.drawLine();
      }

      // Footer message
      this.printer.alignCenter();
      this.printer.println('Оставить отзыв и отзыв');
      this.printer.println('нетмонет');
      this.printer.newLine();

      // QR Code for reviews
      this.printer.alignCenter();
      const reviewUrl = `https://foodflow.com/review/${order.orderNumber}`;
      const qrCodeDataUrl = await QRCode.toDataURL(reviewUrl, {
        width: 200,
        margin: 1,
        errorCorrectionLevel: 'M'
      });

      try {
        await this.printer.printImageBuffer(
          Buffer.from(qrCodeDataUrl.split(',')[1], 'base64')
        );
      } catch (error) {
        logger.warn('QR code printing not supported');
        this.printer.println(`Отзыв: ${reviewUrl}`);
      }

      this.printer.newLine();
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
