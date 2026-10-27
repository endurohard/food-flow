import crypto from 'crypto';
import type { Pool } from 'pg';
import { logger } from '../utils/logger';
import {
  renderKitchenTicket,
  renderCustomerReceipt,
  renderTestTicket,
  RenderOrder,
  RenderOptions,
} from './escpos-render.service';

export type JobKind = 'kitchen' | 'receipt' | 'test';

export interface PrintAgentRow {
  id: string;
  enterpriseId: string;
  restaurantId: string | null;
  name: string;
  enabled: boolean;
  agentVersion: string | null;
  platform: string | null;
  hostname: string | null;
  lastSeenAt: Date | null;
  /** Агент считается на связи, если отчитывался недавно */
  online: boolean;
  createdAt: Date;
}

/** Задание, которое отдаётся агенту на исполнение. */
export interface ClaimedJob {
  id: string;
  kind: JobKind;
  copies: number;
  station: {
    id: number | null;
    name: string | null;
    type: string | null;
    address: string | null;
    device: string | null;
    bluetooth: string | null;
  };
  /** Готовые байты ESC/POS в base64 — агент пишет их в принтер как есть */
  payload: string;
}

/** Задание считается зависшим, если агент забрал его и не отчитался. */
const STALE_CLAIM_SECONDS = 120;
/** Агент на связи, если отчитывался не позже этого порога. */
const ONLINE_WINDOW_SECONDS = 90;
/** Больше попыток не делаем: мёртвый принтер не должен копить бумагу. */
const MAX_ATTEMPTS = 5;

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function mapAgent(r: any): PrintAgentRow {
  const lastSeen = r.last_seen_at ? new Date(r.last_seen_at) : null;
  return {
    id: r.id,
    enterpriseId: r.enterprise_id,
    restaurantId: r.restaurant_id,
    name: r.name,
    enabled: r.enabled,
    agentVersion: r.agent_version,
    platform: r.platform,
    hostname: r.hostname,
    lastSeenAt: lastSeen,
    online:
      !!lastSeen && Date.now() - lastSeen.getTime() < ONLINE_WINDOW_SECONDS * 1000,
    createdAt: new Date(r.created_at),
  };
}

export class PrintQueueService {
  constructor(private db: Pool) {}

  // ─── Агенты ──────────────────────────────────────────────

  /**
   * Создаёт агента и возвращает токен ОДИН раз: в базе лежит только
   * sha256-хеш, восстановить токен нельзя — потерянный перевыпускается.
   */
  async createAgent(params: {
    enterpriseId: string;
    name: string;
    restaurantId?: string | null;
  }): Promise<{ agent: PrintAgentRow; token: string }> {
    const token = crypto.randomBytes(32).toString('base64url');
    const { rows } = await this.db.query(
      `INSERT INTO print_agents (enterprise_id, restaurant_id, name, token_hash)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [params.enterpriseId, params.restaurantId || null, params.name, hashToken(token)],
    );
    return { agent: mapAgent(rows[0]), token };
  }

  async listAgents(enterpriseId: string): Promise<PrintAgentRow[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM print_agents WHERE enterprise_id = $1 ORDER BY created_at`,
      [enterpriseId],
    );
    return rows.map(mapAgent);
  }

  async rotateToken(
    enterpriseId: string,
    agentId: string,
  ): Promise<{ token: string } | null> {
    const token = crypto.randomBytes(32).toString('base64url');
    const { rows } = await this.db.query(
      `UPDATE print_agents SET token_hash = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND enterprise_id = $2 RETURNING id`,
      [agentId, enterpriseId, hashToken(token)],
    );
    return rows.length ? { token } : null;
  }

  async setAgentEnabled(
    enterpriseId: string,
    agentId: string,
    enabled: boolean,
  ): Promise<PrintAgentRow | null> {
    const { rows } = await this.db.query(
      `UPDATE print_agents SET enabled = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND enterprise_id = $2 RETURNING *`,
      [agentId, enterpriseId, enabled],
    );
    return rows.length ? mapAgent(rows[0]) : null;
  }

  async deleteAgent(enterpriseId: string, agentId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `DELETE FROM print_agents WHERE id = $1 AND enterprise_id = $2 RETURNING id`,
      [agentId, enterpriseId],
    );
    return rows.length > 0;
  }

  /**
   * Аутентификация агента по токену. Отключённый агент не аутентифицируется:
   * иначе «выключил на точке» в админке ничего бы не значило.
   */
  async authenticateAgent(token: string): Promise<PrintAgentRow | null> {
    if (!token) return null;
    const { rows } = await this.db.query(
      `SELECT * FROM print_agents WHERE token_hash = $1 AND enabled = true`,
      [hashToken(token)],
    );
    return rows.length ? mapAgent(rows[0]) : null;
  }

  async recordHeartbeat(
    agentId: string,
    info: { version?: string; platform?: string; hostname?: string } = {},
  ): Promise<void> {
    await this.db.query(
      `UPDATE print_agents SET
         last_seen_at  = CURRENT_TIMESTAMP,
         agent_version = COALESCE($2, agent_version),
         platform      = COALESCE($3, platform),
         hostname      = COALESCE($4, hostname),
         updated_at    = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [agentId, info.version || null, info.platform || null, info.hostname || null],
    );
  }

  /** Станции, закреплённые за агентом — он сам сообщает их статус. */
  async listAgentStations(agentId: string): Promise<any[]> {
    const { rows } = await this.db.query(
      `SELECT id, name, type, address, device, bluetooth, categories, copies, enabled, status
         FROM printer_stations WHERE agent_id = $1 ORDER BY id`,
      [agentId],
    );
    return rows;
  }

  // ─── Очередь ─────────────────────────────────────────────

  /**
   * Ставит задание в очередь. Рендер идёт здесь, на сервере: агент
   * получает готовые байты и не знает про формат чека.
   */
  async enqueue(params: {
    enterpriseId: string;
    stationId?: number | null;
    agentId?: string | null;
    orderId?: string | null;
    kind: JobKind;
    order?: RenderOrder;
    testLabel?: string;
    copies?: number;
    options?: RenderOptions;
  }): Promise<{ id: string; preview: string }> {
    let rendered: { payload: Buffer; preview: string };

    if (params.kind === 'test') {
      rendered = renderTestTicket(params.testLabel || 'FoodFlow', params.options);
    } else if (!params.order) {
      throw new Error('Для задания печати заказа требуется order');
    } else if (params.kind === 'kitchen') {
      rendered = renderKitchenTicket(params.order, params.options);
    } else {
      rendered = renderCustomerReceipt(params.order, params.options);
    }

    const { rows } = await this.db.query(
      `INSERT INTO print_jobs
         (enterprise_id, station_id, agent_id, order_id, kind, payload, preview, copies)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        params.enterpriseId,
        params.stationId ?? null,
        params.agentId ?? null,
        params.orderId ?? null,
        params.kind,
        rendered.payload,
        rendered.preview,
        params.copies && params.copies > 0 ? params.copies : 1,
      ],
    );

    return { id: rows[0].id, preview: rendered.preview };
  }

  /**
   * Агент забирает свои задания. FOR UPDATE SKIP LOCKED — чтобы два
   * параллельных опроса одного агента (или перезапуск во время опроса)
   * не выдали один чек дважды.
   */
  async claimJobs(agentId: string, limit = 5): Promise<ClaimedJob[]> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `SELECT j.id, j.kind, j.copies, j.payload,
                s.id AS station_id, s.name AS station_name, s.type AS station_type,
                s.address, s.device, s.bluetooth
           FROM print_jobs j
           LEFT JOIN printer_stations s ON s.id = j.station_id
          WHERE j.agent_id = $1 AND j.status = 'queued'
          ORDER BY j.created_at ASC
          LIMIT $2
            FOR UPDATE OF j SKIP LOCKED`,
        [agentId, limit],
      );

      if (rows.length) {
        await client.query(
          `UPDATE print_jobs
              SET status = 'in_progress',
                  claimed_at = CURRENT_TIMESTAMP,
                  attempts = attempts + 1
            WHERE id = ANY($1::uuid[])`,
          [rows.map((r) => r.id)],
        );
      }

      await client.query('COMMIT');

      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        copies: r.copies,
        station: {
          id: r.station_id ?? null,
          name: r.station_name ?? null,
          type: r.station_type ?? null,
          address: r.address ?? null,
          device: r.device ?? null,
          bluetooth: r.bluetooth ?? null,
        },
        payload: Buffer.from(r.payload).toString('base64'),
      }));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Агент подтверждает результат. Задание ищется вместе с agent_id:
   * чужой агент не может закрыть не своё задание.
   */
  async reportResult(
    agentId: string,
    jobId: string,
    ok: boolean,
    error?: string,
  ): Promise<boolean> {
    if (ok) {
      const { rows } = await this.db.query(
        `UPDATE print_jobs
            SET status = 'done', printed_at = CURRENT_TIMESTAMP, last_error = NULL
          WHERE id = $1 AND agent_id = $2 RETURNING id`,
        [jobId, agentId],
      );
      return rows.length > 0;
    }

    // Пока попытки не исчерпаны — возвращаем в очередь, потом фиксируем отказ.
    const { rows } = await this.db.query(
      `UPDATE print_jobs
          SET status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'queued' END,
              last_error = $4
        WHERE id = $1 AND agent_id = $2 RETURNING id, status`,
      [jobId, agentId, MAX_ATTEMPTS, error || 'Ошибка печати на агенте'],
    );
    if (rows.length) {
      logger.warn(`Задание печати ${jobId} не напечатано: ${error}`, {
        status: rows[0].status,
      });
    }
    return rows.length > 0;
  }

  /**
   * Возвращает в очередь задания, забранные агентом и не подтверждённые:
   * агент мог потерять связь или быть убит посреди печати. Без этого
   * чек навсегда остаётся в in_progress и просто не печатается.
   */
  async requeueStaleJobs(): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE print_jobs
          SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'queued' END,
              last_error = 'Агент не подтвердил печать'
        WHERE status = 'in_progress'
          AND claimed_at < CURRENT_TIMESTAMP - ($1 || ' seconds')::interval`,
      [String(STALE_CLAIM_SECONDS), MAX_ATTEMPTS],
    );
    if (rowCount) logger.warn(`Возвращено в очередь зависших заданий: ${rowCount}`);
    return rowCount || 0;
  }

  /** Журнал печати для админки. */
  async listJobs(
    enterpriseId: string,
    opts: { limit?: number; status?: string } = {},
  ): Promise<any[]> {
    const vals: any[] = [enterpriseId];
    let where = 'j.enterprise_id = $1';
    if (opts.status) {
      vals.push(opts.status);
      where += ` AND j.status = $${vals.length}`;
    }
    vals.push(Math.min(opts.limit || 50, 200));

    const { rows } = await this.db.query(
      `SELECT j.id, j.kind, j.status, j.copies, j.attempts, j.last_error,
              j.created_at, j.printed_at, j.order_id,
              s.name AS station_name, a.name AS agent_name
         FROM print_jobs j
         LEFT JOIN printer_stations s ON s.id = j.station_id
         LEFT JOIN print_agents a ON a.id = j.agent_id
        WHERE ${where}
        ORDER BY j.created_at DESC
        LIMIT $${vals.length}`,
      vals,
    );

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      copies: r.copies,
      attempts: r.attempts,
      lastError: r.last_error,
      createdAt: r.created_at,
      printedAt: r.printed_at,
      orderId: r.order_id,
      stationName: r.station_name,
      agentName: r.agent_name,
    }));
  }

  async getJobPreview(enterpriseId: string, jobId: string): Promise<string | null> {
    const { rows } = await this.db.query(
      `SELECT preview FROM print_jobs WHERE id = $1 AND enterprise_id = $2`,
      [jobId, enterpriseId],
    );
    return rows.length ? rows[0].preview : null;
  }

  /**
   * Маршрутизация заказа по станциям: станция печатает только свои
   * категории. Станция без агента пропускается — печатать на неё
   * удалённый сервер всё равно не может, и чек ушёл бы в никуда.
   */
  async enqueueOrderToStations(params: {
    enterpriseId: string;
    order: RenderOrder;
    orderId?: string | null;
    itemCategories?: Record<string, string>;
  }): Promise<{ queued: number; skipped: string[] }> {
    const { rows: stations } = await this.db.query(
      `SELECT s.*, a.id AS agent_id_resolved, a.enabled AS agent_enabled
         FROM printer_stations s
         LEFT JOIN print_agents a ON a.id = s.agent_id
        WHERE s.enterprise_id = $1 AND s.enabled = true`,
      [params.enterpriseId],
    );

    const { rows: settingsRows } = await this.db.query(
      `SELECT paper_width, encoding, default_copies FROM printer_settings
        WHERE enterprise_id = $1`,
      [params.enterpriseId],
    );
    const settings = settingsRows[0] || {};
    const options: RenderOptions = {
      paperWidth: settings.paper_width === 58 ? 58 : 80,
      encoding: settings.encoding === 'CP1251' ? 'CP1251' : 'CP866',
    };

    let queued = 0;
    const skipped: string[] = [];

    for (const st of stations) {
      if (!st.agent_id_resolved || !st.agent_enabled) {
        skipped.push(`${st.name}: не привязан агент печати`);
        continue;
      }

      const categories: string[] = Array.isArray(st.categories) ? st.categories : [];
      // Пустой список категорий = станция печатает всё (общая касса).
      const items = categories.length
        ? params.order.items.filter((i) => {
            const cat = params.itemCategories?.[i.name];
            return !!cat && categories.includes(cat);
          })
        : params.order.items;

      if (!items.length) continue;

      await this.enqueue({
        enterpriseId: params.enterpriseId,
        stationId: st.id,
        agentId: st.agent_id_resolved,
        orderId: params.orderId ?? null,
        kind: 'kitchen',
        order: { ...params.order, items, stationName: st.name },
        copies: st.copies || settings.default_copies || 1,
        options,
      });
      queued++;
    }

    return { queued, skipped };
  }
}
