import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { AuthService, AuthError } from '../services/auth.service';
import { UserService } from '../services/user.service';
import { config } from '../config';
import { authenticateUser } from '../middleware/enterprise.middleware';

const router = Router();
const authService = new AuthService(config.database.url);
const userService = new UserService(config.database.url);

// Validation schemas
const registerSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).max(128).required(),
  firstName: Joi.string().min(1).max(100).required(),
  lastName: Joi.string().min(1).max(100).required(),
  phone: Joi.string().max(20).optional(),
  role: Joi.string().valid('customer', 'restaurant_owner', 'delivery_driver', 'admin').optional()
});

const loginSchema = Joi.object({
  // На адресе организации (coffee104.food-flow.ru) можно ввести короткий логин —
  // часть email до «@»; host говорит, в какой организации его искать
  email: Joi.alternatives(
    Joi.string().email(),
    Joi.string().pattern(/^[a-zA-Z0-9._-]{2,64}$/)
  ).required().messages({ 'alternatives.match': 'Введите email или логин' }),
  password: Joi.string().required(),
  host: Joi.string().max(253).optional()
});

const refreshSchema = Joi.object({
  refreshToken: Joi.string().required()
});

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, firstName, lastName]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 minLength: 6
 *               firstName:
 *                 type: string
 *               lastName:
 *                 type: string
 *               phone:
 *                 type: string
 *               role:
 *                 type: string
 *                 enum: [customer, restaurant_owner, delivery_driver, admin]
 *     responses:
 *       201:
 *         description: User registered successfully
 *       400:
 *         description: Invalid input
 *       409:
 *         description: User already exists
 */
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { error, value } = registerSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Validation error',
        message: error.details[0].message
      });
    }

    const result = await authService.register(value);

    return res.status(201).json({
      user: result.user,
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return res.status(error.statusCode).json({
        error: error.name,
        message: error.message
      });
    }
    console.error('Registration error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Login user
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 *       401:
 *         description: Invalid credentials
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { error, value } = loginSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Validation error',
        message: error.details[0].message
      });
    }

    const result = await authService.login(value);

    return res.status(200).json({
      user: result.user,
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return res.status(error.statusCode).json({
        error: error.name,
        message: error.message
      });
    }
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/auth/refresh:
 *   post:
 *     summary: Refresh access token
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: Token refreshed successfully
 *       401:
 *         description: Invalid refresh token
 */
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { error, value } = refreshSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Validation error',
        message: error.details[0].message
      });
    }

    const tokens = await authService.refreshTokens(value.refreshToken);

    return res.status(200).json({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return res.status(error.statusCode).json({
        error: error.name,
        message: error.message
      });
    }
    console.error('Refresh error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     summary: Logout user
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: Logout successful
 */
router.post('/logout', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;

    if (refreshToken) {
      await authService.logout(refreshToken);
    }

    return res.status(200).json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PIN-режим кассы ─────────────────────────────────────────────────────
// После входа по email+паролю кассир вводит PIN, и тогда активируется
// режим кассы (только продажи). Тот же PIN снимает блокировку.
// Все три вызова требуют JWT: без него req.userId пуст, и раньше каждый
// ответ был 401 «Пользователь не идентифицирован».

const cashRegisterPinSchema = Joi.object({
  pin: Joi.string().min(4).max(6).required(),
  registerId: Joi.string().uuid().required(),
});

const cashRegisterLockSchema = Joi.object({
  registerId: Joi.string().uuid().required(),
});

/** Касса должна принадлежать организации из токена — иначе чужой registerId откроет сессию на чужой кассе. */
async function checkRegister(req: Request, res: Response, registerId: string): Promise<boolean> {
  if (!req.enterpriseId) {
    res.status(403).json({ error: 'Forbidden', message: 'Пользователь не привязан к организации' });
    return false;
  }
  const ok = await authService.registerBelongsToEnterprise(registerId, req.enterpriseId);
  if (!ok) {
    res.status(404).json({ error: 'Not found', message: 'Касса не найдена в вашей организации' });
    return false;
  }
  return true;
}

/**
 * На кассу вошли пользователем без PIN (обычно владелец — касса подхватила вход
 * из админки в том же браузере). Говорим об этом прямо: «Неверный PIN» здесь
 * вводит в заблуждение — верного PIN у такого пользователя нет вовсе.
 */
async function requirePin(req: Request, res: Response): Promise<boolean> {
  if (await userService.hasCashRegisterPin(req.userId!)) return true;
  res.status(403).json({
    error: 'No PIN',
    message: 'У этого пользователя нет PIN кассира — войдите на кассу логином кассира',
  });
  return false;
}

const pinLoginSchema = Joi.object({
  deviceToken: Joi.string().hex().length(64).required(),
  pin: Joi.string().pattern(/^[0-9]{4}$/).required()
    .messages({ 'string.pattern.base': 'PIN — 4 цифры' }),
});

/**
 * Вход кассира одним PIN с привязанного планшета — без логина и пароля.
 * Отдаёт токены кассира и сразу открытую сессию кассы.
 */
router.post('/cash-register/pin-login', async (req: Request, res: Response) => {
  try {
    const { error, value } = pinLoginSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: 'Validation error', message: error.details[0].message });
    }
    const r = await authService.pinLogin(value.deviceToken, value.pin);
    return res.status(200).json({
      user: r.user,
      accessToken: r.tokens.accessToken,
      refreshToken: r.tokens.refreshToken,
      registerSessionId: r.registerSessionId,
      register: r.register,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return res.status(error.statusCode).json({ error: error.code || 'Auth error', message: error.message });
    }
    console.error('Cash register pin-login error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** Проверяет PIN и открывает новую сессию кассы (прежние сессии этого кассира на этой кассе гасятся). */
router.post('/cash-register/verify', authenticateUser, async (req: Request, res: Response) => {
  try {
    const { error, value } = cashRegisterPinSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: 'Validation error', message: error.details[0].message });
    }
    if (!(await checkRegister(req, res, value.registerId))) return;
    if (!(await requirePin(req, res))) return;
    const ok = await userService.verifyCashRegisterPin(req.userId!, value.pin);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid PIN', message: 'Неверный PIN кассира' });
    }
    const sessionId = await authService.createCashRegisterSession(req.userId!, value.registerId);
    return res.status(200).json({ ok: true, registerSessionId: sessionId });
  } catch (error) {
    console.error('Cash register verify error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Блокирует кассу. PIN для блокировки не нужен: кассир отходит от планшета
 * одним нажатием, а снять блокировку можно только PIN-ом.
 */
router.post('/cash-register/lock', authenticateUser, async (req: Request, res: Response) => {
  try {
    const { error, value } = cashRegisterLockSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: 'Validation error', message: error.details[0].message });
    }
    if (!(await checkRegister(req, res, value.registerId))) return;
    const session = await authService.getCashRegisterSessionByRegister(value.registerId, req.userId!);
    if (!session) {
      return res.status(404).json({ error: 'Session not found', message: 'Сессия кассы не найдена — войдите по PIN' });
    }
    await authService.setCashRegisterSessionStatus(session.id, 'locked');
    return res.status(200).json({ ok: true, locked: true });
  } catch (error) {
    console.error('Cash register lock error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** Снимает блокировку PIN-ом и продлевает ту же сессию. */
router.post('/cash-register/unlock', authenticateUser, async (req: Request, res: Response) => {
  try {
    const { error, value } = cashRegisterPinSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: 'Validation error', message: error.details[0].message });
    }
    if (!(await checkRegister(req, res, value.registerId))) return;
    if (!(await requirePin(req, res))) return;
    const ok = await userService.verifyCashRegisterPin(req.userId!, value.pin);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid PIN', message: 'Неверный PIN кассира' });
    }
    const session = await authService.getCashRegisterSessionByRegister(value.registerId, req.userId!);
    // Истёкшую или отсутствующую сессию не воскрешаем — открываем новую
    const sessionId = session && new Date(session.expires_at) > new Date()
      ? (await authService.setCashRegisterSessionStatus(session.id, 'active'), session.id)
      : await authService.createCashRegisterSession(req.userId!, value.registerId);
    return res.status(200).json({ ok: true, registerSessionId: sessionId });
  } catch (error) {
    console.error('Cash register unlock error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
