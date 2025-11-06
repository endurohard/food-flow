import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import * as fs from 'fs/promises';
import * as path from 'path';
import axios from 'axios';
import { ocrService } from './ocr.service';
import { invoiceParserService } from './invoice-parser.service';
import { inventoryApiService } from './inventory-api.service';
import { Invoice } from '../models/invoice.model';
import { logger } from '../utils/logger';

export class BotService {
  private bot: Telegraf;
  private allowedUserIds: number[];
  private uploadDir: string;
  private invoices: Map<string, Invoice> = new Map();

  constructor(botToken: string, allowedUserIds: number[], uploadDir: string) {
    this.bot = new Telegraf(botToken);
    this.allowedUserIds = allowedUserIds;
    this.uploadDir = uploadDir;
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Start command
    this.bot.start((ctx) => this.handleStart(ctx));

    // Help command
    this.bot.help((ctx) => this.handleHelp(ctx));

    // List invoices command
    this.bot.command('invoices', (ctx) => this.handleListInvoices(ctx));

    // Get specific invoice
    this.bot.command('get', (ctx) => this.handleGetInvoice(ctx));

    // Photo handler
    this.bot.on(message('photo'), (ctx) => this.handlePhoto(ctx));

    // Document handler
    this.bot.on(message('document'), (ctx) => this.handleDocument(ctx));

    // Error handler
    this.bot.catch((err, ctx) => {
      logger.error('Bot error:', err);
      ctx.reply('❌ Произошла ошибка при обработке запроса');
    });
  }

  private isAuthorized(userId: number): boolean {
    return this.allowedUserIds.includes(userId);
  }

  private async handleStart(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isAuthorized(userId)) {
      await ctx.reply('❌ У вас нет доступа к этому боту');
      return;
    }

    await ctx.reply(
      '👋 Добро пожаловать в FoodFlow Invoice Bot!\n\n' +
      '📸 Отправьте фото накладной для обработки\n' +
      '📄 Или отправьте документ (PDF, изображение)\n\n' +
      'Бот автоматически:\n' +
      '✅ Распознает текст накладной\n' +
      '✅ Извлечет информацию о товарах\n' +
      '✅ Создаст приход на склад\n' +
      '✅ Сохранит накладную для просмотра\n\n' +
      'Команды:\n' +
      '/invoices - список всех накладных\n' +
      '/get <id> - получить накладную по ID\n' +
      '/help - справка'
    );
  }

  private async handleHelp(ctx: Context): Promise<void> {
    await ctx.reply(
      '📚 Справка по использованию бота:\n\n' +
      '1. Отправьте фото или документ накладной\n' +
      '2. Бот распознает текст и извлечет данные\n' +
      '3. Проверьте результат\n' +
      '4. Подтвердите создание прихода\n\n' +
      'Команды:\n' +
      '/invoices - список накладных\n' +
      '/get <id> - просмотр накладной\n' +
      '/start - начать работу'
    );
  }

  private async handleListInvoices(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isAuthorized(userId)) {
      await ctx.reply('❌ У вас нет доступа');
      return;
    }

    if (this.invoices.size === 0) {
      await ctx.reply('📋 Накладных пока нет');
      return;
    }

    const invoiceList = Array.from(this.invoices.values())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 20)
      .map((inv, idx) => {
        const status = inv.status === 'completed' ? '✅' :
                      inv.status === 'processing' ? '⏳' :
                      inv.status === 'failed' ? '❌' : '⏸️';
        const date = inv.createdAt.toLocaleDateString('ru-RU');
        const supplier = inv.supplierName || 'Не указан';
        const total = inv.totalAmount.toFixed(2);
        return `${idx + 1}. ${status} ID: ${inv.id}\n   ${supplier} | ${date} | ${total} ₽`;
      })
      .join('\n\n');

    await ctx.reply(`📋 Последние накладные:\n\n${invoiceList}\n\nИспользуйте /get <id> для просмотра`);
  }

  private async handleGetInvoice(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isAuthorized(userId)) {
      await ctx.reply('❌ У вас нет доступа');
      return;
    }

    const args = ctx.message && 'text' in ctx.message ? ctx.message.text.split(' ') : [];
    if (args.length < 2) {
      await ctx.reply('❌ Укажите ID накладной: /get <id>');
      return;
    }

    const invoiceId = args[1];
    const invoice = this.invoices.get(invoiceId);

    if (!invoice) {
      await ctx.reply('❌ Накладная не найдена');
      return;
    }

    const statusEmoji = invoice.status === 'completed' ? '✅' :
                       invoice.status === 'processing' ? '⏳' :
                       invoice.status === 'failed' ? '❌' : '⏸️';

    let message = `${statusEmoji} Накладная #${invoice.id}\n\n`;
    message += `📅 Дата: ${invoice.createdAt.toLocaleString('ru-RU')}\n`;
    message += `🏢 Поставщик: ${invoice.supplierName || 'Не указан'}\n`;
    message += `📄 Номер: ${invoice.invoiceNumber || 'Не указан'}\n`;
    message += `💰 Сумма: ${invoice.totalAmount.toFixed(2)} ${invoice.currency}\n`;
    message += `📊 Статус: ${invoice.status}\n\n`;

    if (invoice.items.length > 0) {
      message += '📦 Товары:\n';
      invoice.items.forEach((item, idx) => {
        message += `${idx + 1}. ${item.name}\n`;
        message += `   ${item.quantity} ${item.unit} × ${item.pricePerUnit} = ${item.totalPrice} ₽\n`;
      });
    }

    if (invoice.notes) {
      message += `\n📝 Примечания: ${invoice.notes}`;
    }

    await ctx.reply(message);

    // Send photo if available
    if (invoice.photoUrl) {
      try {
        await ctx.replyWithPhoto({ source: invoice.photoUrl });
      } catch (error) {
        logger.error('Failed to send photo:', error);
      }
    }
  }

  private async handlePhoto(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isAuthorized(userId)) {
      await ctx.reply('❌ У вас нет доступа');
      return;
    }

    try {
      await ctx.reply('📸 Получено фото. Начинаю обработку...');

      const photo = ctx.message && 'photo' in ctx.message ? ctx.message.photo : null;
      if (!photo || photo.length === 0) {
        await ctx.reply('❌ Не удалось получить фото');
        return;
      }

      // Get the highest resolution photo
      const fileId = photo[photo.length - 1].file_id;
      const file = await ctx.telegram.getFile(fileId);

      if (!file.file_path) {
        await ctx.reply('❌ Не удалось получить файл');
        return;
      }

      // Download photo
      const fileUrl = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
      const fileName = `invoice_${Date.now()}_${userId}.jpg`;
      const filePath = path.join(this.uploadDir, fileName);

      await this.downloadFile(fileUrl, filePath);
      logger.info(`Photo downloaded: ${filePath}`);

      await ctx.reply('🔍 Распознаю текст...');

      // Process with OCR
      const ocrText = await ocrService.processImage(filePath);
      logger.info(`OCR completed, extracted ${ocrText.length} characters`);

      await ctx.reply('📝 Текст распознан. Извлекаю данные...');

      // Parse invoice
      const invoiceData = await invoiceParserService.parseInvoice(ocrText, filePath);
      invoiceData.telegramUserId = userId;
      invoiceData.telegramUsername = ctx.from?.username;

      // Save invoice
      this.invoices.set(invoiceData.id, invoiceData);

      // Send confirmation
      let confirmMessage = `✅ Накладная обработана!\n\n`;
      confirmMessage += `🏢 Поставщик: ${invoiceData.supplierName || 'Не определен'}\n`;
      confirmMessage += `💰 Сумма: ${invoiceData.totalAmount.toFixed(2)} ${invoiceData.currency}\n`;
      confirmMessage += `📦 Товаров: ${invoiceData.items.length}\n\n`;

      if (invoiceData.items.length > 0) {
        confirmMessage += 'Товары:\n';
        invoiceData.items.slice(0, 5).forEach((item, idx) => {
          confirmMessage += `${idx + 1}. ${item.name} - ${item.quantity} ${item.unit}\n`;
        });
        if (invoiceData.items.length > 5) {
          confirmMessage += `... и еще ${invoiceData.items.length - 5} товаров\n`;
        }
      }

      confirmMessage += `\n🆔 ID накладной: ${invoiceData.id}`;
      await ctx.reply(confirmMessage);

      // Send to inventory API
      await ctx.reply('📤 Отправляю данные на склад...');

      try {
        await inventoryApiService.createInventoryArrival(invoiceData);
        invoiceData.status = 'completed';
        invoiceData.processedAt = new Date();
        await ctx.reply('✅ Приход на склад создан успешно!');
      } catch (error) {
        logger.error('Failed to create inventory arrival:', error);
        invoiceData.status = 'failed';
        invoiceData.notes = `Ошибка создания прихода: ${error}`;
        await ctx.reply('⚠️ Накладная сохранена, но не удалось создать приход на складе. Обратитесь к администратору.');
      }

    } catch (error) {
      logger.error('Error processing photo:', error);
      await ctx.reply(`❌ Ошибка обработки: ${error}`);
    }
  }

  private async handleDocument(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isAuthorized(userId)) {
      await ctx.reply('❌ У вас нет доступа');
      return;
    }

    try {
      await ctx.reply('📄 Получен документ. Начинаю обработку...');

      const document = ctx.message && 'document' in ctx.message ? ctx.message.document : null;
      if (!document) {
        await ctx.reply('❌ Не удалось получить документ');
        return;
      }

      // Check file type
      const mimeType = document.mime_type || '';
      const fileName = document.file_name || 'unknown';

      if (!mimeType.startsWith('image/') && mimeType !== 'application/pdf') {
        await ctx.reply('❌ Поддерживаются только изображения и PDF файлы');
        return;
      }

      // Get file
      const file = await ctx.telegram.getFile(document.file_id);

      if (!file.file_path) {
        await ctx.reply('❌ Не удалось получить файл');
        return;
      }

      // Download document
      const fileUrl = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
      const ext = path.extname(fileName) || (mimeType === 'application/pdf' ? '.pdf' : '.jpg');
      const localFileName = `invoice_${Date.now()}_${userId}${ext}`;
      const filePath = path.join(this.uploadDir, localFileName);

      await this.downloadFile(fileUrl, filePath);
      logger.info(`Document downloaded: ${filePath}`);

      // For now, handle images only (PDF support can be added later)
      if (mimeType.startsWith('image/')) {
        await ctx.reply('🔍 Распознаю текст...');

        const ocrText = await ocrService.processImage(filePath);
        const invoiceData = await invoiceParserService.parseInvoice(ocrText, filePath);
        invoiceData.telegramUserId = userId;
        invoiceData.telegramUsername = ctx.from?.username;
        invoiceData.documentUrl = filePath;

        this.invoices.set(invoiceData.id, invoiceData);

        await ctx.reply(`✅ Документ обработан!\n🆔 ID: ${invoiceData.id}\n💰 Сумма: ${invoiceData.totalAmount} ${invoiceData.currency}`);

        await inventoryApiService.createInventoryArrival(invoiceData);
        invoiceData.status = 'completed';
        await ctx.reply('✅ Приход на склад создан!');
      } else {
        await ctx.reply('ℹ️ PDF документы пока не поддерживаются. Отправьте изображение накладной.');
      }

    } catch (error) {
      logger.error('Error processing document:', error);
      await ctx.reply(`❌ Ошибка обработки документа: ${error}`);
    }
  }

  private async downloadFile(url: string, filePath: string): Promise<void> {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    // Ensure upload directory exists
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const writer = require('fs').createWriteStream(filePath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async launch(): Promise<void> {
    await ocrService.initialize();
    await this.bot.launch();
    logger.info('Bot started successfully');
  }

  async stop(): Promise<void> {
    this.bot.stop('SIGINT');
    await ocrService.terminate();
    logger.info('Bot stopped');
  }

  getBot(): Telegraf {
    return this.bot;
  }
}
