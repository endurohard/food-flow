export interface InvoiceItem {
  name: string;
  quantity: number;
  unit: string;
  pricePerUnit: number;
  totalPrice: number;
  inventoryId?: number;
}

export interface Invoice {
  id: string;
  telegramUserId: number;
  telegramUsername?: string;
  supplierName?: string;
  invoiceNumber?: string;
  invoiceDate?: Date;
  items: InvoiceItem[];
  totalAmount: number;
  currency: string;
  photoUrl?: string;
  documentUrl?: string;
  ocrText?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  processedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  notes?: string;
}

export interface InventoryUpdate {
  itemId: number;
  name: string;
  quantity: number;
  unit: string;
  costPrice: number;
  supplierId?: number;
  invoiceId: string;
  notes?: string;
}
