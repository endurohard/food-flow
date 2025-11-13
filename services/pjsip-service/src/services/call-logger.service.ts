import { Pool } from 'pg';
import { Call, CallStats } from '../models/call.model.js';
import { logger } from '../utils/logger.js';

export class CallLoggerService {
  private pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl
    });
  }

  async initialize(): Promise<void> {
    try {
      // Create calls table if not exists
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS sip_calls (
          id UUID PRIMARY KEY,
          call_id VARCHAR(255) NOT NULL,
          session_id VARCHAR(255),
          direction VARCHAR(20) NOT NULL,
          from_number VARCHAR(50) NOT NULL,
          to_number VARCHAR(50) NOT NULL,
          extension VARCHAR(20),
          status VARCHAR(20) NOT NULL,
          start_time TIMESTAMP NOT NULL,
          answer_time TIMESTAMP,
          end_time TIMESTAMP,
          duration INTEGER,
          recording VARCHAR(255),
          customer_id UUID,
          customer_name VARCHAR(255),
          customer_phone VARCHAR(50),
          order_id UUID,
          notes TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_sip_calls_from ON sip_calls(from_number);
        CREATE INDEX IF NOT EXISTS idx_sip_calls_to ON sip_calls(to_number);
        CREATE INDEX IF NOT EXISTS idx_sip_calls_extension ON sip_calls(extension);
        CREATE INDEX IF NOT EXISTS idx_sip_calls_start_time ON sip_calls(start_time);
        CREATE INDEX IF NOT EXISTS idx_sip_calls_customer_id ON sip_calls(customer_id);
      `);

      logger.info('Call logger initialized');
    } catch (error) {
      logger.error('Failed to initialize call logger:', error);
      throw error;
    }
  }

  async logCall(call: Call): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO sip_calls (
          id, call_id, session_id, direction, from_number, to_number,
          extension, status, start_time, answer_time, end_time, duration,
          customer_id, customer_name, order_id, notes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        ON CONFLICT (id) DO UPDATE SET
          status = $8,
          answer_time = $10,
          end_time = $11,
          duration = $12,
          customer_id = $13,
          customer_name = $14,
          order_id = $15,
          notes = $16,
          updated_at = CURRENT_TIMESTAMP`,
        [
          call.id,
          call.callId,
          call.sessionId,
          call.direction,
          call.from,
          call.to,
          call.extension,
          call.status,
          call.startTime,
          call.answerTime,
          call.endTime,
          call.duration,
          call.customerId,
          call.customerName,
          call.orderId,
          call.notes
        ]
      );
    } catch (error) {
      logger.error('Failed to log call:', error);
      throw error;
    }
  }

  async getCallLogs(limit: number = 100, offset: number = 0): Promise<Call[]> {
    try {
      const result = await this.pool.query(
        `SELECT * FROM sip_calls
         ORDER BY start_time DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

      return result.rows.map(row => this.mapRowToCall(row));
    } catch (error) {
      logger.error('Failed to get call logs:', error);
      throw error;
    }
  }

  async getCallLogsByPhone(phoneNumber: string): Promise<Call[]> {
    try {
      const result = await this.pool.query(
        `SELECT * FROM sip_calls
         WHERE from_number = $1 OR to_number = $1
         ORDER BY start_time DESC`,
        [phoneNumber]
      );

      return result.rows.map(row => this.mapRowToCall(row));
    } catch (error) {
      logger.error('Failed to get call logs by phone:', error);
      throw error;
    }
  }

  async getCallStatsByExtension(
    extension: string,
    fromDate: Date,
    toDate: Date
  ): Promise<CallStats> {
    try {
      const result = await this.pool.query(
        `SELECT
          COUNT(*) as total_calls,
          COUNT(*) FILTER (WHERE direction = 'inbound') as inbound_calls,
          COUNT(*) FILTER (WHERE direction = 'outbound') as outbound_calls,
          COUNT(*) FILTER (WHERE status = 'answered') as answered_calls,
          COUNT(*) FILTER (WHERE status = 'no_answer' OR status = 'failed') as missed_calls,
          AVG(duration) FILTER (WHERE duration IS NOT NULL) as average_duration,
          SUM(duration) FILTER (WHERE duration IS NOT NULL) as total_duration
         FROM sip_calls
         WHERE extension = $1
         AND start_time BETWEEN $2 AND $3`,
        [extension, fromDate, toDate]
      );

      const row = result.rows[0];

      return {
        extension,
        totalCalls: parseInt(row.total_calls) || 0,
        inboundCalls: parseInt(row.inbound_calls) || 0,
        outboundCalls: parseInt(row.outbound_calls) || 0,
        answeredCalls: parseInt(row.answered_calls) || 0,
        missedCalls: parseInt(row.missed_calls) || 0,
        averageDuration: parseFloat(row.average_duration) || 0,
        totalDuration: parseInt(row.total_duration) || 0
      };
    } catch (error) {
      logger.error('Failed to get call stats:', error);
      throw error;
    }
  }

  async linkCallToCustomer(
    callId: string,
    customerId: string,
    customerName: string,
    customerPhone: string
  ): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE sip_calls
         SET customer_id = $1, customer_name = $2, customer_phone = $3, updated_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [customerId, customerName, customerPhone, callId]
      );
    } catch (error) {
      logger.error('Failed to link call to customer:', error);
      throw error;
    }
  }

  async linkCallToOrder(callId: string, orderId: string): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE sip_calls
         SET order_id = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [orderId, callId]
      );
    } catch (error) {
      logger.error('Failed to link call to order:', error);
      throw error;
    }
  }

  async addCallNote(callId: string, note: string): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE sip_calls
         SET notes = COALESCE(notes || E'\n', '') || $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [note, callId]
      );
    } catch (error) {
      logger.error('Failed to add call note:', error);
      throw error;
    }
  }

  private mapRowToCall(row: any): Call {
    return {
      id: row.id,
      callId: row.call_id,
      sessionId: row.session_id,
      direction: row.direction,
      from: row.from_number,
      to: row.to_number,
      extension: row.extension,
      status: row.status,
      startTime: row.start_time,
      answerTime: row.answer_time,
      endTime: row.end_time,
      duration: row.duration,
      recording: row.recording,
      customerId: row.customer_id,
      customerName: row.customer_name,
      orderId: row.order_id,
      notes: row.notes
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
    logger.info('Call logger closed');
  }
}
