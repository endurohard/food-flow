import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Работа с поставщиком: сводка по каждому (последняя поставка, открытые
 * заказы, черновики), сверка — накладные и оплаты с нарастающим долгом,
 * удаление черновика накладной.
 */

export class SupplierDeskError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'SupplierDeskError'; }
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export class SupplierDeskService {
  private pool: Pool;
  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async overview(enterpriseId: string): Promise<any[]> {
    const r = await this.pool.query(
      `SELECT s.*,
              (SELECT COUNT(*)::int FROM supply_invoices i WHERE i.supplier_id = s.id AND i.status = 'received') AS invoices_count,
              (SELECT MAX(COALESCE(i.received_at, i.created_at)) FROM supply_invoices i WHERE i.supplier_id = s.id AND i.status = 'received') AS last_delivery_at,
              (SELECT COALESCE(SUM(i.total_amount), 0) FROM supply_invoices i
                WHERE i.supplier_id = s.id AND i.status = 'received' AND COALESCE(i.received_at, i.created_at) >= NOW() - INTERVAL '30 days') AS purchased_30d,
              (SELECT COUNT(*)::int FROM supply_invoices i WHERE i.supplier_id = s.id AND i.status <> 'received') AS drafts_count,
              (SELECT COUNT(*)::int FROM purchase_orders o WHERE o.supplier_id = s.id AND o.status IN ('sent', 'partially_received')) AS open_orders
         FROM suppliers s
        WHERE s.enterprise_id = $1 AND s.is_active = true
        ORDER BY s.name`,
      [enterpriseId]
    );
    return r.rows;
  }

  /**
   * Сверка: принятые накладные (+ долг) и оплаты (− долг) по времени, с
   * долгом после каждой операции. Новые сверху.
   */
  async ledger(supplierId: string, enterpriseId: string): Promise<{ supplier: any; rows: any[]; totals: any } | null> {
    const s = await this.pool.query('SELECT id, name, balance FROM suppliers WHERE id = $1 AND enterprise_id = $2', [supplierId, enterpriseId]);
    if (!s.rows[0]) return null;
    const r = await this.pool.query(
      `SELECT * FROM (
         SELECT 'invoice' AS kind, i.id, COALESCE(i.received_at, i.created_at) AS at, i.invoice_number AS doc,
                i.total_amount AS amount, NULL::text AS method, i.notes, NULL::text AS who, i.id AS invoice_id
           FROM supply_invoices i
          WHERE i.supplier_id = $1 AND i.enterprise_id = $2 AND i.status = 'received'
         UNION ALL
         SELECT 'payment', p.id, p.created_at, i.invoice_number, p.amount, p.method, p.notes,
                NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''), p.invoice_id
           FROM supplier_payments p
           LEFT JOIN supply_invoices i ON i.id = p.invoice_id
           LEFT JOIN users u ON u.id = p.paid_by
          WHERE p.supplier_id = $1 AND (p.enterprise_id = $2 OR p.enterprise_id IS NULL)
       ) x ORDER BY at ASC, kind DESC`,
      [supplierId, enterpriseId]
    );
    let balance = 0, invoiced = 0, paid = 0;
    const rows = r.rows.map((x: any) => {
      const amount = Number(x.amount) || 0;
      if (x.kind === 'invoice') { balance += amount; invoiced += amount; } else { balance -= amount; paid += amount; }
      return { ...x, amount: r2(amount), balance_after: r2(balance) };
    });
    return {
      supplier: s.rows[0],
      rows: rows.reverse().slice(0, 500),
      totals: { invoiced: r2(invoiced), paid: r2(paid), balance: r2(balance), storedBalance: r2(Number(s.rows[0].balance) || 0) }
    };
  }

  /** Черновик накладной — удалить (ошибочное фото, дубль). Принятую — нельзя. */
  async deleteDraftInvoice(invoiceId: string, enterpriseId: string, uploadDir?: string): Promise<any> {
    const client = await this.pool.connect();
    let photo: string | null = null;
    let removed: any;
    try {
      await client.query('BEGIN');
      const r = await client.query(
        'SELECT id, status, invoice_number, photo_url FROM supply_invoices WHERE id = $1 AND enterprise_id = $2 FOR UPDATE',
        [invoiceId, enterpriseId]
      );
      const inv = r.rows[0];
      if (!inv) throw new SupplierDeskError('Накладная не найдена', 404);
      if (inv.status === 'received') throw new SupplierDeskError('Накладная уже принята на склад — удалить нельзя', 409);
      await client.query('DELETE FROM supply_invoices WHERE id = $1', [invoiceId]);   // позиции — каскадом
      await client.query('COMMIT');
      photo = inv.photo_url;
      removed = { id: inv.id, invoice_number: inv.invoice_number };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    // Файл фото — после фиксации и только внутри папки загрузок
    if (photo && uploadDir && !/^https?:/i.test(photo)) {
      const base = path.resolve(uploadDir);
      const abs = path.resolve(base, photo);
      if (abs.startsWith(base + path.sep)) fs.promises.unlink(abs).catch(() => undefined);
    }
    return removed;
  }

  async close(): Promise<void> { await this.pool.end(); }
}
