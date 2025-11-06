import axios, { AxiosInstance } from 'axios';
import { Invoice, InventoryUpdate } from '../models/invoice.model';
import { logger } from '../utils/logger';

export class InventoryApiService {
  private api: AxiosInstance;
  private inventoryApiUrl: string;

  constructor() {
    this.inventoryApiUrl = process.env.INVENTORY_API_URL || 'http://restaurant-service:3002/api/inventory';

    this.api = axios.create({
      baseURL: this.inventoryApiUrl,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  async createInventoryArrival(invoice: Invoice): Promise<void> {
    try {
      logger.info(`Creating inventory arrival for invoice ${invoice.id}`);

      // Map invoice items to inventory updates
      const inventoryUpdates: InventoryUpdate[] = invoice.items.map(item => ({
        itemId: item.inventoryId || 0, // Will need to match or create new items
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
        costPrice: item.pricePerUnit,
        supplierId: invoice.supplierName ? undefined : undefined, // TODO: map supplier name to ID
        invoiceId: invoice.id,
        notes: `Накладная ${invoice.invoiceNumber || invoice.id} от ${invoice.supplierName || 'неизвестного поставщика'}`
      }));

      // Send batch arrival to inventory API
      const response = await this.api.post('/arrivals', {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        supplierName: invoice.supplierName,
        date: invoice.invoiceDate || invoice.createdAt,
        items: inventoryUpdates,
        totalAmount: invoice.totalAmount,
        currency: invoice.currency,
        notes: `Обработано через Telegram Bot от ${invoice.telegramUsername || invoice.telegramUserId}`
      });

      logger.info(`Inventory arrival created successfully: ${response.data?.arrivalId || 'unknown'}`);

      // Alternatively, update items one by one if batch endpoint doesn't exist
      // await this.updateInventoryItems(inventoryUpdates);

    } catch (error) {
      logger.error('Failed to create inventory arrival:', error);

      if (axios.isAxiosError(error)) {
        if (error.response) {
          throw new Error(`API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
        } else if (error.request) {
          throw new Error('API unavailable: No response from server');
        }
      }

      throw error;
    }
  }

  private async updateInventoryItems(updates: InventoryUpdate[]): Promise<void> {
    const results = await Promise.allSettled(
      updates.map(update => this.updateInventoryItem(update))
    );

    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
      logger.warn(`${failures.length} items failed to update:`, failures);
      throw new Error(`Failed to update ${failures.length}/${updates.length} items`);
    }

    logger.info(`Successfully updated ${updates.length} inventory items`);
  }

  private async updateInventoryItem(update: InventoryUpdate): Promise<void> {
    try {
      // Try to find existing item by name
      const existingItems = await this.api.get('/items', {
        params: { name: update.name }
      });

      let itemId = update.itemId;

      if (existingItems.data && existingItems.data.length > 0) {
        // Item exists, update it
        itemId = existingItems.data[0].id;
        await this.api.patch(`/items/${itemId}`, {
          quantity: { increment: update.quantity }, // Increment quantity
          costPrice: update.costPrice, // Update cost price
          lastPurchaseDate: new Date(),
          notes: update.notes
        });
      } else {
        // Item doesn't exist, create it
        const newItem = await this.api.post('/items', {
          name: update.name,
          quantity: update.quantity,
          unit: update.unit,
          costPrice: update.costPrice,
          minQuantity: 0, // Default, can be configured later
          category: 'Прочее', // Default category
          notes: update.notes
        });
        itemId = newItem.data.id;
      }

      // Record arrival transaction
      await this.api.post('/transactions', {
        itemId,
        type: 'arrival',
        quantity: update.quantity,
        costPrice: update.costPrice,
        invoiceId: update.invoiceId,
        supplierId: update.supplierId,
        date: new Date(),
        notes: update.notes
      });

      logger.info(`Updated inventory item: ${update.name} (+${update.quantity} ${update.unit})`);

    } catch (error) {
      logger.error(`Failed to update item ${update.name}:`, error);
      throw error;
    }
  }

  async getInventoryItems(): Promise<any[]> {
    try {
      const response = await this.api.get('/items');
      return response.data;
    } catch (error) {
      logger.error('Failed to get inventory items:', error);
      return [];
    }
  }

  async findItemByName(name: string): Promise<any | null> {
    try {
      const response = await this.api.get('/items', {
        params: { name }
      });
      return response.data && response.data.length > 0 ? response.data[0] : null;
    } catch (error) {
      logger.error(`Failed to find item by name ${name}:`, error);
      return null;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.api.get('/health');
      return response.status === 200;
    } catch (error) {
      logger.error('Inventory API health check failed:', error);
      return false;
    }
  }
}

export const inventoryApiService = new InventoryApiService();
