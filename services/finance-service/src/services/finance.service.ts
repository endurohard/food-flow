import pkg from 'pg';
const { Pool } = pkg;
import crypto from 'crypto';
import { YooKassaService } from './yookassa.service';
import { config } from '../config';
import { logger } from '../utils/logger';

export class FinanceService {
  private pool: InstanceType<typeof Pool>;
  private yookassaService: YooKassaService;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
    this.yookassaService = new YooKassaService(
      config.yookassa.shopId,
      config.yookassa.secretKey,
      config.yookassa.returnUrl
    );
  }

  // ========== КАССЫ ==========

  async openRegister(restaurantId: string, userId: string, openingBalance: number): Promise<any> {
    // Проверяем — нет ли уже открытой кассы в этом ресторане
    const existing = await this.pool.query(
      `SELECT id FROM cash_registers WHERE restaurant_id = $1 AND status = 'open'`,
      [restaurantId]
    );
    if (existing.rows.length > 0) throw new Error('Register already open for this restaurant');

    const result = await this.pool.query(
      `UPDATE cash_registers
       SET status = 'open', opened_by = $1, opened_at = NOW(),
           opening_balance = $2, current_balance = $2
       WHERE restaurant_id = $3 AND status = 'closed'
       RETURNING *`,
      [userId, openingBalance, restaurantId]
    );
    return result.rows[0] || null;
  }

  async closeRegister(registerId: string, userId: string): Promise<any> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Блокируем кассу, чтобы никто не добавил операцию между чтением и закрытием
      const reg = await client.query(
        `SELECT current_balance, enterprise_id
         FROM cash_registers
         WHERE id = $1 AND status = 'open'
         FOR UPDATE`,
        [registerId]
      );
      if (!reg.rows[0]) throw new Error('Register not found or already closed');

      await client.query(
        `INSERT INTO cash_operations (register_id, enterprise_id, operation_type, amount, payment_method, performed_by, description)
         VALUES ($1, $2, 'encashment', $3, 'cash', $4, 'Закрытие смены — инкассация')`,
        [registerId, reg.rows[0].enterprise_id, reg.rows[0].current_balance, userId]
      );

      const result = await client.query(
        `UPDATE cash_registers
         SET status = 'closed', current_balance = 0
         WHERE id = $1
         RETURNING *`,
        [registerId]
      );

      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async addCashOperation(data: {
    registerId: string;
    enterpriseId?: string;
    operationType: string;
    amount: number;
    paymentMethod: string;
    orderId?: string;
    performedBy: string;
    description?: string;
  }): Promise<any> {
    // Определяем знак операции: пополнение или списание
    const isIncoming = ['sale', 'cash_in'].includes(data.operationType);
    const delta = isIncoming ? data.amount : -data.amount;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Блокируем строку кассы на время обновления баланса
      const reg = await client.query(
        `SELECT id, status FROM cash_registers WHERE id = $1 FOR UPDATE`,
        [data.registerId]
      );
      if (!reg.rows[0]) throw new Error('Register not found');
      if (reg.rows[0].status !== 'open') throw new Error('Register is not open');

      const result = await client.query(
        `INSERT INTO cash_operations
           (register_id, enterprise_id, operation_type, amount, payment_method, order_id, performed_by, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          data.registerId, data.enterpriseId || null, data.operationType,
          data.amount, data.paymentMethod, data.orderId || null,
          data.performedBy, data.description || null
        ]
      );

      await client.query(
        `UPDATE cash_registers SET current_balance = current_balance + $1 WHERE id = $2`,
        [delta, data.registerId]
      );

      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async getCashOperations(registerId: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT co.*, u.first_name, u.last_name
       FROM cash_operations co
       LEFT JOIN users u ON co.performed_by = u.id
       WHERE co.register_id = $1
       ORDER BY co.created_at DESC`,
      [registerId]
    );
    return result.rows;
  }

  async listRegisters(filters: { enterpriseId?: string; restaurantId?: string; status?: string }): Promise<any[]> {
    const conds: string[] = []; const vals: any[] = []; let p = 1;
    if (filters.enterpriseId) { conds.push(`r.enterprise_id = $${p++}`); vals.push(filters.enterpriseId); }
    if (filters.restaurantId) { conds.push(`r.restaurant_id = $${p++}`); vals.push(filters.restaurantId); }
    if (filters.status) { conds.push(`r.status = $${p++}`); vals.push(filters.status); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const result = await this.pool.query(
      `SELECT r.*, u.first_name, u.last_name
       FROM cash_registers r
       LEFT JOIN users u ON r.opened_by = u.id
       ${where}
       ORDER BY r.name ASC`,
      vals
    );
    return result.rows;
  }

  // ========== ПЛАТЕЖИ ==========

  private static sanitizePaymentMetadata(metadata?: Record<string, any>): string {
    if (!metadata) return '{}';
    const FORBIDDEN_KEYS = ['card_number', 'cvv', 'cvc', 'pan', 'expiry', 'exp_date', 'card_holder', 'pin'];
    const sanitized = { ...metadata };
    for (const key of FORBIDDEN_KEYS) {
      delete sanitized[key];
      delete sanitized[key.toUpperCase()];
    }
    return JSON.stringify(sanitized);
  }

  async createPayment(data: {
    orderId: string;
    enterpriseId?: string;
    amount: number;
    paymentMethod: string;
    paymentGateway?: string;
    externalId?: string;
    metadata?: Record<string, any>;
  }): Promise<any> {
    const result = await this.pool.query(
      `INSERT INTO payments
         (order_id, enterprise_id, amount, payment_method, payment_gateway, external_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        data.orderId, data.enterpriseId || null, data.amount,
        data.paymentMethod, data.paymentGateway || null,
        data.externalId || null,
        FinanceService.sanitizePaymentMetadata(data.metadata)
      ]
    );
    return result.rows[0];
  }

  async updatePaymentStatus(paymentId: string, status: string, refundAmount?: number, enterpriseId?: string): Promise<any> {
    const fields: string[] = ['status = $1'];
    const vals: any[] = [status];
    let p = 2;

    if (refundAmount !== undefined) {
      fields.push(`refund_amount = $${p++}`);
      vals.push(refundAmount);
    }

    const whereConds = [`id = $${p++}`];
    vals.push(paymentId);
    if (enterpriseId) {
      whereConds.push(`enterprise_id = $${p++}`);
      vals.push(enterpriseId);
    }
    const result = await this.pool.query(
      `UPDATE payments SET ${fields.join(', ')} WHERE ${whereConds.join(' AND ')} RETURNING *`,
      vals
    );
    return result.rows[0] || null;
  }

  async getPayments(filters: {
    enterpriseId?: string;
    orderId?: string;
    status?: string;
    paymentMethod?: string;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<any[]> {
    const conds: string[] = []; const vals: any[] = []; let p = 1;
    if (filters.enterpriseId) { conds.push(`enterprise_id = $${p++}`); vals.push(filters.enterpriseId); }
    if (filters.orderId) { conds.push(`order_id = $${p++}`); vals.push(filters.orderId); }
    if (filters.status) { conds.push(`status = $${p++}`); vals.push(filters.status); }
    if (filters.paymentMethod) { conds.push(`payment_method = $${p++}`); vals.push(filters.paymentMethod); }
    if (filters.dateFrom) { conds.push(`created_at >= $${p++}`); vals.push(filters.dateFrom); }
    if (filters.dateTo) { conds.push(`created_at <= $${p++}`); vals.push(filters.dateTo); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const result = await this.pool.query(
      `SELECT * FROM payments ${where} ORDER BY created_at DESC`,
      vals
    );
    return result.rows;
  }

  // ========== КАТЕГОРИИ РАСХОДОВ ==========

  async listExpenseCategories(enterpriseId: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT ec.*, parent.name AS parent_name
       FROM expense_categories ec
       LEFT JOIN expense_categories parent ON ec.parent_id = parent.id
       WHERE ec.enterprise_id = $1 AND ec.is_active = true
       ORDER BY parent.name NULLS FIRST, ec.name ASC`,
      [enterpriseId]
    );
    return result.rows;
  }

  async createExpenseCategory(data: {
    enterpriseId: string;
    name: string;
    parentId?: string;
  }): Promise<any> {
    const result = await this.pool.query(
      `INSERT INTO expense_categories (enterprise_id, name, parent_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [data.enterpriseId, data.name, data.parentId || null]
    );
    return result.rows[0];
  }

  // ========== РАСХОДЫ ==========

  async createExpense(data: {
    enterpriseId: string;
    restaurantId?: string;
    categoryId: string;
    amount: number;
    description?: string;
    expenseDate: string;
    recordedBy: string;
    receiptUrl?: string;
  }): Promise<any> {
    const result = await this.pool.query(
      `INSERT INTO expenses
         (enterprise_id, restaurant_id, category_id, amount, description, expense_date, recorded_by, receipt_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        data.enterpriseId, data.restaurantId || null, data.categoryId,
        data.amount, data.description || null, data.expenseDate,
        data.recordedBy, data.receiptUrl || null
      ]
    );
    return result.rows[0];
  }

  async listExpenses(filters: {
    enterpriseId?: string;
    restaurantId?: string;
    categoryId?: string;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<any[]> {
    const conds: string[] = []; const vals: any[] = []; let p = 1;
    if (filters.enterpriseId) { conds.push(`e.enterprise_id = $${p++}`); vals.push(filters.enterpriseId); }
    if (filters.restaurantId) { conds.push(`e.restaurant_id = $${p++}`); vals.push(filters.restaurantId); }
    if (filters.categoryId) { conds.push(`e.category_id = $${p++}`); vals.push(filters.categoryId); }
    if (filters.dateFrom) { conds.push(`e.expense_date >= $${p++}`); vals.push(filters.dateFrom); }
    if (filters.dateTo) { conds.push(`e.expense_date <= $${p++}`); vals.push(filters.dateTo); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const result = await this.pool.query(
      `SELECT e.*, ec.name AS category_name, u.first_name, u.last_name
       FROM expenses e
       LEFT JOIN expense_categories ec ON e.category_id = ec.id
       LEFT JOIN users u ON e.recorded_by = u.id
       ${where}
       ORDER BY e.expense_date DESC`,
      vals
    );
    return result.rows;
  }

  // ========== ОТЧЁТЫ ==========

  async getRevenueReport(filters: {
    restaurantId?: string;
    enterpriseId?: string;
    dateFrom: string;
    dateTo: string;
  }): Promise<any> {
    // Агрегируем платежи со статусом 'completed' за период
    const conds: string[] = [`p.created_at >= $1`, `p.created_at <= $2`, `p.status = 'completed'`];
    const vals: any[] = [filters.dateFrom, filters.dateTo];
    let param = 3;

    if (filters.enterpriseId) { conds.push(`p.enterprise_id = $${param++}`); vals.push(filters.enterpriseId); }

    // Если передан restaurantId — джойним с заказами (orders.restaurant_id)
    let joinClause = '';
    if (filters.restaurantId) {
      joinClause = `INNER JOIN orders o ON p.order_id = o.id`;
      conds.push(`o.restaurant_id = $${param++}`);
      vals.push(filters.restaurantId);
    }

    const where = 'WHERE ' + conds.join(' AND ');

    // Общая выручка и разбивка по способу оплаты
    const totalResult = await this.pool.query(
      `SELECT
         COUNT(*)::int                          AS transactions_count,
         COALESCE(SUM(p.amount), 0)             AS total_revenue,
         COALESCE(SUM(p.refund_amount), 0)      AS total_refunds,
         COALESCE(SUM(p.amount - p.refund_amount), 0) AS net_revenue
       FROM payments p ${joinClause} ${where}`,
      vals
    );

    // Разбивка по способу оплаты
    const byMethodResult = await this.pool.query(
      `SELECT
         p.payment_method,
         COUNT(*)::int             AS count,
         COALESCE(SUM(p.amount), 0) AS total
       FROM payments p ${joinClause} ${where}
       GROUP BY p.payment_method
       ORDER BY total DESC`,
      vals
    );

    // Разбивка по дням
    const byDayResult = await this.pool.query(
      `SELECT
         DATE(p.created_at)            AS date,
         COUNT(*)::int                 AS count,
         COALESCE(SUM(p.amount), 0)    AS revenue
       FROM payments p ${joinClause} ${where}
       GROUP BY DATE(p.created_at)
       ORDER BY date ASC`,
      vals
    );

    return {
      period: { dateFrom: filters.dateFrom, dateTo: filters.dateTo },
      summary: totalResult.rows[0],
      byPaymentMethod: byMethodResult.rows,
      byDay: byDayResult.rows
    };
  }

  async getPnLReport(filters: {
    restaurantId?: string;
    enterpriseId?: string;
    dateFrom: string;
    dateTo: string;
  }): Promise<any> {
    // Получаем выручку через getRevenueReport
    const revenue = await this.getRevenueReport(filters);

    // Суммируем расходы за тот же период
    const expConds: string[] = [`e.expense_date >= $1`, `e.expense_date <= $2`];
    const expVals: any[] = [filters.dateFrom, filters.dateTo];
    let ep = 3;

    if (filters.enterpriseId) { expConds.push(`e.enterprise_id = $${ep++}`); expVals.push(filters.enterpriseId); }
    if (filters.restaurantId) { expConds.push(`e.restaurant_id = $${ep++}`); expVals.push(filters.restaurantId); }

    const expWhere = 'WHERE ' + expConds.join(' AND ');

    const expTotalResult = await this.pool.query(
      `SELECT COALESCE(SUM(e.amount), 0) AS total_expenses FROM expenses e ${expWhere}`,
      expVals
    );

    // Расходы по категориям для детализации
    const expByCatResult = await this.pool.query(
      `SELECT
         ec.name AS category,
         COALESCE(SUM(e.amount), 0) AS total
       FROM expenses e
       LEFT JOIN expense_categories ec ON e.category_id = ec.id
       ${expWhere}
       GROUP BY ec.name
       ORDER BY total DESC`,
      expVals
    );

    const netRevenue = parseFloat(revenue.summary.net_revenue) || 0;
    const totalExpenses = parseFloat(expTotalResult.rows[0].total_expenses) || 0;
    const profit = netRevenue - totalExpenses;
    const margin = netRevenue > 0 ? (profit / netRevenue) * 100 : 0;

    return {
      period: { dateFrom: filters.dateFrom, dateTo: filters.dateTo },
      revenue: {
        gross: parseFloat(revenue.summary.total_revenue) || 0,
        refunds: parseFloat(revenue.summary.total_refunds) || 0,
        net: netRevenue
      },
      expenses: {
        total: totalExpenses,
        byCategory: expByCatResult.rows
      },
      profit,
      marginPercent: parseFloat(margin.toFixed(2))
    };
  }

  // ========== ОНЛАЙН-ОПЛАТА (YooKassa) ==========

  /**
   * Инициировать онлайн-платёж через YooKassa.
   * 1. Вызывает YooKassa API с данными чека (54-ФЗ)
   * 2. Сохраняет запись в таблице payments со статусом pending
   * 3. Возвращает URL для редиректа покупателя на оплату
   */
  async initiateOnlinePayment(params: {
    orderId: string;
    enterpriseId?: string;
    amount: number;
    customerEmail?: string;
    items: Array<{ name: string; quantity: number; price: number; vatCode?: number }>;
  }): Promise<{ payment: any; confirmationUrl: string }> {
    const idempotencyKey = crypto.randomUUID();
    const description = `Оплата заказа ${params.orderId}`;

    // Вызываем YooKassa API с receipt для фискализации по 54-ФЗ
    const yooPayment = await this.yookassaService.createPayment({
      amount: params.amount,
      currency: 'RUB',
      orderId: params.orderId,
      description,
      receipt: params.items.length > 0 ? {
        customerEmail: params.customerEmail,
        items: params.items
      } : undefined,
      idempotencyKey
    });

    const confirmationUrl = yooPayment.confirmation?.confirmation_url || '';

    // Сохраняем платёж в БД
    const payment = await this.createPayment({
      orderId: params.orderId,
      enterpriseId: params.enterpriseId,
      amount: params.amount,
      paymentMethod: 'online',
      paymentGateway: 'yookassa',
      externalId: yooPayment.id,
      metadata: {
        yookassa_status: yooPayment.status,
        confirmation_url: confirmationUrl,
        idempotency_key: idempotencyKey
      }
    });

    logger.info('Online payment initiated', {
      paymentId: payment.id,
      externalId: yooPayment.id,
      orderId: params.orderId,
      amount: params.amount
    });

    return { payment, confirmationUrl };
  }

  /**
   * Обработка вебхука от YooKassa.
   * - payment.succeeded  -> статус completed + создание фискального чека
   * - payment.canceled   -> статус failed
   * - refund.succeeded   -> статус refunded + сумма возврата
   */
  async processPaymentWebhook(payload: {
    event: string;
    object: any;
  }): Promise<void> {
    const { event, object: obj } = payload;

    logger.info('Processing YooKassa webhook', { event, objectId: obj?.id });

    if (event === 'payment.succeeded') {
      // Находим наш платёж по external_id
      const paymentResult = await this.pool.query(
        `SELECT id, order_id, enterprise_id, amount FROM payments WHERE external_id = $1`,
        [obj.id]
      );
      const localPayment = paymentResult.rows[0];
      if (!localPayment) {
        logger.warn('Webhook: payment not found for external_id', { externalId: obj.id });
        return;
      }

      // Обновляем статус на completed
      await this.updatePaymentStatus(localPayment.id, 'completed');

      // Создаём фискальный чек (данные берём из YooKassa-ответа)
      const totalAmount = parseFloat(obj.amount?.value) || parseFloat(localPayment.amount);
      // Примерный расчёт НДС из metadata, если ОФД вернул — используем, иначе 0
      const vatAmount = 0;

      await this.createFiscalReceipt({
        orderId: localPayment.order_id,
        enterpriseId: localPayment.enterprise_id || undefined,
        receiptNumber: `YK-${obj.id}`,
        fiscalSign: obj.receipt_registration || undefined,
        receiptType: 'sale',
        totalAmount,
        vatAmount
      });

      logger.info('Payment completed and fiscal receipt created', {
        paymentId: localPayment.id,
        externalId: obj.id
      });

    } else if (event === 'payment.canceled') {
      const paymentResult = await this.pool.query(
        `SELECT id FROM payments WHERE external_id = $1`,
        [obj.id]
      );
      const localPayment = paymentResult.rows[0];
      if (!localPayment) {
        logger.warn('Webhook: payment not found for external_id', { externalId: obj.id });
        return;
      }

      await this.updatePaymentStatus(localPayment.id, 'failed');
      logger.info('Payment canceled', { paymentId: localPayment.id, externalId: obj.id });

    } else if (event === 'refund.succeeded') {
      const paymentResult = await this.pool.query(
        `SELECT id, order_id, enterprise_id FROM payments WHERE external_id = $1`,
        [obj.payment_id]
      );
      const localPayment = paymentResult.rows[0];
      if (!localPayment) {
        logger.warn('Webhook: payment not found for refund', { paymentId: obj.payment_id });
        return;
      }

      const refundAmount = parseFloat(obj.amount?.value) || 0;
      await this.updatePaymentStatus(localPayment.id, 'refunded', refundAmount);

      // Фискальный чек возврата
      await this.createFiscalReceipt({
        orderId: localPayment.order_id,
        enterpriseId: localPayment.enterprise_id || undefined,
        receiptNumber: `YK-REF-${obj.id}`,
        receiptType: 'refund',
        totalAmount: refundAmount,
        vatAmount: 0
      });

      logger.info('Refund completed and fiscal receipt created', {
        paymentId: localPayment.id,
        refundId: obj.id,
        refundAmount
      });

    } else {
      logger.warn('Unknown webhook event', { event });
    }
  }

  /**
   * Создание записи фискального чека в БД.
   */
  async createFiscalReceipt(params: {
    orderId: string;
    registerId?: string;
    enterpriseId?: string;
    receiptNumber: string;
    fiscalSign?: string;
    fiscalDocumentNumber?: string;
    ofdUrl?: string;
    receiptType: 'sale' | 'refund';
    totalAmount: number;
    vatAmount: number;
  }): Promise<any> {
    const result = await this.pool.query(
      `INSERT INTO fiscal_receipts
         (order_id, register_id, enterprise_id, receipt_number, fiscal_sign,
          fiscal_document_number, ofd_url, receipt_type, total_amount, vat_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        params.orderId,
        params.registerId || null,
        params.enterpriseId || null,
        params.receiptNumber,
        params.fiscalSign || null,
        params.fiscalDocumentNumber || null,
        params.ofdUrl || null,
        params.receiptType,
        params.totalAmount,
        params.vatAmount
      ]
    );
    return result.rows[0];
  }

  /**
   * Получение фискальных чеков по заказу.
   */
  async getFiscalReceipts(orderId: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT * FROM fiscal_receipts WHERE order_id = $1 ORDER BY printed_at DESC`,
      [orderId]
    );
    return result.rows;
  }

  async close(): Promise<void> { await this.pool.end(); }
}

export default FinanceService;
