import pkg from 'pg';
const { Pool } = pkg;

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

  async confirmInvoice(invoiceId: string, receivedBy: string, inventoryService: any): Promise<any> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Get invoice and items
      const invoice = await client.query('SELECT * FROM supply_invoices WHERE id = $1', [invoiceId]);
      if (!invoice.rows[0]) throw new Error('Invoice not found');

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

      await client.query('COMMIT');

      return { ...invoice.rows[0], status: 'received' };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default SupplierService;
