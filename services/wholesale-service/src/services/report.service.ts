import pkg from 'pg';
const { Pool } = pkg;

/**
 * Отчёты оптового контура: по водителям, менеджерам и сводный.
 * Выручка считается по отгруженным заказам (shipped/delivered/closed),
 * маржа = сумма продажи − фактическая FIFO-себестоимость отгрузки.
 */
export class WholesaleReportService {
  private pool: InstanceType<typeof Pool>;

  constructor(pool: InstanceType<typeof Pool>) {
    this.pool = pool;
  }

  private periodConds(alias: string, filters: { from?: string; to?: string }, conditions: string[], values: any[], p: { i: number }): void {
    if (filters.from) { conditions.push(`${alias}.shipped_at >= $${p.i++}`); values.push(filters.from); }
    if (filters.to) { conditions.push(`${alias}.shipped_at <= $${p.i++}`); values.push(filters.to); }
  }

  /**
   * По водителям: отгрузки, суммы, собранные наличные, возвраты по их заказам,
   * сдано в кассу vs остаётся на руках.
   */
  async driversReport(filters: { enterpriseId?: string; from?: string; to?: string }): Promise<any[]> {
    const values: any[] = [];
    let i = 1;
    const orderConds = [`o.status IN ('shipped', 'delivered', 'closed')`, 'o.driver_id IS NOT NULL'];
    const payConds = [`cp.payment_type = 'payment'`, `cp.method = 'cash'`, 'cp.received_by IS NOT NULL'];
    if (filters.enterpriseId) {
      values.push(filters.enterpriseId);
      orderConds.push(`o.enterprise_id = $${i}`);
      payConds.push(`cp.enterprise_id = $${i}`);
      i++;
    }
    if (filters.from) {
      values.push(filters.from);
      orderConds.push(`o.shipped_at >= $${i}`);
      payConds.push(`cp.created_at >= $${i}`);
      i++;
    }
    if (filters.to) {
      values.push(filters.to);
      orderConds.push(`o.shipped_at <= $${i}`);
      payConds.push(`cp.created_at <= $${i}`);
      i++;
    }

    const result = await this.pool.query(
      `WITH driver_orders AS (
         SELECT * FROM wholesale_orders o WHERE ${orderConds.join(' AND ')}
       ),
       driver_cash AS (
         SELECT cp.received_by AS driver_id,
                COALESCE(SUM(cp.amount), 0) AS cash_collected,
                COALESCE(SUM(cp.amount) FILTER (WHERE cp.register_id IS NOT NULL), 0) AS cash_deposited
         FROM counterparty_payments cp
         WHERE ${payConds.join(' AND ')}
         GROUP BY cp.received_by
       ),
       driver_returns AS (
         -- Возвраты, принятые самим водителем (processed_by)
         SELECT r.processed_by AS driver_id,
                COALESCE(SUM(r.total_amount), 0) AS returns_accepted_amount,
                COUNT(*) AS returns_accepted_count
         FROM wholesale_returns r
         WHERE r.status = 'confirmed' AND r.processed_by IS NOT NULL
         GROUP BY r.processed_by
       ),
       order_returns AS (
         -- Возвраты по заказам, которые вёз этот водитель
         SELECT o.driver_id, COALESCE(SUM(r.total_amount), 0) AS returns_on_orders_amount
         FROM wholesale_returns r
         INNER JOIN driver_orders o ON r.order_id = o.id
         WHERE r.status = 'confirmed'
         GROUP BY o.driver_id
       )
       SELECT o.driver_id,
              u.first_name, u.last_name, u.phone,
              COUNT(*) AS orders_count,
              COUNT(*) FILTER (WHERE o.status IN ('delivered', 'closed')) AS delivered_count,
              COALESCE(SUM(o.total_amount), 0) AS total_shipped_amount,
              COALESCE(MAX(dc.cash_collected), 0) AS cash_collected,
              COALESCE(MAX(dc.cash_deposited), 0) AS cash_deposited,
              COALESCE(MAX(dr.returns_accepted_amount), 0) AS returns_accepted_amount,
              COALESCE(MAX(dr.returns_accepted_count), 0) AS returns_accepted_count,
              COALESCE(MAX(orr.returns_on_orders_amount), 0) AS returns_on_orders_amount
       FROM driver_orders o
       INNER JOIN users u ON o.driver_id = u.id
       LEFT JOIN driver_cash dc ON dc.driver_id = o.driver_id
       LEFT JOIN driver_returns dr ON dr.driver_id = o.driver_id
       LEFT JOIN order_returns orr ON orr.driver_id = o.driver_id
       GROUP BY o.driver_id, u.first_name, u.last_name, u.phone
       ORDER BY total_shipped_amount DESC`,
      values
    );
    return result.rows.map((r: any) => ({
      ...r,
      cash_on_hand: Math.round((parseFloat(r.cash_collected) - parseFloat(r.cash_deposited)) * 100) / 100
    }));
  }

  /**
   * По менеджерам: заказы, выручка, себестоимость, маржа, долги их контрагентов.
   */
  async managersReport(filters: { enterpriseId?: string; from?: string; to?: string }): Promise<any[]> {
    const conditions: string[] = [`o.status IN ('shipped', 'delivered', 'closed')`, 'o.manager_id IS NOT NULL'];
    const values: any[] = [];
    const p = { i: 1 };
    if (filters.enterpriseId) { conditions.push(`o.enterprise_id = $${p.i++}`); values.push(filters.enterpriseId); }
    this.periodConds('o', filters, conditions, values, p);
    const where = 'WHERE ' + conditions.join(' AND ');

    const result = await this.pool.query(
      `SELECT o.manager_id,
              u.first_name, u.last_name,
              COUNT(*) AS orders_count,
              COUNT(DISTINCT o.counterparty_id) AS counterparties_count,
              COALESCE(SUM(o.total_amount), 0) AS revenue,
              COALESCE(SUM(o.total_cost), 0) AS cost,
              COALESCE(SUM(o.total_amount - COALESCE(o.total_cost, 0)), 0) AS margin,
              COALESCE(SUM(o.total_amount - o.paid_amount), 0) AS unpaid_amount,
              COALESCE((
                SELECT SUM(c.balance) FROM counterparties c WHERE c.manager_id = o.manager_id AND c.balance > 0
              ), 0) AS counterparty_debt
       FROM wholesale_orders o
       INNER JOIN users u ON o.manager_id = u.id
       ${where}
       GROUP BY o.manager_id, u.first_name, u.last_name
       ORDER BY revenue DESC`,
      values
    );
    return result.rows.map((r: any) => {
      const revenue = parseFloat(r.revenue) || 0;
      const margin = parseFloat(r.margin) || 0;
      return { ...r, margin_percent: revenue > 0 ? Math.round(margin / revenue * 10000) / 100 : 0 };
    });
  }

  /**
   * Сводный отчёт по опту: динамика по дням, разрезы по контрагентам и позициям.
   */
  async summaryReport(filters: { enterpriseId?: string; from?: string; to?: string }): Promise<any> {
    const conditions: string[] = [`o.status IN ('shipped', 'delivered', 'closed')`];
    const values: any[] = [];
    const p = { i: 1 };
    if (filters.enterpriseId) { conditions.push(`o.enterprise_id = $${p.i++}`); values.push(filters.enterpriseId); }
    this.periodConds('o', filters, conditions, values, p);
    const where = 'WHERE ' + conditions.join(' AND ');

    const totals = await this.pool.query(
      `SELECT COUNT(*) AS orders_count,
              COALESCE(SUM(o.total_amount), 0) AS revenue,
              COALESCE(SUM(o.total_cost), 0) AS cost,
              COALESCE(SUM(o.total_amount - COALESCE(o.total_cost, 0)), 0) AS margin,
              COALESCE(SUM(o.paid_amount), 0) AS paid,
              COALESCE(SUM(o.total_amount - o.paid_amount), 0) AS unpaid
       FROM wholesale_orders o ${where}`,
      values
    );

    const byDay = await this.pool.query(
      `SELECT DATE(o.shipped_at) AS day,
              COUNT(*) AS orders_count,
              COALESCE(SUM(o.total_amount), 0) AS revenue,
              COALESCE(SUM(o.total_cost), 0) AS cost,
              COALESCE(SUM(o.total_amount - COALESCE(o.total_cost, 0)), 0) AS margin
       FROM wholesale_orders o ${where}
       GROUP BY DATE(o.shipped_at)
       ORDER BY day DESC`,
      values
    );

    const byCounterparty = await this.pool.query(
      `SELECT c.name, COUNT(*) AS orders_count,
              COALESCE(SUM(o.total_amount), 0) AS revenue,
              COALESCE(SUM(o.total_amount - COALESCE(o.total_cost, 0)), 0) AS margin,
              MAX(c.balance) AS current_debt
       FROM wholesale_orders o
       INNER JOIN counterparties c ON o.counterparty_id = c.id
       ${where}
       GROUP BY c.id, c.name
       ORDER BY revenue DESC`,
      values
    );

    const byItem = await this.pool.query(
      `SELECT oi.name,
              SUM(oi.shipped_quantity) AS quantity,
              COALESCE(SUM(oi.total), 0) AS revenue,
              COALESCE(SUM(oi.shipped_quantity * COALESCE(oi.cost_price, 0)), 0) AS cost,
              COALESCE(SUM(oi.total - oi.shipped_quantity * COALESCE(oi.cost_price, 0)), 0) AS margin,
              COALESCE(SUM(oi.returned_quantity), 0) AS returned_quantity
       FROM wholesale_order_items oi
       INNER JOIN wholesale_orders o ON oi.order_id = o.id
       ${where}
       GROUP BY oi.name
       ORDER BY revenue DESC`,
      values
    );

    return {
      totals: totals.rows[0],
      byDay: byDay.rows,
      byCounterparty: byCounterparty.rows,
      byItem: byItem.rows
    };
  }
}

export default WholesaleReportService;
