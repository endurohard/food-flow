import axios from 'axios';
import { logger } from '../utils/logger';

// ========== Типы ==========

export interface YooKassaAmount {
  value: string;   // "100.00"
  currency: string; // "RUB"
}

export interface YooKassaReceiptItem {
  description: string;
  quantity: string;
  amount: YooKassaAmount;
  vat_code: number; // 1=без НДС, 2=0%, 3=10%, 4=20%, 5=расч.10/110, 6=расч.20/120
  payment_subject: string;
  payment_mode: string;
}

export interface YooKassaReceipt {
  customer: { email?: string; phone?: string };
  items: YooKassaReceiptItem[];
}

export interface YooKassaPayment {
  id: string;
  status: 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled';
  amount: YooKassaAmount;
  description?: string;
  confirmation?: {
    type: string;
    confirmation_url?: string;
  };
  metadata?: Record<string, string>;
  created_at: string;
  paid: boolean;
  refundable: boolean;
  receipt_registration?: string;
}

export interface YooKassaRefund {
  id: string;
  status: 'succeeded' | 'canceled';
  amount: YooKassaAmount;
  payment_id: string;
  created_at: string;
}

export interface CreatePaymentParams {
  amount: number;
  currency?: string;
  orderId: string;
  description: string;
  receipt?: {
    customerEmail?: string;
    items: Array<{
      name: string;
      quantity: number;
      price: number;
      vatCode?: number;
    }>;
  };
  idempotencyKey: string;
}

export interface CreateRefundParams {
  paymentId: string;
  amount: number;
  idempotencyKey: string;
}

// ========== Сервис ==========

export class YooKassaService {
  private client: ReturnType<typeof axios.create>;
  private returnUrl: string;

  constructor(shopId: string, secretKey: string, returnUrl: string) {
    this.returnUrl = returnUrl;
    this.client = axios.create({
      baseURL: 'https://api.yookassa.ru/v3',
      auth: { username: shopId, password: secretKey },
      headers: { 'Content-Type': 'application/json' },
      timeout: 15_000
    });
  }

  /**
   * Создание платежа через YooKassa API.
   * Включает данные фискального чека (54-ФЗ) если передан receipt.
   */
  async createPayment(params: CreatePaymentParams): Promise<YooKassaPayment> {
    const currency = params.currency || 'RUB';

    const body: Record<string, any> = {
      amount: {
        value: params.amount.toFixed(2),
        currency
      },
      confirmation: {
        type: 'redirect',
        return_url: this.returnUrl
      },
      description: params.description,
      metadata: {
        order_id: params.orderId
      },
      capture: true // Автоматическое подтверждение платежа
    };

    // 54-ФЗ: формируем блок receipt для фискализации
    if (params.receipt && params.receipt.items.length > 0) {
      body.receipt = {
        customer: {
          email: params.receipt.customerEmail || undefined
        },
        items: params.receipt.items.map(item => ({
          description: item.name,
          quantity: String(item.quantity),
          amount: {
            value: item.price.toFixed(2),
            currency
          },
          vat_code: item.vatCode || 1,  // По умолчанию: без НДС
          payment_subject: 'commodity',
          payment_mode: 'full_payment'
        }))
      };
    }

    try {
      const response = await this.client.post<YooKassaPayment>('/payments', body, {
        headers: { 'Idempotence-Key': params.idempotencyKey }
      });

      logger.info('YooKassa payment created', {
        paymentId: response.data.id,
        orderId: params.orderId,
        amount: params.amount,
        status: response.data.status
      });

      return response.data;
    } catch (error) {
      this.handleError('createPayment', error);
      throw error; // re-throw after logging
    }
  }

  /**
   * Получение информации о платеже по ID.
   */
  async getPayment(paymentId: string): Promise<YooKassaPayment> {
    try {
      const response = await this.client.get<YooKassaPayment>(`/payments/${paymentId}`);
      return response.data;
    } catch (error) {
      this.handleError('getPayment', error);
      throw error;
    }
  }

  /**
   * Создание возврата по платежу.
   */
  async createRefund(params: CreateRefundParams): Promise<YooKassaRefund> {
    const body = {
      payment_id: params.paymentId,
      amount: {
        value: params.amount.toFixed(2),
        currency: 'RUB'
      }
    };

    try {
      const response = await this.client.post<YooKassaRefund>('/refunds', body, {
        headers: { 'Idempotence-Key': params.idempotencyKey }
      });

      logger.info('YooKassa refund created', {
        refundId: response.data.id,
        paymentId: params.paymentId,
        amount: params.amount,
        status: response.data.status
      });

      return response.data;
    } catch (error) {
      this.handleError('createRefund', error);
      throw error;
    }
  }

  private handleError(method: string, error: unknown): void {
    if (axios.isAxiosError(error)) {
      logger.error(`YooKassa ${method} failed`, {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message
      });
    } else {
      logger.error(`YooKassa ${method} unexpected error`, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

export default YooKassaService;
