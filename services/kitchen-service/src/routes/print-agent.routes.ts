import { Router, Request, Response, NextFunction } from 'express';
import pkg from 'pg';
const { Pool } = pkg;
import { config } from '../config';
import { logger } from '../utils/logger';
import { PrintQueueService, PrintAgentRow } from '../services/print-queue.service';

/**
 * Канал агента печати.
 *
 * Агент стоит на кухне и САМ подключается сюда исходящими запросами:
 * публичный IP, проброс портов и VPN на точке не нужны. Аутентификация —
 * собственный токен агента, не пользовательский JWT: у агента нет
 * человека за ним, а токен живёт на кухонной машине годами.
 */

const db = new Pool({ connectionString: config.database.url });
const queue = new PrintQueueService(db);

const router = Router();

declare global {
  namespace Express {
    interface Request {
      printAgent?: PrintAgentRow;
    }
  }
}

/** Токен берётся из Bearer или из X-Agent-Token — как удобнее агенту. */
function extractToken(req: Request): string {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.substring(7);
  const alt = req.headers['x-agent-token'];
  return typeof alt === 'string' ? alt : '';
}

const authenticateAgent = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const agent = await queue.authenticateAgent(extractToken(req));
    if (!agent) {
      return res.status(401).json({
        success: false,
        error: 'Неизвестный или отключённый токен агента',
      });
    }
    req.printAgent = agent;
    next();
  } catch (error) {
    logger.error('Ошибка аутентификации агента печати:', error);
    res.status(500).json({ success: false, error: 'Ошибка аутентификации' });
  }
};

router.use(authenticateAgent);

/**
 * POST /api/print-agent/hello
 * Агент отмечается на связи и получает список своих станций.
 */
router.post('/hello', async (req: Request, res: Response) => {
  const agent = req.printAgent!;
  try {
    const { version, platform, hostname } = req.body || {};
    await queue.recordHeartbeat(agent.id, { version, platform, hostname });
    const stations = await queue.listAgentStations(agent.id);

    res.json({
      success: true,
      data: {
        agent: { id: agent.id, name: agent.name, enterpriseId: agent.enterpriseId },
        stations: stations.map((s) => ({
          id: s.id,
          name: s.name,
          type: s.type,
          address: s.address,
          device: s.device,
          bluetooth: s.bluetooth,
          enabled: s.enabled,
        })),
        // Интервал опроса задаёт сервер: так его можно менять без
        // переустановки агентов на точках.
        pollIntervalMs: 3000,
      },
    });
  } catch (error) {
    logger.error('Ошибка hello агента печати:', error);
    res.status(500).json({ success: false, error: 'Не удалось отметиться' });
  }
});

/**
 * GET /api/print-agent/jobs
 * Агент забирает задания. Ответ — готовые байты ESC/POS в base64.
 */
router.get('/jobs', async (req: Request, res: Response) => {
  const agent = req.printAgent!;
  try {
    await queue.recordHeartbeat(agent.id);
    // Сторож зависших заданий живёт здесь, на опросе агента: отдельный
    // планировщик пришлось бы синхронизировать между репликами сервиса.
    await queue.requeueStaleJobs();

    const limit = Math.min(parseInt(String(req.query.limit || '5'), 10) || 5, 20);
    const jobs = await queue.claimJobs(agent.id, limit);

    res.json({ success: true, data: jobs });
  } catch (error) {
    logger.error('Ошибка выдачи заданий печати:', error);
    res.status(500).json({ success: false, error: 'Не удалось получить задания' });
  }
});

/**
 * POST /api/print-agent/jobs/:id/result
 * Агент подтверждает печать или сообщает ошибку.
 */
router.post('/jobs/:id/result', async (req: Request, res: Response) => {
  const agent = req.printAgent!;
  try {
    const { ok, error } = req.body || {};
    if (typeof ok !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'Поле ok (true/false) обязательно',
      });
    }

    const updated = await queue.reportResult(agent.id, req.params.id, ok, error);
    if (!updated) {
      return res.status(404).json({
        success: false,
        error: 'Задание не найдено или принадлежит другому агенту',
      });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Ошибка приёма результата печати:', error);
    res.status(500).json({ success: false, error: 'Не удалось записать результат' });
  }
});

/**
 * POST /api/print-agent/stations/:id/status
 * Агент сообщает, виден ли ему принтер станции.
 */
router.post('/stations/:id/status', async (req: Request, res: Response) => {
  const agent = req.printAgent!;
  try {
    const { status } = req.body || {};
    if (!['online', 'offline', 'testing'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'status должен быть online, offline или testing',
      });
    }

    // Обновление только своих станций: id станции агент знает из hello,
    // но проверка по agent_id не даёт пометить чужую.
    const r = await db.query(
      `UPDATE printer_stations SET status = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND agent_id = $2 RETURNING id`,
      [parseInt(req.params.id, 10), agent.id, status],
    );

    if (!r.rows.length) {
      return res.status(404).json({
        success: false,
        error: 'Станция не найдена или не привязана к этому агенту',
      });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Ошибка обновления статуса станции:', error);
    res.status(500).json({ success: false, error: 'Не удалось обновить статус' });
  }
});

export default router;
