import { Invoice, InvoiceItem } from '../models/invoice.model';
import { logger } from '../utils/logger';
import OpenAI from 'openai';

export class InvoiceParserService {
  private openai: OpenAI | null = null;

  constructor() {
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });
    }
  }

  async parseInvoice(ocrText: string, photoUrl?: string): Promise<Invoice> {
    logger.info('Parsing invoice from OCR text');

    // Try AI-powered parsing first if available
    if (this.openai) {
      try {
        return await this.parseWithAI(ocrText, photoUrl);
      } catch (error) {
        logger.warn('AI parsing failed, falling back to regex:', error);
      }
    }

    // Fallback to regex-based parsing
    return this.parseWithRegex(ocrText, photoUrl);
  }

  private async parseWithAI(ocrText: string, photoUrl?: string): Promise<Invoice> {
    const prompt = `
Проанализируй текст накладной и извлеки следующую информацию в формате JSON:

{
  "supplierName": "название поставщика",
  "invoiceNumber": "номер накладной",
  "invoiceDate": "дата в формате YYYY-MM-DD",
  "items": [
    {
      "name": "название товара",
      "quantity": число,
      "unit": "единица измерения (кг, л, шт и т.д.)",
      "pricePerUnit": число,
      "totalPrice": число
    }
  ],
  "totalAmount": общая_сумма_число,
  "currency": "валюта (RUB, USD и т.д.)"
}

Текст накладной:
${ocrText}

Верни только JSON без дополнительного текста.
`;

    const completion = await this.openai!.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: 'Ты эксперт по обработке накладных и счетов. Извлекай данные точно и структурированно.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.1,
      max_tokens: 2000
    });

    const response = completion.choices[0]?.message?.content;
    if (!response) {
      throw new Error('Empty AI response');
    }

    // Extract JSON from response (in case it's wrapped in markdown)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in AI response');
    }

    const parsedData = JSON.parse(jsonMatch[0]);

    return {
      id: this.generateInvoiceId(),
      telegramUserId: 0, // Will be set by bot service
      supplierName: parsedData.supplierName,
      invoiceNumber: parsedData.invoiceNumber,
      invoiceDate: parsedData.invoiceDate ? new Date(parsedData.invoiceDate) : undefined,
      items: parsedData.items,
      totalAmount: parsedData.totalAmount,
      currency: parsedData.currency || 'RUB',
      photoUrl,
      ocrText,
      status: 'processing',
      createdAt: new Date(),
      updatedAt: new Date()
    };
  }

  private parseWithRegex(ocrText: string, photoUrl?: string): Invoice {
    logger.info('Using regex-based parsing');

    const invoice: Invoice = {
      id: this.generateInvoiceId(),
      telegramUserId: 0,
      items: [],
      totalAmount: 0,
      currency: 'RUB',
      photoUrl,
      ocrText,
      status: 'processing',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Extract supplier name (common patterns)
    const supplierPatterns = [
      /поставщик[:\s]+([^\n]+)/i,
      /продавец[:\s]+([^\n]+)/i,
      /организация[:\s]+([^\n]+)/i,
      /ООО["\s]+([^\n"]+)/i,
      /ИП["\s]+([^\n"]+)/i
    ];

    for (const pattern of supplierPatterns) {
      const match = ocrText.match(pattern);
      if (match) {
        invoice.supplierName = match[1].trim();
        break;
      }
    }

    // Extract invoice number
    const invoiceNumberPatterns = [
      /накладная[№\s#]+(\d+)/i,
      /счет[№\s#]+(\d+)/i,
      /документ[№\s#]+(\d+)/i,
      /№\s*(\d+)/
    ];

    for (const pattern of invoiceNumberPatterns) {
      const match = ocrText.match(pattern);
      if (match) {
        invoice.invoiceNumber = match[1];
        break;
      }
    }

    // Extract date
    const datePatterns = [
      /(\d{2})\.(\d{2})\.(\d{4})/,
      /(\d{4})-(\d{2})-(\d{2})/
    ];

    for (const pattern of datePatterns) {
      const match = ocrText.match(pattern);
      if (match) {
        if (pattern.source.includes('\\.')) {
          // DD.MM.YYYY
          invoice.invoiceDate = new Date(`${match[3]}-${match[2]}-${match[1]}`);
        } else {
          // YYYY-MM-DD
          invoice.invoiceDate = new Date(match[0]);
        }
        break;
      }
    }

    // Extract items (this is the tricky part)
    // Look for table-like structures with products
    const lines = ocrText.split('\n');
    const items: InvoiceItem[] = [];

    // Common patterns for item lines:
    // "Мука пшеничная  50  кг  45.00  2250.00"
    // "1. Сахар  25 кг  60.00  1500.00"
    const itemPattern = /^[\d\.\s]*([А-Яа-яёЁ\s\w-]+?)\s+(\d+(?:[.,]\d+)?)\s*(кг|г|л|мл|шт|упак|кор|м)[\s\.]*(\d+(?:[.,]\d+)?)\s*(?:руб)?[\s\.]*(\d+(?:[.,]\d+)?)?/i;

    for (const line of lines) {
      const match = line.match(itemPattern);
      if (match) {
        const name = match[1].trim();
        const quantity = parseFloat(match[2].replace(',', '.'));
        const unit = match[3];
        const pricePerUnit = parseFloat(match[4].replace(',', '.'));
        const totalPrice = match[5] ? parseFloat(match[5].replace(',', '.')) : quantity * pricePerUnit;

        // Validate that this looks like a real item
        if (name.length > 2 && quantity > 0 && pricePerUnit > 0) {
          items.push({
            name,
            quantity,
            unit,
            pricePerUnit,
            totalPrice
          });
        }
      }
    }

    invoice.items = items;

    // Extract total amount
    const totalPatterns = [
      /итого[:\s]+(\d+(?:[.,]\d+)?)/i,
      /всего[:\s]+(\d+(?:[.,]\d+)?)/i,
      /сумма[:\s]+(\d+(?:[.,]\d+)?)/i,
      /к\s+оплате[:\s]+(\d+(?:[.,]\d+)?)/i
    ];

    for (const pattern of totalPatterns) {
      const match = ocrText.match(pattern);
      if (match) {
        invoice.totalAmount = parseFloat(match[1].replace(',', '.'));
        break;
      }
    }

    // If total not found, calculate from items
    if (invoice.totalAmount === 0 && items.length > 0) {
      invoice.totalAmount = items.reduce((sum, item) => sum + item.totalPrice, 0);
    }

    // Extract currency
    if (ocrText.includes('USD') || ocrText.includes('$')) {
      invoice.currency = 'USD';
    } else if (ocrText.includes('EUR') || ocrText.includes('€')) {
      invoice.currency = 'EUR';
    } else {
      invoice.currency = 'RUB';
    }

    logger.info(`Parsed invoice: ${items.length} items, total: ${invoice.totalAmount} ${invoice.currency}`);

    return invoice;
  }

  private generateInvoiceId(): string {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 10000);
    return `INV-${timestamp}-${random}`;
  }

  // Helper method to validate invoice data
  validateInvoice(invoice: Invoice): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!invoice.supplierName) {
      errors.push('Supplier name is missing');
    }

    if (invoice.items.length === 0) {
      errors.push('No items found in invoice');
    }

    if (invoice.totalAmount <= 0) {
      errors.push('Invalid total amount');
    }

    for (let i = 0; i < invoice.items.length; i++) {
      const item = invoice.items[i];
      if (!item.name || item.name.length < 2) {
        errors.push(`Item ${i + 1}: invalid name`);
      }
      if (item.quantity <= 0) {
        errors.push(`Item ${i + 1}: invalid quantity`);
      }
      if (item.pricePerUnit <= 0) {
        errors.push(`Item ${i + 1}: invalid price`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

export const invoiceParserService = new InvoiceParserService();
