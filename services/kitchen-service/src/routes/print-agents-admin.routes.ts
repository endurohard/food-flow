import { Router, Request, Response } from 'express';
import pkg from 'pg';
const { Pool } = pkg;
import { config } from '../config';
import { logger } from '../utils/logger';
import { authenticateUser, requireRole } from '../middleware/auth.middleware';
import { PrintQueueService } from '../services/print-queue.service';

/**
 * Управление агентами печати из админки: создать агента, выдать токен,
 * привязать станции, посмотреть журнал печати.
 */

const db = new Pool({ connectionString: config.database.url });
const queue = new PrintQueueService(db);

const router = Router();
router.use(authenticateUser);
router.use(requireRole('admin', 'owner', 'manager'));
router.use((req: Request, res: Response, next) => {
  if (!req.enterpriseId) {
    return res.status(403).json({ success: false, error: 'Требуется контекст предприятия' });
  }
  next();
});

/** GET /api/print-agents — список агентов с признаком «на связи». */
router.get('/', async (req: Request, res: Response) => {
  try {
    const agents = await queue.listAgents(req.enterpriseId!);
    res.json({ success: true, data: agents });
  } catch (error) {
    logger.error('Не удалось получить список агентов печати:', error);
    res.status(500).json({ success: false, error: 'Не удалось получить список агентов' });
  }
});

/**
 * POST /api/print-agents — создать агента.
 * Токен возвращается ОДИН раз: в базе только хеш.
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, restaurantId } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Укажите название агента' });
    }

    const { agent, token } = await queue.createAgent({
      enterpriseId: req.enterpriseId!,
      name: name.trim(),
      restaurantId: restaurantId || null,
    });

    logger.info(`Создан агент печати: ${agent.name}`, { enterpriseId: req.enterpriseId });

    res.status(201).json({
      success: true,
      data: agent,
      token,
      tokenNotice: 'Токен показывается один раз. Сохраните его — восстановить нельзя.',
    });
  } catch (error) {
    logger.error('Не удалось создать агента печати:', error);
    res.status(500).json({ success: false, error: 'Не удалось создать агента' });
  }
});

/** POST /api/print-agents/:id/rotate-token — перевыпуск потерянного токена. */
router.post('/:id/rotate-token', async (req: Request, res: Response) => {
  try {
    const result = await queue.rotateToken(req.enterpriseId!, req.params.id);
    if (!result) {
      return res.status(404).json({ success: false, error: 'Агент не найден' });
    }
    logger.info(`Перевыпущен токен агента ${req.params.id}`);
    res.json({
      success: true,
      token: result.token,
      tokenNotice: 'Старый токен больше не работает — обновите его на кухонной машине.',
    });
  } catch (error) {
    logger.error('Не удалось перевыпустить токен агента:', error);
    res.status(500).json({ success: false, error: 'Не удалось перевыпустить токен' });
  }
});

/** PUT /api/print-agents/:id — включить/выключить агента. */
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: 'Поле enabled обязательно' });
    }
    const agent = await queue.setAgentEnabled(req.enterpriseId!, req.params.id, enabled);
    if (!agent) {
      return res.status(404).json({ success: false, error: 'Агент не найден' });
    }
    res.json({ success: true, data: agent });
  } catch (error) {
    logger.error('Не удалось обновить агента печати:', error);
    res.status(500).json({ success: false, error: 'Не удалось обновить агента' });
  }
});

/** DELETE /api/print-agents/:id */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const deleted = await queue.deleteAgent(req.enterpriseId!, req.params.id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Агент не найден' });
    }
    res.json({ success: true });
  } catch (error) {
    logger.error('Не удалось удалить агента печати:', error);
    res.status(500).json({ success: false, error: 'Не удалось удалить агента' });
  }
});

/**
 * POST /api/print-agents/:id/test
 * Тестовый чек через агента: задание кладётся в очередь, печатает агент.
 * Станцию указывать не обязательно — агент возьмёт свою первую.
 */
router.post('/:id/test', async (req: Request, res: Response) => {
  try {
    const agents = await queue.listAgents(req.enterpriseId!);
    const agent = agents.find((a) => a.id === req.params.id);
    if (!agent) {
      return res.status(404).json({ success: false, error: 'Агент не найден' });
    }

    const stations = await queue.listAgentStations(agent.id);
    const stationId = req.body?.stationId
      ? parseInt(String(req.body.stationId), 10)
      : stations[0]?.id;

    if (!stationId) {
      return res.status(400).json({
        success: false,
        error: 'К агенту не привязана ни одна станция — привяжите принтер в настройках',
      });
    }

    const station = stations.find((s) => s.id === stationId);
    if (!station) {
      return res.status(400).json({
        success: false,
        error: 'Станция не привязана к этому агенту',
      });
    }

    const job = await queue.enqueue({
      enterpriseId: req.enterpriseId!,
      agentId: agent.id,
      stationId,
      kind: 'test',
      testLabel: `${agent.name} / ${station.name}`,
    });

    // Честный ответ: задание поставлено. «Напечатано» скажет агент,
    // когда отчитается — обещать печать до этого нельзя.
    res.json({
      success: true,
      data: { jobId: job.id, preview: job.preview },
      message: agent.online
        ? 'Задание отправлено агенту. Проверьте, вышел ли чек.'
        : 'Задание в очереди, но агент сейчас не на связи — чек выйдет после подключения.',
      agentOnline: agent.online,
    });
  } catch (error) {
    logger.error('Не удалось поставить тестовое задание:', error);
    res.status(500).json({ success: false, error: 'Не удалось поставить задание' });
  }
});

/** GET /api/print-agents/jobs/list — журнал печати предприятия. */
router.get('/jobs/list', async (req: Request, res: Response) => {
  try {
    const jobs = await queue.listJobs(req.enterpriseId!, {
      limit: parseInt(String(req.query.limit || '50'), 10),
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
    });
    res.json({ success: true, data: jobs });
  } catch (error) {
    logger.error('Не удалось получить журнал печати:', error);
    res.status(500).json({ success: false, error: 'Не удалось получить журнал печати' });
  }
});

/** GET /api/print-agents/jobs/:id/preview — текстовый вид чека. */
router.get('/jobs/:id/preview', async (req: Request, res: Response) => {
  try {
    const preview = await queue.getJobPreview(req.enterpriseId!, req.params.id);
    if (preview === null) {
      return res.status(404).json({ success: false, error: 'Задание не найдено' });
    }
    res.json({ success: true, data: { preview } });
  } catch (error) {
    logger.error('Не удалось получить предпросмотр чека:', error);
    res.status(500).json({ success: false, error: 'Не удалось получить предпросмотр' });
  }
});

export default router;
