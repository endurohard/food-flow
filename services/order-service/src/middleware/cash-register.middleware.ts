import { Request, Response, NextFunction } from 'express';

/** Достаточно метода query: так в тестах подставляется мок без настоящего pg. */
export interface QueryablePool {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

/**
 * Пропускает продажу только от активной (не заблокированной) сессии режима кассы.
 *
 * Клиент шлёт id сессии в заголовке X-Register-Session. Сессия обязана:
 *   - принадлежать тому же пользователю, что и JWT (иначе id сессии,
 *     подсмотренный на планшете, открывал бы продажи под чужим логином);
 *   - быть в статусе 'active' и не истечь;
 *   - относиться к той кассе, в которую идут деньги (registerId в теле).
 *
 * Роут /api/pos/sales зовёт только экран режима кассы: pos.html и Android-касса
 * продают через /api/orders, поэтому обязательный заголовок их не ломает.
 */
export function createCashRegisterSessionMiddleware(pool: QueryablePool) {
  return async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    const sessionId = req.headers['x-register-session'];
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Для продажи требуется сессия кассы — войдите по PIN',
      });
    }

    try {
      const result = await pool.query(
        `SELECT user_id, register_id, status, expires_at > NOW() AS alive
           FROM cash_register_sessions
          WHERE id = $1`,
        [sessionId]
      );
      const session = result.rows[0];
      if (!session || session.user_id !== req.userId || !session.alive) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Сессия кассы не найдена или истекла — войдите по PIN заново',
        });
      }
      if (session.status !== 'active') {
        return res.status(403).json({
          error: 'Cash register is locked',
          message: 'Касса заблокирована — введите PIN для разблокировки',
        });
      }
      // Карта без кассы допустима (registerId пуст), но если касса указана —
      // только та, на которой открыта сессия
      if (req.body?.registerId && req.body.registerId !== session.register_id) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Сессия кассы открыта на другой кассе',
        });
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
