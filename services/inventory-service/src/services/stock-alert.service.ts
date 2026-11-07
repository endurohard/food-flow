import { logger } from '../utils/logger';

export interface Queryable {
  query(sql: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export type Notifier = (enterpriseId: string, text: string, linkPath: string) =>
  Promise<{ sent: number; failed: number; skipped?: string; errors?: string[] }>;

const MAX_ATTEMPTS = 5;

const fmt = (n: any) => {
  const v = Number(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, '');
};

/**
 * «Пора заказать»: остаток позиции на складе опустился до минимального
 * (inventory_items.min_stock > 0). Одно открытое предупреждение на позицию
 * склада — повторно о том же не пишем, пока остаток не пополнят выше минимума.
 *
 * sweep() вызывается сразу после списаний и раз в несколько минут по всем
 * складам: так ловятся и пути, которые сюда не заходят (приход по накладной,
 * производство, правка минимума в карточке).
 */
export class StockAlertService {
  constructor(private pool: Queryable, private notifier?: Notifier) {}

  async sweep(filter: { warehouseId?: string; itemIds?: string[] } = {}) {
    const cond: string[] = [];
    const params: any[] = [];
    if (filter.warehouseId) { params.push(filter.warehouseId); cond.push(`s.warehouse_id = $${params.length}`); }
    if (filter.itemIds) {
      if (!filter.itemIds.length) return { opened: 0, resolved: 0, notified: 0 };
      params.push(filter.itemIds); cond.push(`s.inventory_item_id = ANY($${params.length})`);
    }
    const where = cond.length ? ' AND ' + cond.join(' AND ') : '';

    // Пополнили выше минимума (или минимум убрали) — предупреждение закрыто
    const resolved = await this.pool.query(
      `UPDATE stock_alerts a SET resolved_at = NOW()
         FROM inventory_stock s JOIN inventory_items i ON i.id = s.inventory_item_id
        WHERE a.resolved_at IS NULL
          AND s.warehouse_id = a.warehouse_id AND s.inventory_item_id = a.inventory_item_id
          AND s.quantity >= 0
          AND (COALESCE(i.min_stock, 0) <= 0 OR s.quantity > i.min_stock OR i.is_active = false)${where}
        RETURNING a.id`,
      params
    );

    // «Заканчивается» перешло в минус — это новое, более серьёзное событие:
    // переотправляем один раз (дальше a.quantity уже отрицательный)
    await this.pool.query(
      `UPDATE stock_alerts a SET quantity = s.quantity, telegram_sent_at = NULL, telegram_attempts = 0, telegram_error = NULL
         FROM inventory_stock s
        WHERE a.resolved_at IS NULL AND a.quantity >= 0 AND s.quantity < 0
          AND s.warehouse_id = a.warehouse_id AND s.inventory_item_id = a.inventory_item_id${where}`,
      params
    );

    const opened = await this.pool.query(
      `INSERT INTO stock_alerts (enterprise_id, warehouse_id, inventory_item_id, quantity, min_stock)
       SELECT w.enterprise_id, s.warehouse_id, s.inventory_item_id, s.quantity, i.min_stock
         FROM inventory_stock s
         JOIN inventory_items i ON i.id = s.inventory_item_id
         JOIN warehouses w ON w.id = s.warehouse_id
        -- Минус — продали больше, чем есть по учёту: предупреждаем и без минимума
        WHERE ((i.min_stock > 0 AND s.quantity <= i.min_stock) OR s.quantity < 0)
          AND COALESCE(i.is_active, true) AND COALESCE(w.is_active, true)
          AND w.enterprise_id IS NOT NULL${where}
       ON CONFLICT (warehouse_id, inventory_item_id) WHERE resolved_at IS NULL DO NOTHING
       RETURNING id`,
      params
    );

    const notified = await this.sendPending();
    return { opened: opened.rows.length, resolved: resolved.rows.length, notified };
  }

  /**
   * Отправка неотправленных открытых предупреждений одним сообщением на
   * организацию. Сбой связи — повтор на следующем проходе (до 5 попыток);
   * нет бота или получателей — фиксируем причину и больше не пытаемся.
   */
  async sendPending(): Promise<number> {
    if (!this.notifier) return 0;
    const pending = await this.pool.query(
      `SELECT a.id, a.enterprise_id, a.quantity, a.min_stock, i.name, i.unit, w.name AS warehouse
         FROM stock_alerts a
         JOIN inventory_items i ON i.id = a.inventory_item_id
         JOIN warehouses w ON w.id = a.warehouse_id
        WHERE a.resolved_at IS NULL AND a.telegram_sent_at IS NULL AND a.telegram_attempts < $1
        ORDER BY a.enterprise_id, i.name`,
      [MAX_ATTEMPTS]
    );
    const byEnt = new Map<string, any[]>();
    for (const r of pending.rows) {
      if (!byEnt.has(r.enterprise_id)) byEnt.set(r.enterprise_id, []);
      byEnt.get(r.enterprise_id)!.push(r);
    }
    let sentGroups = 0;
    for (const [entId, rows] of byEnt) {
      const low = rows.filter((r) => Number(r.quantity) >= 0);
      const minus = rows.filter((r) => Number(r.quantity) < 0);
      const parts: string[] = [];
      if (minus.length) {
        parts.push('❗ Продано больше, чем есть на складе — проверьте приход или проведите инвентаризацию:\n\n'
          + minus.map((r) => `• ${r.name} — на складе ${fmt(r.quantity)} ${r.unit || ''}, ${r.warehouse}`.replace(/ +,/, ',')).join('\n'));
      }
      if (low.length) {
        parts.push('⚠️ Пора заказать — на складе заканчивается:\n\n'
          + low.map((r) => `• ${r.name} — осталось ${fmt(r.quantity)} ${r.unit || ''} (минимум ${fmt(r.min_stock)}), ${r.warehouse}`.replace(/ +\(/, ' (')).join('\n'));
      }
      const text = parts.join('\n\n');
      const ids = rows.map((r) => r.id);
      try {
        const res = await this.notifier(entId, text, '/admin-panel/inventory.html');
        if (res.sent > 0) {
          await this.pool.query(
            `UPDATE stock_alerts SET telegram_sent_at = NOW(), telegram_attempts = telegram_attempts + 1,
                    telegram_error = $2 WHERE id = ANY($1)`,
            [ids, res.failed ? (res.errors || []).join('; ').slice(0, 500) : null]
          );
          sentGroups++;
        } else if (res.skipped) {
          // Бот не подключён или никто не привязан: ждать бессмысленно —
          // предупреждение остаётся в колокольчике админки
          await this.pool.query(
            `UPDATE stock_alerts SET telegram_attempts = $2, telegram_error = $3 WHERE id = ANY($1)`,
            [ids, MAX_ATTEMPTS, res.skipped === 'no_bot' ? 'Telegram-бот не подключён' : 'Никто не привязал Telegram']
          );
        } else {
          throw new Error((res.errors || []).join('; ') || 'не отправлено');
        }
      } catch (e: any) {
        await this.pool.query(
          `UPDATE stock_alerts SET telegram_attempts = telegram_attempts + 1, telegram_error = $2 WHERE id = ANY($1)`,
          [ids, String(e.message || e).slice(0, 500)]
        );
        logger.warn(`stock alerts: Telegram для ${entId} не отправлен: ${e.message || e}`);
      }
    }
    return sentGroups;
  }

  async listOpen(enterpriseId: string) {
    const r = await this.pool.query(
      `SELECT a.id, a.quantity AS alert_quantity, a.min_stock, a.created_at, a.telegram_sent_at, a.telegram_error,
              s.quantity, i.id AS inventory_item_id, i.name, i.unit, w.id AS warehouse_id, w.name AS warehouse
         FROM stock_alerts a
         JOIN inventory_items i ON i.id = a.inventory_item_id
         JOIN warehouses w ON w.id = a.warehouse_id
         LEFT JOIN inventory_stock s ON s.warehouse_id = a.warehouse_id AND s.inventory_item_id = a.inventory_item_id
        WHERE a.enterprise_id = $1 AND a.resolved_at IS NULL
        ORDER BY a.created_at DESC`,
      [enterpriseId]
    );
    return r.rows;
  }
}

/** Отправка через user-service: токен бота живёт только там. */
export function httpNotifier(userServiceUrl: string, internalToken: string): Notifier | undefined {
  if (!userServiceUrl || !internalToken) return undefined;
  return async (enterpriseId, text, linkPath) => {
    const res = await fetch(`${userServiceUrl}/internal/telegram-notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-token': internalToken },
      body: JSON.stringify({ enterpriseId, text, linkPath }),
      signal: AbortSignal.timeout(30_000)
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `user-service ${res.status}`);
    return body;
  };
}
