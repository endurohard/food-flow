import { Pool } from 'pg';
import { Call, CallLog } from '../models/call.model';
import { logger } from '../utils/logger';

export class CallLoggerService {
  private pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl
    });
  }

  async initialize(): Promise<void> {
    try {
      await this.createTables();
      logger.info('Call logger service initialized');
    } catch (error) {
      logger.error('Failed to initialize call logger:', error);
      throw error;
    }
  }

  private async createTables(): Promise<void> {
    const createCallLogsTable = `
      CREATE TABLE IF NOT EXISTS call_logs (
        id SERIAL PRIMARY KEY,
        call_id VARCHAR(255) UNIQUE NOT NULL,
        direction VARCHAR(20) NOT NULL,
        caller_number VARCHAR(50) NOT NULL,
        called_number VARCHAR(50) NOT NULL,
        extension VARCHAR(20) NOT NULL,
        start_time TIMESTAMP NOT NULL,
        answer_time TIMESTAMP,
        end_time TIMESTAMP,
        duration INTEGER DEFAULT 0,
        status VARCHAR(20) NOT NULL,
        customer_id INTEGER,
        customer_name VARCHAR(255),
        customer_phone VARCHAR(50),
        order_id INTEGER,
        recording VARCHAR(255),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_call_logs_caller ON call_logs(caller_number);
      CREATE INDEX IF NOT EXISTS idx_call_logs_called ON call_logs(called_number);
      CREATE INDEX IF NOT EXISTS idx_call_logs_extension ON call_logs(extension);
      CREATE INDEX IF NOT EXISTS idx_call_logs_customer ON call_logs(customer_id);
      CREATE INDEX IF NOT EXISTS idx_call_logs_start_time ON call_logs(start_time DESC);
    `;

    const createExtensionsTable = `
      CREATE TABLE IF NOT EXISTS extensions (
        id SERIAL PRIMARY KEY,
        number VARCHAR(20) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        department VARCHAR(100),
        status VARCHAR(20) DEFAULT 'offline',
        last_seen TIMESTAMP,
        calls_today INTEGER DEFAULT 0,
        avg_call_duration INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_extensions_number ON extensions(number);
    `;

    await this.pool.query(createCallLogsTable);
    await this.pool.query(createExtensionsTable);
  }

  async logCall(call: Call): Promise<void> {
    try {
      const query = `
        INSERT INTO call_logs (
          call_id, direction, caller_number, called_number, extension,
          start_time, answer_time, end_time, duration, status,
          customer_id, customer_name, customer_phone, order_id, recording, notes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        ON CONFLICT (call_id) DO UPDATE SET
          answer_time = EXCLUDED.answer_time,
          end_time = EXCLUDED.end_time,
          duration = EXCLUDED.duration,
          status = EXCLUDED.status,
          customer_id = EXCLUDED.customer_id,
          customer_name = EXCLUDED.customer_name,
          customer_phone = EXCLUDED.customer_phone,
          order_id = EXCLUDED.order_id,
          notes = EXCLUDED.notes
      `;

      await this.pool.query(query, [
        call.callId,
        call.direction,
        call.from,
        call.to,
        call.extension,
        call.startTime,
        call.answerTime,
        call.endTime,
        call.duration || 0,
        call.status,
        call.customerId,
        call.customerName,
        call.customerPhone,
        call.orderId,
        call.recording,
        call.notes
      ]);

      logger.debug(`Call ${call.callId} logged to database`);
    } catch (error) {
      logger.error('Failed to log call:', error);
      throw error;
    }
  }

  async getCallLogs(limit: number = 100, offset: number = 0): Promise<CallLog[]> {
    try {
      const query = `
        SELECT
          id, call_id, direction, caller_number, called_number, extension,
          start_time, answer_time, end_time, duration, status,
          customer_id, order_id, recording, created_at
        FROM call_logs
        ORDER BY start_time DESC
        LIMIT $1 OFFSET $2
      `;

      const result = await this.pool.query(query, [limit, offset]);

      return result.rows.map(row => ({
        id: row.id,
        callId: row.call_id,
        direction: row.direction,
        callerNumber: row.caller_number,
        calledNumber: row.called_number,
        extension: row.extension,
        startTime: row.start_time,
        answerTime: row.answer_time,
        endTime: row.end_time,
        duration: row.duration,
        status: row.status,
        customerId: row.customer_id,
        orderId: row.order_id,
        recording: row.recording,
        createdAt: row.created_at
      }));
    } catch (error) {
      logger.error('Failed to get call logs:', error);
      throw error;
    }
  }

  async getCallLogsByPhone(phoneNumber: string): Promise<CallLog[]> {
    try {
      const query = `
        SELECT
          id, call_id, direction, caller_number, called_number, extension,
          start_time, answer_time, end_time, duration, status,
          customer_id, order_id, recording, created_at
        FROM call_logs
        WHERE caller_number = $1 OR called_number = $1
        ORDER BY start_time DESC
        LIMIT 50
      `;

      const result = await this.pool.query(query, [phoneNumber]);

      return result.rows.map(row => ({
        id: row.id,
        callId: row.call_id,
        direction: row.direction,
        callerNumber: row.caller_number,
        calledNumber: row.called_number,
        extension: row.extension,
        startTime: row.start_time,
        answerTime: row.answer_time,
        endTime: row.end_time,
        duration: row.duration,
        status: row.status,
        customerId: row.customer_id,
        orderId: row.order_id,
        recording: row.recording,
        createdAt: row.created_at
      }));
    } catch (error) {
      logger.error('Failed to get call logs by phone:', error);
      throw error;
    }
  }

  async getCallStatsByExtension(extension: string, fromDate: Date, toDate: Date): Promise<any> {
    try {
      const query = `
        SELECT
          COUNT(*) as total_calls,
          SUM(CASE WHEN status = 'answered' THEN 1 ELSE 0 END) as answered_calls,
          SUM(CASE WHEN status = 'missed' THEN 1 ELSE 0 END) as missed_calls,
          AVG(CASE WHEN duration > 0 THEN duration ELSE NULL END) as avg_duration,
          SUM(duration) as total_duration
        FROM call_logs
        WHERE extension = $1 AND start_time BETWEEN $2 AND $3
      `;

      const result = await this.pool.query(query, [extension, fromDate, toDate]);

      return {
        totalCalls: parseInt(result.rows[0].total_calls) || 0,
        answeredCalls: parseInt(result.rows[0].answered_calls) || 0,
        missedCalls: parseInt(result.rows[0].missed_calls) || 0,
        avgDuration: parseFloat(result.rows[0].avg_duration) || 0,
        totalDuration: parseInt(result.rows[0].total_duration) || 0
      };
    } catch (error) {
      logger.error('Failed to get call stats:', error);
      throw error;
    }
  }

  async linkCallToCustomer(callId: string, customerId: number, customerName: string, customerPhone: string): Promise<void> {
    try {
      const query = `
        UPDATE call_logs
        SET customer_id = $2, customer_name = $3, customer_phone = $4
        WHERE call_id = $1
      `;

      await this.pool.query(query, [callId, customerId, customerName, customerPhone]);
      logger.debug(`Call ${callId} linked to customer ${customerId}`);
    } catch (error) {
      logger.error('Failed to link call to customer:', error);
      throw error;
    }
  }

  async linkCallToOrder(callId: string, orderId: number): Promise<void> {
    try {
      const query = `
        UPDATE call_logs
        SET order_id = $2
        WHERE call_id = $1
      `;

      await this.pool.query(query, [callId, orderId]);
      logger.debug(`Call ${callId} linked to order ${orderId}`);
    } catch (error) {
      logger.error('Failed to link call to order:', error);
      throw error;
    }
  }

  async addCallNote(callId: string, note: string): Promise<void> {
    try {
      const query = `
        UPDATE call_logs
        SET notes = COALESCE(notes || E'\\n', '') || $2
        WHERE call_id = $1
      `;

      await this.pool.query(query, [callId, note]);
      logger.debug(`Note added to call ${callId}`);
    } catch (error) {
      logger.error('Failed to add call note:', error);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
    logger.info('Call logger service closed');
  }
}
