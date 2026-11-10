import { Pool } from 'pg';

/**
 * Позиции накладной: добавление, правка, удаление (только у черновика) и
 * фасовки поставщика.
 *
 * Фасовка: в документе «3 мешка по 50 кг по 2 400 ₽». Склад ведётся в кг —
 * сервер сам считает 150 кг и 48 ₽/кг, сумма позиции берётся из документа
 * (3 × 2 400), а не из округлённой цены за кг. Фасовка запоминается за
 * товаром и поставщиком накладной.
 *
 * Сумму позиции считает сервер: раньше её присылал браузер, и по ней рос
 * долг поставщику.
 */

export class InvoiceItemError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'InvoiceItemError'; }
}

export interface PackInput { name: string; size: number; count: number; price: number }
export interface InvoiceItemInput {
  inventoryItemId?: string | null;
  name?: string;
  unit?: string | null;
  quantity?: number;
  pricePerUnit?: number;
  pack?: PackInput | null;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const NO_SUPPLIER = '00000000-0000-0000-0000-000000000000';

/** Количество в единицах склада, цена за единицу и сумма позиции. */
export function computeLine(input: InvoiceItemInput): { quantity: number; pricePerUnit: number; total: number } {
  const p = input.pack;
  if (p) {
    if (!(p.size > 0) || !(p.count > 0) || !(p.price >= 0)) throw new InvoiceItemError('Проверьте фасовку: количество, вложение и цену');
    const quantity = r3(p.count * p.size);
    return { quantity, pricePerUnit: r2(p.price / p.size), total: r2(p.count * p.price) };
  }
  const q = Number(input.quantity), price = Number(input.pricePerUnit);
  if (!(q > 0)) throw new InvoiceItemError('Количество должно быть больше нуля');
  if (!(price >= 0)) throw new InvoiceItemError('Укажите цену за единицу');
  return { quantity: r3(q), pricePerUnit: r2(price), total: r2(q * price) };
}

export class InvoiceItemService {
  private pool: Pool;
  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  private async tx<T>(fn: (client: any) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** Черновик накладной под блокировкой; enterpriseId = undefined — супер-админ. */
  private async lockDraft(client: any, invoiceId: string, enterpriseId?: string) {
    const r = await client.query(
      `SELECT id, enterprise_id, supplier_id, status FROM supply_invoices
        WHERE id = $1 AND ($2::uuid IS NULL OR enterprise_id = $2::uuid) FOR UPDATE`,
      [invoiceId, enterpriseId || null]
    );
    const inv = r.rows[0];
    if (!inv) throw new InvoiceItemError('Накладная не найдена', 404);
    if (inv.status === 'received') throw new InvoiceItemError('Накладная уже принята — состав изменить нельзя');
    return inv;
  }

  /** Товар склада того же предприятия, что и накладная: имя и единица — из карточки. */
  private async resolveItem(client: any, inv: any, input: InvoiceItemInput) {
    if (!input.inventoryItemId) {
      if (!input.name || !input.name.trim()) throw new InvoiceItemError('Выберите товар');
      return { id: null, name: input.name.trim(), unit: input.unit || null };
    }
    const r = await client.query(
      'SELECT id, name, unit FROM inventory_items WHERE id = $1 AND enterprise_id = $2',
      [input.inventoryItemId, inv.enterprise_id]
    );
    if (!r.rows[0]) throw new InvoiceItemError('Товар не найден', 404);
    return r.rows[0];
  }

  private async rememberPack(client: any, inv: any, itemId: string | null, pack?: PackInput | null) {
    if (!pack || !itemId) return;
    await client.query(
      `INSERT INTO item_packages (enterprise_id, inventory_item_id, supplier_id, name, units_per_pack, last_pack_price, used_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (inventory_item_id, COALESCE(supplier_id, '${NO_SUPPLIER}'::uuid), lower(name))
       DO UPDATE SET units_per_pack = EXCLUDED.units_per_pack, last_pack_price = EXCLUDED.last_pack_price, used_at = NOW()`,
      [inv.enterprise_id, itemId, inv.supplier_id || null, pack.name.trim(), pack.size, pack.price]
    );
  }

  private async recalcTotal(client: any, invoiceId: string) {
    await client.query(
      `UPDATE supply_invoices
          SET total_amount = (SELECT COALESCE(SUM(total_price), 0) FROM supply_invoice_items WHERE invoice_id = $1),
              updated_at = NOW()
        WHERE id = $1`,
      [invoiceId]
    );
  }

  async add(invoiceId: string, enterpriseId: string | undefined, input: InvoiceItemInput): Promise<any> {
    const line = computeLine(input);
    return this.tx(async (client) => {
      const inv = await this.lockDraft(client, invoiceId, enterpriseId);
      const item = await this.resolveItem(client, inv, input);
      const p = input.pack || null;
      const r = await client.query(
        `INSERT INTO supply_invoice_items
           (invoice_id, inventory_item_id, name, quantity, unit, price_per_unit, total_price, pack_name, pack_size, pack_count, pack_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [invoiceId, item.id, item.name, line.quantity, item.unit, line.pricePerUnit, line.total,
         p ? p.name.trim() : null, p ? p.size : null, p ? p.count : null, p ? p.price : null]
      );
      await this.rememberPack(client, inv, item.id, p);
      await this.recalcTotal(client, invoiceId);
      return r.rows[0];
    });
  }

  async update(invoiceId: string, enterpriseId: string | undefined, rowId: string, input: InvoiceItemInput): Promise<any> {
    const line = computeLine(input);
    return this.tx(async (client) => {
      const inv = await this.lockDraft(client, invoiceId, enterpriseId);
      const cur = await client.query('SELECT * FROM supply_invoice_items WHERE id = $1 AND invoice_id = $2', [rowId, invoiceId]);
      if (!cur.rows[0]) throw new InvoiceItemError('Позиция не найдена', 404);
      // Товар можно не присылать — остаётся прежний (например, распознанный по фото)
      const item = input.inventoryItemId || input.name
        ? await this.resolveItem(client, inv, input)
        : { id: cur.rows[0].inventory_item_id, name: cur.rows[0].name, unit: cur.rows[0].unit };
      const p = input.pack || null;
      const r = await client.query(
        `UPDATE supply_invoice_items
            SET inventory_item_id = $3, name = $4, unit = $5, quantity = $6, price_per_unit = $7, total_price = $8,
                pack_name = $9, pack_size = $10, pack_count = $11, pack_price = $12
          WHERE id = $1 AND invoice_id = $2 RETURNING *`,
        [rowId, invoiceId, item.id, item.name, item.unit, line.quantity, line.pricePerUnit, line.total,
         p ? p.name.trim() : null, p ? p.size : null, p ? p.count : null, p ? p.price : null]
      );
      await this.rememberPack(client, inv, item.id, p);
      await this.recalcTotal(client, invoiceId);
      return r.rows[0];
    });
  }

  async remove(invoiceId: string, enterpriseId: string | undefined, rowId: string): Promise<void> {
    await this.tx(async (client) => {
      await this.lockDraft(client, invoiceId, enterpriseId);
      const r = await client.query('DELETE FROM supply_invoice_items WHERE id = $1 AND invoice_id = $2', [rowId, invoiceId]);
      if (!r.rowCount) throw new InvoiceItemError('Позиция не найдена', 404);
      await this.recalcTotal(client, invoiceId);
    });
  }

  /** Фасовки товара: сначала этого поставщика, потом остальные; свежие выше. */
  async packages(enterpriseId: string, itemId: string, supplierId?: string | null): Promise<any[]> {
    const r = await this.pool.query(
      `SELECT p.id, p.name, p.units_per_pack, p.last_pack_price, p.supplier_id, s.name AS supplier_name
         FROM item_packages p
         LEFT JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.enterprise_id = $1 AND p.inventory_item_id = $2
        ORDER BY (p.supplier_id IS NOT DISTINCT FROM $3::uuid) DESC, p.used_at DESC
        LIMIT 10`,
      [enterpriseId, itemId, supplierId || null]
    );
    return r.rows.map((x: any) => ({
      id: x.id, name: x.name, unitsPerPack: Number(x.units_per_pack),
      lastPackPrice: x.last_pack_price === null ? null : Number(x.last_pack_price),
      supplierId: x.supplier_id, supplierName: x.supplier_name
    }));
  }

  async close(): Promise<void> { await this.pool.end(); }
}
