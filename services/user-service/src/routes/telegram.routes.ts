import { Router, Request, Response } from 'express';
import Joi from 'joi';
import pkg from 'pg';
const { Pool } = pkg;
import { config } from '../config';
import { EnterpriseService } from '../services/enterprise.service';
import { authenticateUser } from '../middleware/enterprise.middleware';
import { TelegramIntegrationService, TelegramIntegrationError } from '../services/telegram-integration.service';

/**
 * «Настройки → Интеграции → Telegram-бот». Управляют только владелец и
 * админ своей организации. Токен бота наружу не отдаётся никогда.
 */
export function createTelegramRoutes(deps?: { pool?: any; enterpriseService?: any }) {
  const router = Router({ mergeParams: true });
  const pool = deps?.pool || new Pool({ connectionString: config.database.url });
  const enterpriseService = deps?.enterpriseService || new EnterpriseService(config.database.url);
  const tg = new TelegramIntegrationService(pool);

  const idOk = (req: Request, res: Response) => {
    if (Joi.string().uuid().validate(req.params.id).error) {
      res.status(400).json({ error: 'Validation error', message: 'Некорректный id организации' });
      return false;
    }
    return true;
  };

  const ownerOrAdmin = async (req: any, res: Response) => {
    if (!idOk(req, res)) return false;
    if (req.userRole === 'super_admin') return true;
    const ms = await enterpriseService.getUserEnterprises(req.userId);
    const m = ms.find((x: any) => x.enterprise_id === req.params.id);
    if (!m || !['owner', 'admin'].includes(m.user_role)) {
      res.status(403).json({ error: 'Forbidden', message: 'Настраивать Telegram-бота может владелец или админ организации' });
      return false;
    }
    return true;
  };

  const fail = (res: Response, e: any, what: string) => {
    if (e instanceof TelegramIntegrationError) return res.status(e.status).json({ error: e.message, message: e.message });
    if (String(e?.message).includes('ENCRYPTION_KEY')) {
      return res.status(503).json({ error: 'Шифрование не настроено на сервере', message: 'Шифрование не настроено на сервере' });
    }
    console.error(what, e);
    return res.status(500).json({ error: what, message: what });
  };

  router.get('/', authenticateUser, async (req: any, res) => {
    try {
      if (!(await ownerOrAdmin(req, res))) return;
      return res.json(await tg.getStatus(req.params.id, req.userId));
    } catch (e) { return fail(res, e, 'Не удалось загрузить настройки Telegram'); }
  });

  router.put('/', authenticateUser, async (req: any, res) => {
    try {
      const { error, value } = Joi.object({ token: Joi.string().trim().max(200).required() })
        .validate(req.body);
      if (error) return res.status(400).json({ error: 'Укажите токен бота', message: 'Укажите токен бота' });
      if (!(await ownerOrAdmin(req, res))) return;
      const bot = await tg.saveBot(req.params.id, value.token, req.userId);
      return res.json({ success: true, ...bot });
    } catch (e) { return fail(res, e, 'Не удалось подключить бота'); }
  });

  router.delete('/', authenticateUser, async (req: any, res) => {
    try {
      if (!(await ownerOrAdmin(req, res))) return;
      await tg.removeBot(req.params.id);
      return res.json({ success: true });
    } catch (e) { return fail(res, e, 'Не удалось отключить бота'); }
  });

  // Ссылка для привязки Telegram. Без userId — свой Telegram (владелец/админ).
  // С userId — для ответственного за закуп: админ пересылает ему ссылку,
  // и тот жмёт «Start» у себя; доступа к настройкам закупщику не нужно.
  router.post('/link', authenticateUser, async (req: any, res) => {
    try {
      const { error, value } = Joi.object({ userId: Joi.string().uuid().optional() }).validate(req.body || {});
      if (error) return res.status(400).json({ error: 'Некорректный id сотрудника', message: 'Некорректный id сотрудника' });
      if (!(await ownerOrAdmin(req, res))) return;
      const target = value.userId || req.userId;
      if (value.userId && !(await tg.isRecipient(req.params.id, target))) {
        return res.status(400).json({
          error: 'Сотрудник не получает уведомления',
          message: 'Сначала назначьте сотрудника ответственным за закуп'
        });
      }
      return res.json(await tg.createLink(req.params.id, target));
    } catch (e) { return fail(res, e, 'Не удалось создать ссылку'); }
  });

  // Назначить / снять ответственного за закуп
  router.put('/purchasers/:userId', authenticateUser, async (req: any, res) => {
    try {
      if (Joi.string().uuid().validate(req.params.userId).error) {
        return res.status(400).json({ error: 'Некорректный id', message: 'Некорректный id' });
      }
      const { error, value } = Joi.object({ purchaser: Joi.boolean().required() }).validate(req.body);
      if (error) return res.status(400).json({ error: 'Укажите purchaser: true или false', message: 'Укажите purchaser: true или false' });
      if (!(await ownerOrAdmin(req, res))) return;
      await tg.setPurchaser(req.params.id, req.params.userId, value.purchaser);
      return res.json({ success: true, ...(await tg.getStatus(req.params.id, req.userId)) });
    } catch (e) { return fail(res, e, 'Не удалось сохранить ответственного за закуп'); }
  });

  // Страница опрашивает это, пока человек нажимает «Start» в боте
  router.post('/poll', authenticateUser, async (req: any, res) => {
    try {
      if (!(await ownerOrAdmin(req, res))) return;
      const linked = await tg.pollLinks(req.params.id);
      return res.json({ linked, ...(await tg.getStatus(req.params.id, req.userId)) });
    } catch (e) { return fail(res, e, 'Не удалось проверить сообщения бота'); }
  });

  router.delete('/recipients/:userId', authenticateUser, async (req: any, res) => {
    try {
      if (Joi.string().uuid().validate(req.params.userId).error) {
        return res.status(400).json({ error: 'Некорректный id', message: 'Некорректный id' });
      }
      if (!(await ownerOrAdmin(req, res))) return;
      await tg.unlink(req.params.id, req.params.userId);
      return res.json({ success: true });
    } catch (e) { return fail(res, e, 'Не удалось отвязать'); }
  });

  router.post('/test', authenticateUser, async (req: any, res) => {
    try {
      if (!(await ownerOrAdmin(req, res))) return;
      const r = await tg.notify(req.params.id, '🔔 Проверка: уведомления FoodFlow приходят сюда.');
      if (r.skipped === 'no_bot') return res.status(409).json({ error: 'Бот не подключён', message: 'Бот не подключён' });
      if (r.skipped === 'no_recipients') {
        return res.status(409).json({ error: 'Никто не привязал Telegram', message: 'Никто ещё не привязал Telegram — нажмите «Привязать мой Telegram»' });
      }
      return res.json(r);
    } catch (e) { return fail(res, e, 'Не удалось отправить проверку'); }
  });

  return { router, tg };
}

/**
 * Внутренний вызов от других сервисов (склад: «пора заказать»).
 * Путь /internal не проброшен в Kong, плюс обязательный INTERNAL_TOKEN:
 * снаружи разослать сообщение от имени организации нельзя.
 */
export function createInternalNotifyRoute(tg: TelegramIntegrationService) {
  const router = Router();
  router.post('/internal/telegram-notify', async (req: Request, res: Response) => {
    const token = process.env.INTERNAL_TOKEN || '';
    if (!token || req.headers['x-internal-token'] !== token) return res.status(401).json({ error: 'Unauthorized' });
    const { error, value } = Joi.object({
      enterpriseId: Joi.string().uuid().required(),
      text: Joi.string().max(3500).required(),
      linkPath: Joi.string().pattern(/^\/[A-Za-z0-9/_.?=&-]*$/).optional()
    }).validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    try {
      return res.json(await tg.notify(value.enterpriseId, value.text, value.linkPath));
    } catch (e: any) {
      console.error('telegram notify failed:', e);
      return res.status(500).json({ error: e.message });
    }
  });
  return router;
}
