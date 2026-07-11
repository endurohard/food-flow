import { Pool, PoolClient } from 'pg';
import { logger } from '../utils/logger';

export class StationService {
  private db: Pool;

  constructor(connectionString: string) {
    this.db = new Pool({ connectionString });
  }

  // ─── CRUD ────────────────────────────────────────────────────

  async listStations(restaurantId: string, enterpriseId?: string): Promise<any[]> {
    const vals: any[] = [restaurantId];
    let p = 2;
    const conds = [`restaurant_id = $1`];

    if (enterpriseId) {
      conds.push(`enterprise_id = $${p++}`);
      vals.push(enterpriseId);
    }

    const { rows } = await this.db.query(
      `SELECT
        id,
        restaurant_id   AS "restaurantId",
        enterprise_id   AS "enterpriseId",
        name,
        station_type    AS "stationType",
        display_order   AS "displayOrder",
        is_active       AS "isActive",
        created_at      AS "createdAt"
      FROM kitchen_stations
      WHERE ${conds.join(' AND ')}
      ORDER BY display_order ASC, created_at ASC`,
      vals,
    );
    return rows;
  }

  async createStation(data: {
    restaurantId: string;
    enterpriseId?: string;
    name: string;
    stationType?: string;
    displayOrder?: number;
  }): Promise<any> {
    const { restaurantId, enterpriseId, name, stationType, displayOrder } = data;
    const { rows } = await this.db.query(
      `INSERT INTO kitchen_stations (restaurant_id, enterprise_id, name, station_type, display_order)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING
         id,
         restaurant_id  AS "restaurantId",
         enterprise_id  AS "enterpriseId",
         name,
         station_type   AS "stationType",
         display_order  AS "displayOrder",
         is_active      AS "isActive",
         created_at     AS "createdAt"`,
      [restaurantId, enterpriseId || null, name, stationType || 'general', displayOrder ?? 0],
    );
    return rows[0];
  }

  async updateStation(id: string, data: any, enterpriseId?: string): Promise<any> {
    const sets: string[] = [];
    const vals: any[] = [];
    let p = 1;

    if (data.name !== undefined) {
      sets.push(`name = $${p++}`);
      vals.push(data.name);
    }
    if (data.stationType !== undefined) {
      sets.push(`station_type = $${p++}`);
      vals.push(data.stationType);
    }
    if (data.displayOrder !== undefined) {
      sets.push(`display_order = $${p++}`);
      vals.push(data.displayOrder);
    }
    if (data.isActive !== undefined) {
      sets.push(`is_active = $${p++}`);
      vals.push(data.isActive);
    }

    if (sets.length === 0) {
      throw new Error('No fields to update');
    }

    const conds = [`id = $${p++}`];
    vals.push(id);

    if (enterpriseId) {
      conds.push(`enterprise_id = $${p++}`);
      vals.push(enterpriseId);
    }

    const { rows } = await this.db.query(
      `UPDATE kitchen_stations
       SET ${sets.join(', ')}
       WHERE ${conds.join(' AND ')}
       RETURNING
         id,
         restaurant_id  AS "restaurantId",
         enterprise_id  AS "enterpriseId",
         name,
         station_type   AS "stationType",
         display_order  AS "displayOrder",
         is_active      AS "isActive",
         created_at     AS "createdAt"`,
      vals,
    );
    return rows[0] || null;
  }

  async deleteStation(id: string, enterpriseId?: string): Promise<boolean> {
    const vals: any[] = [id];
    let p = 2;
    const conds = [`id = $1`];

    if (enterpriseId) {
      conds.push(`enterprise_id = $${p++}`);
      vals.push(enterpriseId);
    }

    const { rowCount } = await this.db.query(
      `DELETE FROM kitchen_stations WHERE ${conds.join(' AND ')}`,
      vals,
    );
    return (rowCount ?? 0) > 0;
  }

  // ─── MENU-ITEM ↔ STATION ASSIGNMENTS ────────────────────────

  async assignItemToStation(
    menuItemId: string,
    stationId: string,
    preparationOrder?: number,
    enterpriseId?: string,
  ): Promise<any> {
    // Tenant guard: both the station and the menu item must belong to the caller's enterprise.
    // (menu_item_stations itself has no enterprise_id — scoped via its parents.)
    if (enterpriseId) {
      const { rows: own } = await this.db.query(
        `SELECT
           EXISTS(SELECT 1 FROM kitchen_stations WHERE id = $1 AND enterprise_id = $2) AS station_ok,
           EXISTS(SELECT 1 FROM menu_items       WHERE id = $3 AND enterprise_id = $2) AS item_ok`,
        [stationId, enterpriseId, menuItemId],
      );
      if (!own[0].station_ok || !own[0].item_ok) {
        return null;
      }
    }

    const { rows } = await this.db.query(
      `INSERT INTO menu_item_stations (menu_item_id, station_id, preparation_order)
       VALUES ($1, $2, $3)
       ON CONFLICT (menu_item_id, station_id)
       DO UPDATE SET preparation_order = EXCLUDED.preparation_order
       RETURNING
         id,
         menu_item_id     AS "menuItemId",
         station_id       AS "stationId",
         preparation_order AS "preparationOrder"`,
      [menuItemId, stationId, preparationOrder ?? 1],
    );
    return rows[0];
  }

  async removeItemFromStation(
    menuItemId: string,
    stationId: string,
    enterpriseId?: string,
  ): Promise<boolean> {
    // Tenant guard: only delete when the target station belongs to the caller's enterprise.
    if (enterpriseId) {
      const { rowCount } = await this.db.query(
        `DELETE FROM menu_item_stations mis
         USING kitchen_stations ks
         WHERE mis.station_id = ks.id
           AND mis.menu_item_id = $1
           AND mis.station_id = $2
           AND ks.enterprise_id = $3`,
        [menuItemId, stationId, enterpriseId],
      );
      return (rowCount ?? 0) > 0;
    }

    const { rowCount } = await this.db.query(
      `DELETE FROM menu_item_stations WHERE menu_item_id = $1 AND station_id = $2`,
      [menuItemId, stationId],
    );
    return (rowCount ?? 0) > 0;
  }

  async getItemStations(menuItemId: string): Promise<any[]> {
    const { rows } = await this.db.query(
      `SELECT
        mis.id,
        mis.menu_item_id     AS "menuItemId",
        mis.station_id       AS "stationId",
        mis.preparation_order AS "preparationOrder",
        ks.name              AS "stationName",
        ks.station_type      AS "stationType"
      FROM menu_item_stations mis
      JOIN kitchen_stations ks ON ks.id = mis.station_id
      WHERE mis.menu_item_id = $1
      ORDER BY mis.preparation_order ASC`,
      [menuItemId],
    );
    return rows;
  }

  // ─── STATION-SPECIFIC KDS VIEW ──────────────────────────────

  async getStationOrders(stationId: string, enterpriseId?: string): Promise<any[]> {
    const vals: any[] = [stationId];
    let p = 2;
    const extraConds: string[] = [];

    if (enterpriseId) {
      extraConds.push(`o.enterprise_id = $${p++}`);
      vals.push(enterpriseId);
    }

    const whereExtra = extraConds.length > 0 ? `AND ${extraConds.join(' AND ')}` : '';

    const { rows } = await this.db.query(
      `SELECT
        o.id              AS "orderId",
        o.order_number    AS "orderNumber",
        o.status          AS "orderStatus",
        o.created_at      AS "orderCreatedAt",
        o.special_instructions AS "orderInstructions",
        oi.id             AS "orderItemId",
        mi.name           AS "itemName",
        oi.quantity,
        oi.special_instructions AS "itemInstructions",
        COALESCE(oiss.status, 'pending') AS "stationStatus",
        oiss.started_at   AS "startedAt",
        oiss.completed_at AS "completedAt",
        oiss.cook_id      AS "cookId"
      FROM menu_item_stations mis
      JOIN order_items oi      ON oi.menu_item_id = mis.menu_item_id
      JOIN orders o            ON o.id = oi.order_id
      JOIN menu_items mi       ON mi.id = oi.menu_item_id
      LEFT JOIN order_item_station_status oiss
        ON oiss.order_item_id = oi.id AND oiss.station_id = mis.station_id
      WHERE mis.station_id = $1
        AND o.status IN ('confirmed', 'preparing')
        AND COALESCE(oiss.status, 'pending') IN ('pending', 'in_progress')
        ${whereExtra}
      ORDER BY o.created_at ASC, oi.id ASC`,
      vals,
    );
    return rows;
  }

  // ─── UPDATE ITEM STATUS AT A STATION ─────────────────────────

  async updateItemStationStatus(
    orderItemId: string,
    stationId: string,
    status: string,
    cookId?: string,
    enterpriseId?: string,
  ): Promise<any> {
    const client: PoolClient = await this.db.connect();
    try {
      await client.query('BEGIN');

      // Tenant guard: the order item's parent order and the station must both
      // belong to the caller's enterprise. Prevents cross-tenant status writes
      // and cross-tenant order auto-completion via checkAutoComplete.
      if (enterpriseId) {
        const { rows: own } = await client.query(
          `SELECT
             EXISTS(SELECT 1 FROM order_items oi
                    JOIN orders o ON o.id = oi.order_id
                    WHERE oi.id = $1 AND o.enterprise_id = $2) AS item_ok,
             EXISTS(SELECT 1 FROM kitchen_stations WHERE id = $3 AND enterprise_id = $2) AS station_ok`,
          [orderItemId, enterpriseId, stationId],
        );
        if (!own[0].item_ok || !own[0].station_ok) {
          await client.query('ROLLBACK');
          return null;
        }
      }

      // 1. Upsert the station status row
      const startedExpr = status === 'in_progress' ? 'NOW()' : 'oiss.started_at';
      const completedExpr = status === 'done' ? 'NOW()' : 'NULL';

      const { rows } = await client.query(
        `INSERT INTO order_item_station_status (order_item_id, station_id, status, started_at, completed_at, cook_id)
         VALUES ($1, $2, $3,
                 ${status === 'in_progress' ? 'NOW()' : 'NULL'},
                 ${status === 'done' ? 'NOW()' : 'NULL'},
                 $4)
         ON CONFLICT (order_item_id, station_id)
         DO UPDATE SET
           status       = EXCLUDED.status,
           started_at   = CASE WHEN EXCLUDED.status = 'in_progress' THEN NOW()
                               ELSE order_item_station_status.started_at END,
           completed_at = CASE WHEN EXCLUDED.status = 'done' THEN NOW()
                               ELSE NULL END,
           cook_id      = COALESCE(EXCLUDED.cook_id, order_item_station_status.cook_id)
         RETURNING
           id,
           order_item_id AS "orderItemId",
           station_id    AS "stationId",
           status,
           started_at    AS "startedAt",
           completed_at  AS "completedAt",
           cook_id       AS "cookId"`,
        [orderItemId, stationId, status, cookId || null],
      );

      const updated = rows[0];

      // 2. If status is 'done', check auto-complete logic
      if (status === 'done') {
        await this.checkAutoComplete(client, orderItemId, enterpriseId);
      }

      await client.query('COMMIT');
      return updated;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ─── AUTO-COMPLETE HELPERS ───────────────────────────────────

  /**
   * After a station marks an item done, check:
   * 1) Are ALL stations for this order_item done?
   * 2) If yes, are ALL items in the parent order done?
   * 3) If yes, set order status = 'ready'.
   */
  private async checkAutoComplete(
    client: PoolClient,
    orderItemId: string,
    enterpriseId?: string,
  ): Promise<void> {
    // Count pending/in_progress stations for this order item
    const { rows: itemCheck } = await client.query(
      `SELECT COUNT(*) AS remaining
       FROM menu_item_stations mis
       LEFT JOIN order_item_station_status oiss
         ON oiss.order_item_id = $1 AND oiss.station_id = mis.station_id
       WHERE mis.menu_item_id = (SELECT menu_item_id FROM order_items WHERE id = $1)
         AND COALESCE(oiss.status, 'pending') NOT IN ('done')`,
      [orderItemId],
    );

    const itemRemaining = parseInt(itemCheck[0].remaining, 10);
    if (itemRemaining > 0) {
      return; // this item still has stations not done
    }

    // All stations for this item are done — now check all items in the order
    const { rows: orderCheck } = await client.query(
      `SELECT COUNT(*) AS remaining
       FROM order_items oi
       WHERE oi.order_id = (SELECT order_id FROM order_items WHERE id = $1)
         AND EXISTS (
           SELECT 1 FROM menu_item_stations mis
           WHERE mis.menu_item_id = oi.menu_item_id
         )
         AND EXISTS (
           SELECT 1 FROM menu_item_stations mis2
           LEFT JOIN order_item_station_status oiss2
             ON oiss2.order_item_id = oi.id AND oiss2.station_id = mis2.station_id
           WHERE mis2.menu_item_id = oi.menu_item_id
             AND COALESCE(oiss2.status, 'pending') NOT IN ('done')
         )`,
      [orderItemId],
    );

    const orderRemaining = parseInt(orderCheck[0].remaining, 10);
    if (orderRemaining > 0) {
      return; // other items in the order still have pending stations
    }

    // All items in the order are fully done at every station — mark order ready
    const autoVals: any[] = [orderItemId];
    let autoEnterpriseCond = '';
    if (enterpriseId) {
      autoVals.push(enterpriseId);
      autoEnterpriseCond = `AND enterprise_id = $${autoVals.length}`;
    }

    const { rows: updatedOrder } = await client.query(
      `UPDATE orders
       SET status = 'ready', updated_at = NOW()
       WHERE id = (SELECT order_id FROM order_items WHERE id = $1)
         AND status IN ('confirmed', 'preparing')
         ${autoEnterpriseCond}
       RETURNING id, order_number`,
      autoVals,
    );

    if (updatedOrder.length > 0) {
      logger.info(
        `Order ${updatedOrder[0].order_number} auto-completed to 'ready' (all stations done)`,
      );
    }
  }
}
