import pkg from 'pg';
const { Pool } = pkg;
import { config } from '../config';
import { logger } from '../utils/logger';

export class SupplierService {
  private pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async list(enterpriseId?: string): Promise<any[]> {
    const result = enterpriseId
      ? await this.pool.query('SELECT * FROM suppliers WHERE enterprise_id = $1 AND is_active = true ORDER BY name', [enterpriseId])
      : await this.pool.query('SELECT * FROM suppliers WHERE is_active = true ORDER BY name');
    return result.rows;
  }

  async create(data: any, enterpriseId?: string): Promise<any> {
    const result = await this.pool.query(
      `INSERT INTO suppliers (enterprise_id, name, contact_person, phone, email, tax_id, address, payment_terms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [enterpriseId || null, data.name, data.contactPerson || null, data.phone || null,
       data.email || null, data.taxId || null, data.address || null, data.paymentTerms || null]
    );
    return result.rows[0];
  }

  async update(supplierId: string, data: any, enterpriseId?: string): Promise<any> {
    const map: Record<string, string> = {
      name: 'name', contactPerson: 'contact_person', phone: 'phone',
      email: 'email', taxId: 'tax_id', address: 'address', paymentTerms: 'payment_terms', isActive: 'is_active'
    };
    const fields: string[] = [];
    const values: any[] = [];
    let p = 1;
    for (const [k, col] of Object.entries(map)) {
      if (data[k] !== undefined) { fields.push(`${col} = $${p++}`); values.push(data[k]); }
    }
    if (!fields.length) return null;
    const whereConds = [`id = $${p++}`];
    values.push(supplierId);
    if (enterpriseId) {
      whereConds.push(`enterprise_id = $${p++}`);
      values.push(enterpriseId);
    }
    const result = await this.pool.query(
      `UPDATE suppliers SET ${fields.join(', ')} WHERE ${whereConds.join(' AND ')} RETURNING *`, values
    );
    return result.rows[0] || null;
  }

  async delete(supplierId: string, enterpriseId?: string): Promise<boolean> {
    const conds = ['id = $1'];
    const vals: any[] = [supplierId];
    if (enterpriseId) {
      conds.push('enterprise_id = $2');
      vals.push(enterpriseId);
    }
    const r = await this.pool.query(
      `UPDATE suppliers SET is_active = false WHERE ${conds.join(' AND ')}`, vals
    );
    return (r.rowCount ?? 0) > 0;
  }

  // ========== OWNERSHIP HELPERS (multi-tenant) ==========

  async supplierBelongsTo(supplierId: string, enterpriseId: string): Promise<boolean> {
    const r = await this.pool.query(
      'SELECT 1 FROM suppliers WHERE id = $1 AND enterprise_id = $2', [supplierId, enterpriseId]
    );
    return (r.rowCount ?? 0) > 0;
  }

  async invoiceBelongsTo(invoiceId: string, enterpriseId: string): Promise<boolean> {
    const r = await this.pool.query(
      'SELECT 1 FROM supply_invoices WHERE id = $1 AND enterprise_id = $2', [invoiceId, enterpriseId]
    );
    return (r.rowCount ?? 0) > 0;
  }

  // ========== INVOICES ==========

  async listInvoices(filters: { enterpriseId?: string; supplierId?: string; status?: string }): Promise<any[]> {
    const conditions: string[] = [];
    const values: any[] = [];
    let p = 1;
    if (filters.enterpriseId) { conditions.push(`si.enterprise_id = $${p++}`); values.push(filters.enterpriseId); }
    if (filters.supplierId) { conditions.push(`si.supplier_id = $${p++}`); values.push(filters.supplierId); }
    if (filters.status) { conditions.push(`si.status = $${p++}`); values.push(filters.status); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await this.pool.query(
      `SELECT si.*, s.name as supplier_name, w.name as warehouse_name
       FROM supply_invoices si
       LEFT JOIN suppliers s ON si.supplier_id = s.id
       LEFT JOIN warehouses w ON si.warehouse_id = w.id
       ${where}
       ORDER BY si.created_at DESC`,
      values
    );
    return result.rows;
  }

  async createInvoice(data: any, enterpriseId?: string): Promise<any> {
    const result = await this.pool.query(
      `INSERT INTO supply_invoices (enterprise_id, warehouse_id, supplier_id, invoice_number,
        invoice_date, total_amount, currency, notes, photo_url, ocr_text, telegram_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [enterpriseId || null, data.warehouseId || null, data.supplierId || null,
       data.invoiceNumber || null, data.invoiceDate || null, data.totalAmount || null,
       data.currency || 'RUB', data.notes || null, data.photoUrl || null,
       data.ocrText || null, data.telegramUserId || null]
    );
    return result.rows[0];
  }

  async addInvoiceItem(invoiceId: string, data: any): Promise<any> {
    const result = await this.pool.query(
      `INSERT INTO supply_invoice_items (invoice_id, inventory_item_id, name, quantity, unit, price_per_unit, total_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [invoiceId, data.inventoryItemId || null, data.name, data.quantity,
       data.unit || null, data.pricePerUnit || null, data.totalPrice || null]
    );
    return result.rows[0];
  }

  async getInvoiceItems(invoiceId: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT sii.*, i.name as inventory_item_name
       FROM supply_invoice_items sii
       LEFT JOIN inventory_items i ON sii.inventory_item_id = i.id
       WHERE sii.invoice_id = $1`,
      [invoiceId]
    );
    return result.rows;
  }

  async confirmInvoice(invoiceId: string, receivedBy: string, inventoryService: any, enterpriseId?: string): Promise<any> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Get invoice and items (scoped to enterprise unless super_admin)
      const invConds = ['id = $1'];
      const invVals: any[] = [invoiceId];
      if (enterpriseId) { invConds.push('enterprise_id = $2'); invVals.push(enterpriseId); }
      const invoice = await client.query(`SELECT * FROM supply_invoices WHERE ${invConds.join(' AND ')} FOR UPDATE`, invVals);
      if (!invoice.rows[0]) throw new Error('Invoice not found');
      if (invoice.rows[0].status === 'received') throw new Error('Invoice already confirmed');

      const items = await client.query('SELECT * FROM supply_invoice_items WHERE invoice_id = $1', [invoiceId]);

      // Create stock movements for each item
      for (const item of items.rows) {
        if (item.inventory_item_id && invoice.rows[0].warehouse_id) {
          await inventoryService.addStockMovement({
            warehouseId: invoice.rows[0].warehouse_id,
            inventoryItemId: item.inventory_item_id,
            movementType: 'receipt',
            quantity: parseFloat(item.quantity),
            costPrice: item.price_per_unit ? parseFloat(item.price_per_unit) : undefined,
            referenceType: 'invoice',
            referenceId: invoiceId,
            performedBy: receivedBy,
            enterpriseId: invoice.rows[0].enterprise_id
          });
        }
      }

      // Update invoice status
      await client.query(
        `UPDATE supply_invoices SET status = 'received', received_by = $1, received_at = NOW() WHERE id = $2`,
        [receivedBy, invoiceId]
      );

      // Долг поставщику растёт на сумму принятой накладной
      if (invoice.rows[0].supplier_id && invoice.rows[0].total_amount) {
        await client.query(
          'UPDATE suppliers SET balance = balance + $1 WHERE id = $2',
          [invoice.rows[0].total_amount, invoice.rows[0].supplier_id]
        );
      }

      await client.query('COMMIT');

      // После успешного COMMIT — создаём расход в finance-service.
      // Ошибка вызова НЕ должна отменять подтверждение накладной: логируем и продолжаем.
      await this.createFinanceExpense(invoice.rows[0], receivedBy);

      return { ...invoice.rows[0], status: 'received' };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Уведомляет finance-service о расходе по подтверждённой накладной.
   * Идемпотентно на стороне finance-service (уникальный индекс по supply_invoice_id).
   */
  private async createFinanceExpense(invoice: any, receivedBy: string): Promise<void> {
    if (!invoice.supplier_id) {
      logger.info('Skipping finance expense for invoice: no supplier', { invoiceId: invoice.id });
      return;
    }
    const amount = parseFloat(invoice.total_amount);
    if (!amount || amount <= 0) {
      logger.info('Skipping finance expense for invoice: no positive total_amount', { invoiceId: invoice.id });
      return;
    }

    try {
      const response = await fetch(`${config.financeServiceUrl}/api/finance/expenses/from-supply-invoice`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': config.internalToken
        },
        body: JSON.stringify({
          supplyInvoiceId: invoice.id,
          supplierId: invoice.supplier_id,
          amount,
          invoiceNumber: invoice.invoice_number || undefined,
          enterpriseId: invoice.enterprise_id,
          performedBy: receivedBy
        })
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        logger.warn('Finance service rejected supply invoice expense', {
          invoiceId: invoice.id, status: response.status, body: text
        });
      } else {
        logger.info('Supply invoice expense created in finance service', { invoiceId: invoice.id });
      }
    } catch (error) {
      logger.error('Failed to create supply invoice expense in finance service', {
        invoiceId: invoice.id, error: (error as Error).message
      });
    }
  }

  // ========== ВЗАИМОРАСЧЁТЫ С ПОСТАВЩИКАМИ ==========

  /**
   * Оплата поставщику: по конкретной накладной или просто погашение долга.
   * Гасит долг поставщика; при оплате накладной обновляет её статус оплаты.
   */
  async paySupplier(supplierId: string, data: {
    amount: number; method?: string; invoiceId?: string; registerId?: string; notes?: string;
  }, paidBy?: string, enterpriseId?: string): Promise<any> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const supConds = ['id = $1'];
      const supVals: any[] = [supplierId];
      if (enterpriseId) { supConds.push('enterprise_id = $2'); supVals.push(enterpriseId); }
      const sup = await client.query(`SELECT * FROM suppliers WHERE ${supConds.join(' AND ')} FOR UPDATE`, supVals);
      if (!sup.rows[0]) throw new Error('Supplier not found');

      let invoice: any = null;
      if (data.invoiceId) {
        const inv = await client.query(
          'SELECT * FROM supply_invoices WHERE id = $1 AND supplier_id = $2 FOR UPDATE',
          [data.invoiceId, supplierId]
        );
        invoice = inv.rows[0];
        if (!invoice) throw new Error('Invoice not found for this supplier');
        const newPaid = (parseFloat(invoice.paid_amount) || 0) + data.amount;
        const total = parseFloat(invoice.total_amount) || 0;
        const paymentStatus = newPaid >= total - 0.005 ? 'paid' : (newPaid > 0 ? 'partial' : 'unpaid');
        await client.query(
          'UPDATE supply_invoices SET paid_amount = $1, payment_status = $2 WHERE id = $3',
          [newPaid, paymentStatus, data.invoiceId]
        );
      }

      const payment = await client.query(
        `INSERT INTO supplier_payments (enterprise_id, supplier_id, invoice_id, amount, method, register_id, paid_by, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [sup.rows[0].enterprise_id, supplierId, data.invoiceId || null, data.amount,
         data.method || 'transfer', data.registerId || null, paidBy || null, data.notes || null]
      );

      await client.query('UPDATE suppliers SET balance = balance - $1 WHERE id = $2', [data.amount, supplierId]);

      await client.query('COMMIT');
      return { payment: payment.rows[0], invoice };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Баланс и взаиморасчёты по поставщику */
  async getSupplierBalance(supplierId: string, enterpriseId?: string): Promise<any | null> {
    const conds = ['id = $1'];
    const vals: any[] = [supplierId];
    if (enterpriseId) { conds.push('enterprise_id = $2'); vals.push(enterpriseId); }
    const sup = await this.pool.query(`SELECT * FROM suppliers WHERE ${conds.join(' AND ')}`, vals);
    if (!sup.rows[0]) return null;

    const invoices = await this.pool.query(
      `SELECT COUNT(*) AS invoices_count,
              COALESCE(SUM(total_amount), 0) AS total_invoiced,
              COALESCE(SUM(paid_amount), 0) AS total_paid
       FROM supply_invoices WHERE supplier_id = $1 AND status = 'received'`,
      [supplierId]
    );
    const payments = await this.pool.query(
      `SELECT sp.*, si.invoice_number, u.first_name, u.last_name
       FROM supplier_payments sp
       LEFT JOIN supply_invoices si ON sp.invoice_id = si.id
       LEFT JOIN users u ON sp.paid_by = u.id
       WHERE sp.supplier_id = $1 ORDER BY sp.created_at DESC LIMIT 50`,
      [supplierId]
    );
    return {
      supplierId,
      name: sup.rows[0].name,
      balance: parseFloat(sup.rows[0].balance),
      invoicesCount: parseInt(invoices.rows[0].invoices_count, 10),
      totalInvoiced: parseFloat(invoices.rows[0].total_invoiced),
      totalPaid: parseFloat(invoices.rows[0].total_paid),
      payments: payments.rows
    };
  }

  /** Отчёт по взаиморасчётам со всеми поставщиками за период */
  async getSettlementsReport(filters: { enterpriseId?: string; from?: string; to?: string }): Promise<any[]> {
    const values: any[] = [];
    let p = 1;
    const invConds = [`si.status = 'received'`];
    const payConds: string[] = ['1=1'];
    const supConds = ['s.is_active = true'];
    if (filters.enterpriseId) {
      values.push(filters.enterpriseId);
      supConds.push(`s.enterprise_id = $${p}`);
      p++;
    }
    if (filters.from) { values.push(filters.from); invConds.push(`si.received_at >= $${p}`); payConds.push(`sp.created_at >= $${p}`); p++; }
    if (filters.to) { values.push(filters.to); invConds.push(`si.received_at <= $${p}`); payConds.push(`sp.created_at <= $${p}`); p++; }

    const result = await this.pool.query(
      `SELECT s.id, s.name, s.balance,
              COALESCE(inv.invoices_count, 0) AS invoices_count,
              COALESCE(inv.invoiced, 0) AS invoiced,
              COALESCE(pay.paid, 0) AS paid
       FROM suppliers s
       LEFT JOIN (
         SELECT si.supplier_id, COUNT(*) AS invoices_count, SUM(si.total_amount) AS invoiced
         FROM supply_invoices si WHERE ${invConds.join(' AND ')} GROUP BY si.supplier_id
       ) inv ON inv.supplier_id = s.id
       LEFT JOIN (
         SELECT sp.supplier_id, SUM(sp.amount) AS paid
         FROM supplier_payments sp WHERE ${payConds.join(' AND ')} GROUP BY sp.supplier_id
       ) pay ON pay.supplier_id = s.id
       WHERE ${supConds.join(' AND ')}
       ORDER BY s.balance DESC, s.name`,
      values
    );
    return result.rows;
  }

  // ========== АНАЛИТИКА ==========

  /**
   * История закупочных цен позиции по поставкам:
   * каждая партия — дата, поставщик, накладная, цена, остаток партии.
   */
  async getItemCostHistory(itemId: string, enterpriseId?: string): Promise<any | null> {
    const conds = ['id = $1'];
    const vals: any[] = [itemId];
    if (enterpriseId) { conds.push('enterprise_id = $2'); vals.push(enterpriseId); }
    const item = await this.pool.query(`SELECT * FROM inventory_items WHERE ${conds.join(' AND ')}`, vals);
    if (!item.rows[0]) return null;

    const batches = await this.pool.query(
      `SELECT b.received_at, b.cost_price, b.quantity AS remaining, b.is_depleted, b.batch_number,
              s.name AS supplier_name, si.invoice_number,
              m.quantity AS received_quantity
       FROM inventory_batches b
       LEFT JOIN suppliers s ON b.supplier_id = s.id
       LEFT JOIN supply_invoices si ON b.invoice_id = si.id
       LEFT JOIN LATERAL (
         SELECT sm.quantity FROM stock_movements sm
         WHERE sm.inventory_item_id = b.inventory_item_id AND sm.movement_type = 'receipt'
           AND sm.created_at BETWEEN b.received_at - interval '5 seconds' AND b.received_at + interval '5 seconds'
         LIMIT 1
       ) m ON true
       WHERE b.inventory_item_id = $1
       ORDER BY b.received_at DESC
       LIMIT 100`,
      [itemId]
    );

    const rows = batches.rows;
    const active = rows.filter((b: any) => !b.is_depleted && parseFloat(b.remaining) > 0);
    const weighted = active.reduce((s: number, b: any) => s + parseFloat(b.remaining) * (parseFloat(b.cost_price) || 0), 0);
    const totalQty = active.reduce((s: number, b: any) => s + parseFloat(b.remaining), 0);

    return {
      itemId,
      name: item.rows[0].name,
      unit: item.rows[0].unit,
      currentCostPrice: parseFloat(item.rows[0].cost_price) || 0,          // последняя закупка/выпуск
      weightedAvgCost: totalQty > 0 ? Math.round(weighted / totalQty * 100) / 100 : null, // средневзвешенная по остаткам
      batches: rows
    };
  }

  /**
   * Анализ позиций за период: продажи (спрос), списания, приходы.
   * Возвращает данные для топа списаний и аутсайдеров спроса.
   */
  async getItemAnalysis(filters: { enterpriseId?: string; from?: string; to?: string }): Promise<any[]> {
    const values: any[] = [];
    let p = 1;
    const mConds: string[] = ['1=1'];
    const rConds = [`r.status = 'confirmed'`, `ri.disposition = 'write_off'`];
    const iConds = ['i.is_active = true'];
    if (filters.enterpriseId) { values.push(filters.enterpriseId); iConds.push(`i.enterprise_id = $${p}`); p++; }
    if (filters.from) { values.push(filters.from); mConds.push(`m.created_at >= $${p}`); rConds.push(`r.confirmed_at >= $${p}`); p++; }
    if (filters.to) { values.push(filters.to); mConds.push(`m.created_at <= $${p}`); rConds.push(`r.confirmed_at <= $${p}`); p++; }

    const result = await this.pool.query(
      `SELECT i.id, i.name, i.unit, i.is_produced, i.cost_price,
              COALESCE(SUM(s.quantity), 0) AS stock,
              COALESCE(mv.sold, 0) AS sold_qty,
              COALESCE(mv.written_off, 0) + COALESCE(ret.returned_write_off, 0) AS written_off_qty,
              COALESCE(mv.received, 0) AS received_qty,
              COALESCE(mv.write_off_cost, 0) + COALESCE(ret.returned_write_off_cost, 0) AS write_off_cost
       FROM inventory_items i
       LEFT JOIN inventory_stock s ON s.inventory_item_id = i.id
       LEFT JOIN (
         SELECT m.inventory_item_id,
                SUM(m.quantity) FILTER (WHERE m.movement_type = 'sale') AS sold,
                SUM(m.quantity) FILTER (WHERE m.movement_type = 'write_off' AND COALESCE(m.reference_type, '') NOT IN ('production', 'production_cancel')) AS written_off,
                SUM(m.quantity) FILTER (WHERE m.movement_type = 'receipt') AS received,
                SUM(m.quantity * COALESCE(m.cost_price, 0)) FILTER (WHERE m.movement_type = 'write_off' AND COALESCE(m.reference_type, '') NOT IN ('production', 'production_cancel')) AS write_off_cost
         FROM stock_movements m
         WHERE ${mConds.join(' AND ')}
         GROUP BY m.inventory_item_id
       ) mv ON mv.inventory_item_id = i.id
       LEFT JOIN (
         -- Списания при возвратах от контрагентов (просрочка/порча)
         SELECT ri.inventory_item_id,
                SUM(ri.quantity) AS returned_write_off,
                SUM(ri.quantity * ri.price) AS returned_write_off_cost
         FROM wholesale_return_items ri
         INNER JOIN wholesale_returns r ON ri.return_id = r.id
         WHERE ${rConds.join(' AND ')}
         GROUP BY ri.inventory_item_id
       ) ret ON ret.inventory_item_id = i.id
       WHERE ${iConds.join(' AND ')}
       GROUP BY i.id, mv.sold, mv.written_off, mv.received, mv.write_off_cost, ret.returned_write_off, ret.returned_write_off_cost
       ORDER BY (COALESCE(mv.written_off, 0) + COALESCE(ret.returned_write_off, 0)) DESC, COALESCE(mv.sold, 0) ASC`,
      values
    );
    return result.rows;
  }

  /**
   * Анализ блюд меню за период: сколько заказывали (спрос),
   * наименее популярные — в конце по sold_qty.
   */
  async getDishAnalysis(filters: { enterpriseId?: string; from?: string; to?: string }): Promise<any[]> {
    const values: any[] = [];
    let p = 1;
    const oConds = [`o.status NOT IN ('cancelled')`];
    const miConds: string[] = ['mi.is_available IS NOT false'];
    if (filters.enterpriseId) { values.push(filters.enterpriseId); miConds.push(`mi.enterprise_id = $${p}`); p++; }
    if (filters.from) { values.push(filters.from); oConds.push(`o.created_at >= $${p}`); p++; }
    if (filters.to) { values.push(filters.to); oConds.push(`o.created_at <= $${p}`); p++; }

    const result = await this.pool.query(
      `SELECT mi.id, mi.name, mi.price, mi.cost_price,
              COALESCE(sales.orders_count, 0) AS orders_count,
              COALESCE(sales.sold_qty, 0) AS sold_qty,
              COALESCE(sales.revenue, 0) AS revenue
       FROM menu_items mi
       LEFT JOIN (
         SELECT oi.menu_item_id,
                COUNT(DISTINCT oi.order_id) AS orders_count,
                SUM(oi.quantity) AS sold_qty,
                SUM(oi.subtotal) AS revenue
         FROM order_items oi
         INNER JOIN orders o ON oi.order_id = o.id
         WHERE ${oConds.join(' AND ')}
         GROUP BY oi.menu_item_id
       ) sales ON sales.menu_item_id = mi.id
       WHERE ${miConds.join(' AND ')}
       ORDER BY COALESCE(sales.sold_qty, 0) DESC`,
      values
    );
    return result.rows;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default SupplierService;
