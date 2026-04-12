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

  private get p(): ThermalPrinter {
    if (!this.printer) throw new Error('Printer not initialized');
    return this.printer;
  }

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

      this.isConnected = await this.p.isPrinterConnected();

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

      this.p.clear();

      // Order number - LARGE and centered
      this.p.alignCenter();
      this.p.setTextSize(3, 3);
      this.p.bold(true);
      this.p.println(`#${order.orderNumber}`);
      this.p.bold(false);
      this.p.setTextSize(1, 1);
      this.p.newLine();

      // Timestamp
      this.p.setTextSize(1, 1);
      const timeStr = order.timestamp.toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit'
      });
      this.p.println(timeStr);
      this.p.drawLine();

      // Items - simple list
      this.p.alignLeft();
      this.p.newLine();

      order.items.forEach((item) => {
        // Quantity and item name - bold and large
        this.p.setTextSize(2, 2);
        this.p.bold(true);
        this.p.println(`${item.quantity}x`);
        this.p.bold(false);

        this.p.setTextSize(1, 1);
        this.p.bold(true);
        this.p.println(item.name.toUpperCase());
        this.p.bold(false);

        // Special instructions if any
        if (item.specialInstructions) {
          this.p.println(`>>> ${item.specialInstructions}`);
        }

        this.p.newLine();
      });

      this.p.drawLine();

      // Order-level special instructions
      if (order.specialInstructions) {
        this.p.alignCenter();
        this.p.bold(true);
        this.p.println('КОММЕНТАРИЙ:');
        this.p.bold(false);
        this.p.println(order.specialInstructions);
        this.p.drawLine();
      }

      this.p.newLine();
      this.p.newLine();
      this.p.newLine();

      // Cut paper
      this.p.cut();

      // Execute print
      if (this.isConnected) {
        await this.p.execute();
        logger.info(`Kitchen order ${order.orderNumber} printed successfully`);
        return true;
      } else {
        // Simulation mode - just log
        const receipt = await this.p.getText();
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

      this.p.clear();

      // Header - Phone and Address
      this.p.alignLeft();
      this.p.setTextSize(1, 1);
      this.p.println(order.restaurant.phone);
      this.p.println(`Адрес: ${order.restaurant.address}`);
      this.p.newLine();

      // Order number - centered and large
      this.p.alignCenter();
      this.p.setTextSize(2, 2);
      this.p.bold(true);
      this.p.println(`Заказ № ${order.orderNumber}`);
      this.p.bold(false);
      this.p.setTextSize(1, 1);

      // Courier info
      this.p.alignLeft();
      this.p.println(`Курьер: ${order.customer.name}`);

      // Date and time
      const dateStr = order.timestamp.toLocaleString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });
      this.p.println(`Заказ принят: ${dateStr}`);

      // Number of people
      this.p.println('Количество человек: 1');
      this.p.drawLine();

      // Table header
      this.p.alignLeft();
      this.p.tableCustom([
        { text: 'Наименова', align: 'LEFT', width: 0.4 },
        { text: 'К-во', align: 'CENTER', width: 0.15 },
        { text: 'Цена', align: 'RIGHT', width: 0.22 },
        { text: 'Сумма', align: 'RIGHT', width: 0.23 },
      ]);
      this.p.drawLine();

      // Items
      order.items.forEach((item) => {
        this.p.bold(true);
        this.p.println(item.name.toUpperCase());
        this.p.bold(false);

        this.p.tableCustom([
          { text: '', align: 'LEFT', width: 0.05 },
          { text: `${item.quantity} порц`, align: 'LEFT', width: 0.35 },
          { text: 'x', align: 'CENTER', width: 0.05 },
          { text: `${item.price.toFixed(2)}`, align: 'RIGHT', width: 0.27 },
          { text: `${(item.price * item.quantity).toFixed(2)}`, align: 'RIGHT', width: 0.28 },
        ]);

        if (item.specialInstructions) {
          this.p.println(`  >>> ${item.specialInstructions}`);
        }
      });

      this.p.drawLine();

      // Total
      this.p.alignLeft();
      this.p.tableCustom([
        { text: 'Итого к оплате:', align: 'LEFT', width: 0.55 },
        { text: `${order.total.toFixed(2)}`, align: 'RIGHT', width: 0.45 },
      ]);
      this.p.drawLine();

      // Payment method
      this.p.println(`Карта Интернет-эква ${order.total.toFixed(2)}`);
      this.p.println('Яринг (проведена)');
      this.p.newLine();

      // Special instructions
      if (order.specialInstructions) {
        this.p.println('Комментарий к заказу:');
        this.p.println(order.specialInstructions);
        this.p.drawLine();
      }

      // Footer message
      this.p.alignCenter();
      this.p.println('Оставить отзыв и отзыв');
      this.p.println('нетмонет');
      this.p.newLine();

      // QR Code for reviews
      this.p.alignCenter();
      const reviewUrl = `https://foodflow.com/review/${order.orderNumber}`;
      const qrCodeDataUrl = await QRCode.toDataURL(reviewUrl, {
        width: 200,
        margin: 1,
        errorCorrectionLevel: 'M'
      });

      try {
        await this.p.printImageBuffer(
          Buffer.from(qrCodeDataUrl.split(',')[1], 'base64')
        );
      } catch (error) {
        logger.warn('QR code printing not supported');
        this.p.println(`Отзыв: ${reviewUrl}`);
      }

      this.p.newLine();
      this.p.newLine();
      this.p.newLine();

      // Cut paper
      this.p.cut();

      // Execute print
      if (this.isConnected) {
        await this.p.execute();
        logger.info(`Customer receipt ${order.orderNumber} printed successfully`);
        return true;
      } else {
        const receipt = await this.p.getText();
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

      this.p.clear();
      this.p.alignCenter();
      this.p.bold(true);
      this.p.println('PRINTER TEST');
      this.p.bold(false);
      this.p.drawLine();
      this.p.println('Printer is working correctly!');
      this.p.newLine();
      this.p.println(new Date().toLocaleString());
      this.p.newLine();
      this.p.cut();

      if (this.isConnected) {
        await this.p.execute();
        logger.info('Test print successful');
        return true;
      } else {
        const receipt = await this.p.getText();
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
