import pkg from 'pg';
const { Pool } = pkg;
import { logger } from '../utils/logger';

/**
 * Helper: escape XML special characters in string values.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Format a number to 2 decimal places for 1C-compatible amounts.
 */
function formatAmount(value: number | string): string {
  return parseFloat(String(value)).toFixed(2);
}

/**
 * Format a Date or ISO string to YYYY-MM-DD.
 */
function formatDate(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return d.toISOString().slice(0, 10);
}

export class ExportService {
  private pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  /**
   * Export completed sales/payments for a date range in 1C-compatible XML.
   */
  async exportSales(params: {
    enterpriseId: string;
    dateFrom: string;
    dateTo: string;
    exportedBy?: string;
  }): Promise<{ xml: string; recordsCount: number }> {
    const { enterpriseId, dateFrom, dateTo, exportedBy } = params;

    const result = await this.pool.query(
      `SELECT p.id, p.amount, p.payment_method, p.external_id, p.created_at,
              o.order_number, o.restaurant_id,
              r.name AS restaurant_name
       FROM payments p
       JOIN orders o ON p.order_id = o.id
       JOIN restaurants r ON o.restaurant_id = r.id
       WHERE p.enterprise_id = $1
         AND p.status = 'completed'
         AND p.created_at >= $2
         AND p.created_at <= $3
       ORDER BY p.created_at ASC`,
      [enterpriseId, dateFrom, dateTo]
    );

    const rows = result.rows;

    const documents = rows.map((row) => {
      const orderNumber = escapeXml(row.order_number || row.id);
      const date = formatDate(row.created_at);
      const amount = formatAmount(row.amount);
      const method = escapeXml(row.payment_method || '');
      const restaurant = escapeXml(row.restaurant_name || '');
      const externalId = escapeXml(row.external_id || '');

      return `  <Документ>
    <НомерДокумента>${orderNumber}</НомерДокумента>
    <ДатаДокумента>${date}</ДатаДокумента>
    <Сумма>${amount}</Сумма>
    <СпособОплаты>${method}</СпособОплаты>
    <Ресторан>${restaurant}</Ресторан>
    <ВнешнийИД>${externalId}</ВнешнийИД>
  </Документ>`;
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<СписокДокументов xmlns="http://v8.1c.ru/8.2/data/core">
${documents.join('\n')}
</СписокДокументов>`;

    // Log export
    await this.logExport({
      enterpriseId,
      exportType: 'sales',
      periodStart: dateFrom,
      periodEnd: dateTo,
      recordsCount: rows.length,
      exportedBy,
    });

    logger.info('1C sales export generated', {
      enterpriseId,
      dateFrom,
      dateTo,
      recordsCount: rows.length,
    });

    return { xml, recordsCount: rows.length };
  }

  /**
   * Export expenses for a date range in 1C-compatible XML.
   */
  async exportExpenses(params: {
    enterpriseId: string;
    dateFrom: string;
    dateTo: string;
    exportedBy?: string;
  }): Promise<{ xml: string; recordsCount: number }> {
    const { enterpriseId, dateFrom, dateTo, exportedBy } = params;

    const result = await this.pool.query(
      `SELECT e.id, e.amount, e.description, e.expense_date,
              e.restaurant_id, e.receipt_url,
              ec.name AS category_name
       FROM expenses e
       LEFT JOIN expense_categories ec ON e.category_id = ec.id
       WHERE e.enterprise_id = $1
         AND e.expense_date >= $2
         AND e.expense_date <= $3
       ORDER BY e.expense_date ASC`,
      [enterpriseId, dateFrom, dateTo]
    );

    const rows = result.rows;

    const documents = rows.map((row) => {
      const id = escapeXml(row.id);
      const date = formatDate(row.expense_date);
      const amount = formatAmount(row.amount);
      const category = escapeXml(row.category_name || '');
      const description = escapeXml(row.description || '');

      return `  <Расход>
    <НомерДокумента>${id}</НомерДокумента>
    <ДатаДокумента>${date}</ДатаДокумента>
    <Сумма>${amount}</Сумма>
    <Категория>${category}</Категория>
    <Описание>${description}</Описание>
  </Расход>`;
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<СписокРасходов xmlns="http://v8.1c.ru/8.2/data/core">
${documents.join('\n')}
</СписокРасходов>`;

    // Log export
    await this.logExport({
      enterpriseId,
      exportType: 'expenses',
      periodStart: dateFrom,
      periodEnd: dateTo,
      recordsCount: rows.length,
      exportedBy,
    });

    logger.info('1C expenses export generated', {
      enterpriseId,
      dateFrom,
      dateTo,
      recordsCount: rows.length,
    });

    return { xml, recordsCount: rows.length };
  }

  /**
   * List previous exports for an enterprise.
   */
  async listExports(enterpriseId: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT el.*, u.first_name, u.last_name
       FROM export_log el
       LEFT JOIN users u ON el.exported_by = u.id
       WHERE el.enterprise_id = $1
       ORDER BY el.created_at DESC
       LIMIT 100`,
      [enterpriseId]
    );
    return result.rows;
  }

  /**
   * Insert a record into export_log.
   */
  private async logExport(params: {
    enterpriseId: string;
    exportType: string;
    periodStart: string;
    periodEnd: string;
    recordsCount: number;
    exportedBy?: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO export_log
         (enterprise_id, export_type, period_start, period_end, status, records_count, exported_by)
       VALUES ($1, $2, $3, $4, 'completed', $5, $6)`,
      [
        params.enterpriseId,
        params.exportType,
        params.periodStart,
        params.periodEnd,
        params.recordsCount,
        params.exportedBy || null,
      ]
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default ExportService;
