import { logger } from '../utils/logger';
import { RabbitMQPublisher } from './rabbitmq.service';

/**
 * Transactional outbox.
 *
 * Зачем: публикация в RabbitMQ после COMMIT в try/catch теряет событие,
 * если брокер недоступен — API отвечает успехом, а кухня/склад/CRM о заказе
 * не узнают никогда. Здесь событие пишется в таблицу event_outbox В ТОЙ ЖЕ
 * транзакции, что и бизнес-данные, а воркер досылает его в брокер.
 *
 * Гарантия: at-least-once. Потребители должны быть идемпотентны
 * (у заказа есть id — по нему и дедуплицировать).
 */
export class OutboxService {
  /** Сколько раз пробуем отправить, прежде чем пометить failed. */
  private static readonly MAX_ATTEMPTS = 10;

  /** Сколько событий забирать за один проход воркера. */
  private static readonly BATCH_SIZE = 50;

  private timer: NodeJS.Timeout | null = null;
  private draining = false;

  constructor(
    private pool: any,
    private rabbitmq: RabbitMQPublisher
  ) {}

  /**
   * Записать событие в outbox. ОБЯЗАТЕЛЬНО передавать client той транзакции,
   * в которой пишутся бизнес-данные — иначе смысл outbox теряется.
   */
  async enqueue(
    client: any,
    event: {
      routingKey: string;
      payload: any;
      exchange?: string;
      aggregateType?: string;
      aggregateId?: string;
      enterpriseId?: string | null;
    }
  ): Promise<void> {
    await client.query(
      `INSERT INTO event_outbox
         (enterprise_id, exchange, routing_key, payload, aggregate_type, aggregate_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        event.enterpriseId || null,
        event.exchange || 'orders_exchange',
        event.routingKey,
        JSON.stringify(event.payload),
        event.aggregateType || null,
        event.aggregateId || null
      ]
    );
  }

  /**
   * Один проход: забрать готовые события и опубликовать.
   *
   * FOR UPDATE SKIP LOCKED — несколько реплик сервиса могут работать
   * параллельно и не возьмут одну строку дважды.
   */
  async drainOnce(): Promise<{ sent: number; failed: number }> {
    if (this.draining) return { sent: 0, failed: 0 };
    this.draining = true;

    let sent = 0;
    let failed = 0;

    try {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        const rows = await client.query(
          `SELECT id, exchange, routing_key, payload, attempts
           FROM event_outbox
           WHERE status = 'pending' AND next_attempt_at <= NOW()
           ORDER BY created_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED`,
          [OutboxService.BATCH_SIZE]
        );

        for (const row of rows.rows) {
          const ok = await this.rabbitmq.publishOrderEvent(
            row.routing_key,
            row.payload,
            row.exchange
          );

          if (ok) {
            await client.query(
              `UPDATE event_outbox
               SET status = 'sent', sent_at = NOW(), attempts = attempts + 1, last_error = NULL
               WHERE id = $1`,
              [row.id]
            );
            sent++;
          } else {
            const attempts = (row.attempts || 0) + 1;
            const exhausted = attempts >= OutboxService.MAX_ATTEMPTS;
            // Экспоненциальная задержка: 2^attempts секунд, но не больше часа
            const delaySec = Math.min(Math.pow(2, attempts), 3600);

            await client.query(
              `UPDATE event_outbox
               SET status = $2,
                   attempts = $3,
                   last_error = $4,
                   next_attempt_at = NOW() + ($5 || ' seconds')::interval
               WHERE id = $1`,
              [
                row.id,
                exhausted ? 'failed' : 'pending',
                attempts,
                'Не удалось опубликовать в RabbitMQ',
                String(delaySec)
              ]
            );
            failed++;
          }
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error(`Outbox drain failed: ${(error as Error).message}`);
    } finally {
      this.draining = false;
    }

    if (sent > 0 || failed > 0) {
      logger.info(`Outbox: отправлено ${sent}, с ошибкой ${failed}`);
    }
    return { sent, failed };
  }

  /** Периодический воркер. */
  start(intervalMs = 5000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.drainOnce().catch(err =>
        logger.error(`Outbox worker error: ${err.message}`)
      );
    }, intervalMs);
    // Не держим процесс живым только из-за таймера
    this.timer.unref?.();
    logger.info(`Outbox worker запущен, интервал ${intervalMs} мс`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Outbox worker остановлен');
    }
  }
}

export default OutboxService;
