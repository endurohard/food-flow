import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { AuthService, AuthError } from '../services/auth.service';
import { UserService } from '../services/user.service';
import { config } from '../config';

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
  email: Joi.string().email().required(),
  password: Joi.string().required()
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
// режим кассы (только продажи). То же PIN используется для блокировки и
// разблокировки кассы.

const cashRegisterPinSchema = Joi.object({
  pin: Joi.string().min(4).max(100).required(),
});

/** Верифицирует PIN и создаёт (или возобновляет) сессию кассы. */
router.post('/cash-register/verify', async (req: Request, res: Response) => {
  try {
    const { error, value } = cashRegisterPinSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Validation error',
        message: error.details[0].message,
      });
    }
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Пользователь не идентифицирован' });
    }
    const ok = await userService.verifyCashRegisterPin(userId, value.pin);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid PIN', message: 'Неверный PIN кассира' });
    }
    const registerId = req.body.registerId;
    if (!registerId) {
      return res.status(400).json({ error: 'Validation error', message: 'registerId обязателен' });
    }
    const sessionId = await authService.createCashRegisterSession(userId, registerId);
    return res.status(200).json({ registerSessionId: sessionId, ok: true });
  } catch (error) {
    console.error('Cash register verify error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** Блокирует кассу: запрещает продажи до разблокировки PIN. */
router.post('/cash-register/lock', async (req: Request, res: Response) => {
  try {
    const { error, value } = cashRegisterPinSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Validation error',
        message: error.details[0].message,
      });
    }
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Пользователь не идентифицирован' });
    }
    const registerId = req.body.registerId;
    if (!registerId) {
      return res.status(400).json({ error: 'Validation error', message: 'registerId обязателен' });
    }
    const ok = await userService.verifyCashRegisterPin(userId, value.pin);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid PIN', message: 'Неверный PIN кассира' });
    }
    const session = await authService.getCashRegisterSessionByRegister(registerId, userId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found', message: 'Сессия кассы не найдена' });
    }
    if (session.status === 'locked') {
      return res.status(409).json({ error: 'Already locked', message: 'Касса уже заблокирована' });
    }
    await authService.setCashRegisterSessionStatus(session.id, 'locked', new Date());
    return res.status(200).json({ ok: true, locked: true });
  } catch (error) {
    console.error('Cash register lock error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** Разблокирует кассу: возвращает кассе права на продажу. */
router.post('/cash-register/unlock', async (req: Request, res: Response) => {
  try {
    const { error, value } = cashRegisterPinSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Validation error',
        message: error.details[0].message,
      });
    }
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Пользователь не идентифицирован' });
    }
    const registerId = req.body.registerId;
    if (!registerId) {
      return res.status(400).json({ error: 'Validation error', message: 'registerId обязателен' });
    }
    const ok = await userService.verifyCashRegisterPin(userId, value.pin);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid PIN', message: 'Неверный PIN кассира' });
    }
    const session = await authService.getCashRegisterSessionByRegister(registerId, userId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found', message: 'Сессия кассы не найдена' });
    }
    if (session.status === 'active') {
      return res.status(409).json({ error: 'Already active', message: 'Касса уже разблокирована' });
    }
    await authService.setCashRegisterSessionStatus(session.id, 'active');
    const sessionId = await authService.createCashRegisterSession(userId, registerId);
    return res.status(200).json({ registerSessionId: sessionId, ok: true });
  } catch (error) {
    console.error('Cash register unlock error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
