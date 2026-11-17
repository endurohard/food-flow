import { Pool } from 'pg';

/**
 * Возврат поставщику по принятой накладной.
 *
 * Одна транзакция: товар уходит со склада накладной — сначала из партий
 * этой накладной (это ровно тот товар), не хватило — из остальных по FIFO;
 * долг поставщику и долг по накладной уменьшаются на сумму возврата по цене
 * накладной. Вернуть можно не больше принятого (за вычетом прошлых
 * возвратов) и не больше, чем лежит на складе.
 */

export class SupplierReturnError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'SupplierReturnError'; }
}

export const RETURN_REASONS: Record<string, string> = {
  defect: 'Брак', wrong: 'Пересорт', surplus: 'Лишнее', expired: 'Просрочка', other: 'Другое'
};

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const EPS = 1e-6;

export interface ReturnInput {
  items: { invoiceItemId: string; quantity: number }[];
  reason?: string | null;
  notes?: string | null;
}

export class SupplierReturnService {
  private pool: Pool;
  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  /** Возвраты по накладной и сколько по каждой строке ещё можно вернуть. */
  async forInvoice(invoiceId: string, enterpriseId: string): Promise<any | null> {
    const inv = await this.pool.query('SELECT id FROM supply_invoices WHERE id = $1 AND enterprise_id = $2', [invoiceId, enterpriseId]);
    if (!inv.rows[0]) return null;
    const returns = await this.pool.query(
      `SELECT r.*, u.first_name, u.last_name,
              COALESCE(json_agg(json_build_object('name', ri.name, 'quantity', ri.quantity, 'total', ri.total, 'invoiceItemId', ri.invoice_item_id))
                FILTER (WHERE ri.id IS NOT NULL), '[]') AS items
         FROM supplier_returns r
         LEFT JOIN supplier_return_items ri ON ri.return_id = r.id
         LEFT JOIN users u ON u.id = r.created_by
        WHERE r.invoice_id = $1
        GROUP BY r.id, u.first_name, u.last_name
        ORDER BY r.created_at`,
      [invoiceId]
    );
    const returned = await this.pool.query(
      `SELECT ri.invoice_item_id, SUM(ri.quantity) AS q FROM supplier_return_items ri
         JOIN supplier_returns r ON r.id = ri.return_id
        WHERE r.invoice_id = $1 GROUP BY ri.invoice_item_id`,
      [invoiceId]
    );
    const byItem: Record<string, number> = {};
    returned.rows.forEach((x: any) => { byItem[x.invoice_item_id] = Number(x.q) || 0; });
    return { returns: returns.rows, returnedByItem: byItem };
  }

  async create(invoiceId: string, enterpriseId: string, userId: string | undefined, input: ReturnInput): Promise<any> {
    const lines = (input.items || []).filter((x) => Number(x.quantity) > 0);
    if (!lines.length) throw new SupplierReturnError('Укажите, что и сколько возвращаете');
    if (input.reason && !RETURN_REASONS[input.reason]) throw new SupplierReturnError('Неизвестная причина возврата');

    const client: any = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const invR = await client.query(
        'SELECT * FROM supply_invoices WHERE id = $1 AND enterprise_id = $2 FOR UPDATE', [invoiceId, enterpriseId]);
      const inv = invR.rows[0];
      if (!inv) throw new SupplierReturnError('Накладная не найдена', 404);
      if (inv.status !== 'received') throw new SupplierReturnError('Вернуть можно только по принятой накладной — черновик просто исправьте');
      if (!inv.warehouse_id) throw new SupplierReturnError('У накладной не указан склад');

      const itemsR = await client.query('SELECT * FROM supply_invoice_items WHERE invoice_id = $1', [invoiceId]);
      const prevR = await client.query(
        `SELECT ri.invoice_item_id, SUM(ri.quantity) AS q, SUM(ri.total) AS t FROM supplier_return_items ri
           JOIN supplier_returns r ON r.id = ri.return_id
          WHERE r.invoice_id = $1 GROUP BY ri.invoice_item_id`, [invoiceId]);
      const prev: Record<string, { q: number; t: number }> = {};
      prevR.rows.forEach((x: any) => { prev[x.invoice_item_id] = { q: Number(x.q) || 0, t: Number(x.t) || 0 }; });

      // Проверки — до любых проводок
      const plan: any[] = [];
      const seen = new Set<string>();
      for (const l of lines) {
        if (seen.has(l.invoiceItemId)) throw new SupplierReturnError('Одна и та же строка накладной указана дважды');
        seen.add(l.invoiceItemId);
        const it = itemsR.rows.find((x: any) => x.id === l.invoiceItemId);
        if (!it) throw new SupplierReturnError('Строка не из этой накладной', 404);
        if (!it.inventory_item_id) throw new SupplierReturnError(`«${it.name}» не связан с товаром склада`);
        const got = Number(it.quantity) || 0;
        const already = prev[it.id] ? prev[it.id].q : 0;
        const left = r3(got - already);
        const q = r3(Number(l.quantity));
        if (q > left + EPS) {
          throw new SupplierReturnError(`«${it.name}»: можно вернуть не больше ${String(left).replace('.', ',')} ${it.unit || ''}`.trim()
            + (already > 0 ? ` (уже возвращено ${String(r3(already)).replace('.', ',')})` : ''));
        }
        const lineTotal = Number(it.total_price ?? (got * (Number(it.price_per_unit) || 0))) || 0;
        const price = got > 0 ? lineTotal / got : 0;
        // Последний возврат по строке забирает остаток суммы ровно — без
        // копеечного хвоста от округлений
        const total = Math.abs(q - left) <= EPS ? r2(lineTotal - (prev[it.id] ? prev[it.id].t : 0)) : r2(q * price);
        plan.push({ it, q, price, total });
      }

      // Хватает ли товара на складе накладной
      for (const p of plan) {
        const st = await client.query(
          'SELECT quantity FROM inventory_stock WHERE warehouse_id = $1 AND inventory_item_id = $2 FOR UPDATE',
          [inv.warehouse_id, p.it.inventory_item_id]);
        const have = st.rows[0] ? Number(st.rows[0].quantity) : 0;
        if (have + EPS < p.q) {
          throw new SupplierReturnError(`«${p.it.name}»: на складе только ${String(r3(have)).replace('.', ',')} ${p.it.unit || ''} — часть уже израсходована`.trim());
        }
      }

      const num = await client.query('SELECT next_supplier_return_number($1) AS n', [enterpriseId]);
      const total = r2(plan.reduce((a, p) => a + p.total, 0));
      const retR = await client.query(
        `INSERT INTO supplier_returns (enterprise_id, supplier_id, invoice_id, warehouse_id, return_number, total_amount, reason, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [enterpriseId, inv.supplier_id || null, invoiceId, inv.warehouse_id, num.rows[0].n, total,
         input.reason || null, (input.notes || '').trim() || null, userId || null]);
      const ret = retR.rows[0];
      const reasonText = input.reason ? RETURN_REASONS[input.reason] : '';

      for (const p of plan) {
        const stockCost = await this.takeFromBatches(client, inv.warehouse_id, p.it.inventory_item_id, invoiceId, p.q);
        await client.query(
          `UPDATE inventory_stock SET quantity = quantity - $1, updated_at = NOW() WHERE warehouse_id = $2 AND inventory_item_id = $3`,
          [p.q, inv.warehouse_id, p.it.inventory_item_id]);
        await client.query(
          `INSERT INTO stock_movements (enterprise_id, warehouse_id, inventory_item_id, movement_type, quantity, cost_price,
             reference_type, reference_id, performed_by, notes)
           VALUES ($1, $2, $3, 'supplier_return', $4, $5, 'supplier_return', $6, $7, $8)`,
          [enterpriseId, inv.warehouse_id, p.it.inventory_item_id, p.q, p.q > 0 ? stockCost / p.q : null, ret.id, userId || null,
           `Возврат поставщику ${ret.return_number} по ${inv.invoice_number || 'накладной'}${reasonText ? ' — ' + reasonText.toLowerCase() : ''}`]);
        await client.query(
          `INSERT INTO supplier_return_items (return_id, invoice_item_id, inventory_item_id, name, quantity, price, total, stock_cost)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [ret.id, p.it.id, p.it.inventory_item_id, p.it.name, p.q, p.price, p.total, r2(stockCost)]);
      }

      // Долг по накладной и поставщику — меньше на сумму возврата
      await client.query(
        `UPDATE supply_invoices SET returned_amount = COALESCE(returned_amount, 0) + $2,
                payment_status = CASE
                  WHEN COALESCE(paid_amount, 0) <= 0 THEN 'unpaid'
                  WHEN COALESCE(paid_amount, 0) >= COALESCE(total_amount, 0) - COALESCE(returned_amount, 0) - $2 - 0.005 THEN 'paid'
                  ELSE 'partial' END,
                updated_at = NOW()
          WHERE id = $1`, [invoiceId, total]);
      if (inv.supplier_id) {
        await client.query('UPDATE suppliers SET balance = balance - $1 WHERE id = $2', [total, inv.supplier_id]);
      }

      await client.query('COMMIT');
      return { ...ret, reasonText };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** Снимает количество с партий: сначала партии этой накладной, потом FIFO. Возвращает себестоимость. */
  private async takeFromBatches(client: any, warehouseId: string, itemId: string, invoiceId: string, qty: number): Promise<number> {
    const b = await client.query(
      `SELECT id, quantity, cost_price FROM inventory_batches
        WHERE warehouse_id = $1 AND inventory_item_id = $2 AND is_depleted = false AND quantity > 0
        ORDER BY (invoice_id IS NOT DISTINCT FROM $3::uuid) DESC, received_at ASC
        FOR UPDATE`,
      [warehouseId, itemId, invoiceId]);
    let left = qty, cost = 0;
    for (const row of b.rows) {
      if (left <= EPS) break;
      const avail = Number(row.quantity);
      const take = Math.min(avail, left);
      if (take >= avail - EPS) await client.query('UPDATE inventory_batches SET quantity = 0, is_depleted = true WHERE id = $1', [row.id]);
      else await client.query('UPDATE inventory_batches SET quantity = quantity - $1 WHERE id = $2', [take, row.id]);
      cost += take * (Number(row.cost_price) || 0);
      left -= take;
    }
    if (left > EPS) {
      const lc = await client.query('SELECT cost_price FROM inventory_items WHERE id = $1', [itemId]);
      cost += left * (Number(lc.rows[0]?.cost_price) || 0);
    }
    return cost;
  }

  /** Закупки за период: принятые накладные минус возвраты. */
  async purchasesReport(enterpriseId: string, from: string, to: string): Promise<any> {
    const inv = await this.pool.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(total_amount), 0) AS s FROM supply_invoices
        WHERE enterprise_id = $1 AND status = 'received'
          AND COALESCE(received_at, created_at) >= $2 AND COALESCE(received_at, created_at) < $3`,
      [enterpriseId, from, to]);
    const ret = await this.pool.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(total_amount), 0) AS s FROM supplier_returns
        WHERE enterprise_id = $1 AND created_at >= $2 AND created_at < $3`,
      [enterpriseId, from, to]);
    const invoiced = Number(inv.rows[0].s) || 0, returned = Number(ret.rows[0].s) || 0;
    return { invoices: inv.rows[0].n, invoiced: r2(invoiced), returns: ret.rows[0].n, returned: r2(returned), net: r2(invoiced - returned) };
  }

  async close(): Promise<void> { await this.pool.end(); }
}
