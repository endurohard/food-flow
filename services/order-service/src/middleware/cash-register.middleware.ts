import { Request, Response, NextFunction } from 'express';
import pkg from 'pg';
const { Pool } = pkg;

/**
 * Проверяет, что запрос к продаже приходит от активной (не заблокированной) кассы.
 *
 * Клиент отправляет токен сессии кассы в заголовке X-Register-Session.
 * Сервер проверяет запись cash_register_sessions:
 *   - id должна существовать,
 *   - status должна быть 'active' (иначе касса «заблокирована», 403),
 *   - для наличной оплаты регистр обязателен, поэтому register_id сессии
 *     должен совпадать с registerId в теле запроса.
 */
export function createCashRegisterSessionMiddleware(pool: InstanceType<typeof Pool>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    const sessionId = req.headers['x-register-session'] as string;
    if (!sessionId) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Для продажи требуется актуальная сессия кассы',
      });
    }

    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT status, register_id
         FROM cash_register_sessions
         WHERE id = $1 FOR UPDATE`,
        [sessionId]
      );
      const session = result.rows[0];
      if (!session) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Сессия кассы не найдена или истекла',
        });
      }
      if (session.status !== 'active') {
        return res.status(403).json({
          error: 'Cash register is locked',
          message: 'Касса заблокирована — введите PIN для разблокировки',
        });
      }
      // Регистр обязателен для наличных — проверяем совпадение.
      if (req.body.paymentMethod === 'cash' && req.body.registerId !== session.register_id) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Сессия кассы не соответствует регистру',
        });
      }
      next();
    } catch (error) {
      next(error);
    } finally {
      client.release();
    }
  };
}
