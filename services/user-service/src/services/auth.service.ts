import pkg from 'pg';
const { Pool } = pkg;
type PoolClient = pkg.PoolClient;
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config';

export interface RegisterInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone?: string;
  role?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface JwtPayload {
  userId: string;
  email: string;
  role: string;
  enterpriseId?: string;
  enterpriseRole?: string;
}

export class AuthService {
  private pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async register(data: RegisterInput): Promise<{ user: any; tokens: AuthTokens }> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Check if user already exists
      const existing = await client.query(
        'SELECT id FROM users WHERE email = $1',
        [data.email.toLowerCase()]
      );

      if (existing.rows.length > 0) {
        throw new AuthError('User with this email already exists', 409);
      }

      // Hash password
      const passwordHash = await bcrypt.hash(data.password, config.bcrypt.saltRounds);

      // Insert user
      const result = await client.query(
        `INSERT INTO users (email, password_hash, first_name, last_name, phone, role)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, email, first_name, last_name, phone, role, is_active, created_at`,
        [
          data.email.toLowerCase(),
          passwordHash,
          data.firstName,
          data.lastName,
          data.phone || null,
          data.role || 'customer'
        ]
      );

      const user = result.rows[0];

      // Get enterprise_id and enterprise role if user belongs to one
      const enterpriseResult = await client.query(
        `SELECT enterprise_id, role AS enterprise_role
         FROM enterprise_users
         WHERE user_id = $1 AND is_active = true
         LIMIT 1`,
        [user.id]
      );
      const enterpriseId = enterpriseResult.rows[0]?.enterprise_id;
      const enterpriseRole = enterpriseResult.rows[0]?.enterprise_role;

      // Generate tokens
      const tokens = await this.generateTokens(client, {
        userId: user.id,
        email: user.email,
        role: user.role,
        enterpriseId,
        enterpriseRole
      });

      await client.query('COMMIT');

      if (enterpriseRole) {
        user.enterprise_role = enterpriseRole;
      }

      return { user, tokens };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async login(data: LoginInput): Promise<{ user: any; tokens: AuthTokens }> {
    // Find user by email
    const result = await this.pool.query(
      `SELECT id, email, password_hash, first_name, last_name, phone, role, is_active, enterprise_id
       FROM users WHERE email = $1`,
      [data.email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      throw new AuthError('Invalid email or password', 401);
    }

    const user = result.rows[0];

    if (!user.is_active) {
      throw new AuthError('Account is deactivated', 403);
    }

    // Verify password
    const isValid = await bcrypt.compare(data.password, user.password_hash);
    if (!isValid) {
      throw new AuthError('Invalid email or password', 401);
    }

    // Get enterprise_id and enterpriseRole from enterprise_users
    let enterpriseId = user.enterprise_id;
    let enterpriseRole: string | undefined;
    const euResult = await this.pool.query(
      `SELECT enterprise_id, role AS enterprise_role
       FROM enterprise_users
       WHERE user_id = $1 AND is_active = true
       LIMIT 1`,
      [user.id]
    );
    if (euResult.rows[0]) {
      if (!enterpriseId) {
        enterpriseId = euResult.rows[0].enterprise_id;
      }
      enterpriseRole = euResult.rows[0].enterprise_role;
    }

    // Generate tokens
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tokens = await this.generateTokens(client, {
        userId: user.id,
        email: user.email,
        role: user.role,
        enterpriseId,
        enterpriseRole
      });
      await client.query('COMMIT');

      // Remove sensitive fields
      const { password_hash, ...safeUser } = user;
      if (enterpriseRole) {
        (safeUser as any).enterprise_role = enterpriseRole;
      }

      return { user: safeUser, tokens };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async refreshTokens(refreshToken: string): Promise<AuthTokens> {
    const tokenHash = this.hashToken(refreshToken);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Find valid refresh token
      const result = await client.query(
        `SELECT rt.id, rt.user_id, u.email, u.role, u.enterprise_id, u.is_active
         FROM refresh_tokens rt
         INNER JOIN users u ON rt.user_id = u.id
         WHERE rt.token_hash = $1 AND rt.expires_at > NOW() AND rt.revoked_at IS NULL`,
        [tokenHash]
      );

      if (result.rows.length === 0) {
        throw new AuthError('Invalid or expired refresh token', 401);
      }

      const row = result.rows[0];

      if (!row.is_active) {
        throw new AuthError('Account is deactivated', 403);
      }

      // Revoke the old refresh token
      await client.query(
        'UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1',
        [row.id]
      );

      // Get enterprise_id and enterpriseRole
      let enterpriseId = row.enterprise_id;
      let enterpriseRole: string | undefined;
      const euResult = await client.query(
        `SELECT enterprise_id, role AS enterprise_role
         FROM enterprise_users
         WHERE user_id = $1 AND is_active = true
         LIMIT 1`,
        [row.user_id]
      );
      if (euResult.rows[0]) {
        if (!enterpriseId) {
          enterpriseId = euResult.rows[0].enterprise_id;
        }
        enterpriseRole = euResult.rows[0].enterprise_role;
      }

      // Generate new token pair
      const tokens = await this.generateTokens(client, {
        userId: row.user_id,
        email: row.email,
        role: row.role,
        enterpriseId,
        enterpriseRole
      });

      await client.query('COMMIT');
      return tokens;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = this.hashToken(refreshToken);
    await this.pool.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL',
      [tokenHash]
    );
  }

  async logoutAll(userId: string): Promise<void> {
    await this.pool.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId]
    );
  }

  verifyAccessToken(token: string): JwtPayload {
    try {
      const decoded = jwt.verify(token, config.jwt.secret) as JwtPayload;
      return decoded;
    } catch (error) {
      throw new AuthError('Invalid or expired token', 401);
    }
  }

  private async generateTokens(client: PoolClient, payload: JwtPayload): Promise<AuthTokens> {
    // Access token (short-lived)
    const accessToken = jwt.sign(
      { ...payload },
      config.jwt.secret,
      { expiresIn: config.jwt.accessExpiresIn } as jwt.SignOptions
    );

    // Refresh token (long-lived, opaque)
    const refreshToken = crypto.randomBytes(64).toString('hex');
    const tokenHash = this.hashToken(refreshToken);

    // Store refresh token hash in DB
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30); // 30 days

    await client.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [payload.userId, tokenHash, expiresAt]
    );

    return { accessToken, refreshToken };
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ── Вход кассира по PIN с привязанного планшета ─────────────────────────
  // Логина и пароля на кассе нет: планшет предъявляет токен устройства,
  // кассир — PIN. PIN уникален в пределах организации, поэтому по нему
  // однозначно находится кассир. Ошибки PIN считаются по устройству.

  static readonly PIN_MAX_FAILS = 5;
  static readonly PIN_LOCK_MS = 5 * 60 * 1000;

  async pinLogin(deviceToken: string, pin: string): Promise<{
    user: any; tokens: AuthTokens; registerSessionId: string; register: any;
  }> {
    const dev = await this.pool.query(
      `SELECT d.id, d.enterprise_id, d.register_id, d.locked_until > NOW() AS locked,
              CEIL(EXTRACT(EPOCH FROM (d.locked_until - NOW())) / 60) AS lock_min,
              r.name AS register_name, r.restaurant_id, r.status AS register_status
         FROM cash_register_devices d
         JOIN cash_registers r ON r.id = d.register_id AND r.enterprise_id = d.enterprise_id
        WHERE d.token_hash = $1 AND d.revoked_at IS NULL`,
      [this.hashToken(deviceToken)]
    );
    const device = dev.rows[0];
    if (!device) throw new AuthError('Планшет не привязан к кассе или отвязан', 401, 'DEVICE_UNKNOWN');
    if (device.locked) {
      throw new AuthError(`Слишком много неверных PIN — подождите ${device.lock_min} мин`, 429, 'PIN_LOCKED');
    }

    const cands = await this.pool.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.phone, u.role, u.pin_hash
         FROM enterprise_users eu
         JOIN users u ON u.id = eu.user_id
        WHERE eu.enterprise_id = $1 AND eu.role = 'cashier' AND eu.is_active = true
          AND u.is_active = true AND u.pin_hash IS NOT NULL`,
      [device.enterprise_id]
    );
    let user: any = null;
    for (const c of cands.rows) {
      if (await bcrypt.compare(pin, c.pin_hash)) { user = c; break; }
    }

    if (!user) {
      await this.pool.query(
        `UPDATE cash_register_devices
            SET failed_attempts = failed_attempts + 1,
                locked_until = CASE WHEN failed_attempts + 1 >= $2
                                    THEN NOW() + ($3 || ' milliseconds')::interval END
          WHERE id = $1`,
        [device.id, AuthService.PIN_MAX_FAILS, String(AuthService.PIN_LOCK_MS)]
      );
      throw new AuthError('Неверный PIN', 401, 'INVALID_PIN');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Серия ошибок обнуляется только успешным входом
      await client.query(
        `UPDATE cash_register_devices
            SET failed_attempts = 0, locked_until = NULL, last_used_at = NOW()
          WHERE id = $1`,
        [device.id]
      );
      const tokens = await this.generateTokens(client, {
        userId: user.id,
        email: user.email,
        role: user.role,
        enterpriseId: device.enterprise_id,
        enterpriseRole: 'cashier',
      });
      await client.query('COMMIT');
      const registerSessionId = await this.createCashRegisterSession(user.id, device.register_id);
      const { pin_hash, ...safeUser } = user;
      return {
        user: { ...safeUser, enterprise_id: device.enterprise_id, enterprise_role: 'cashier' },
        tokens,
        registerSessionId,
        register: {
          id: device.register_id,
          name: device.register_name,
          restaurant_id: device.restaurant_id,
          status: device.register_status,
        },
      };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  // ── Сессии режима кассы ──────────────────────────────────────────────
  // Одна сессия = вход кассира в режим кассы после ввода PIN.
  // 'active' — продажи разрешены, 'locked' — ждёт PIN. Срок — рабочая смена:
  // прежние 8 минут без продления обрывали продажи посреди смены.

  static readonly CASH_SESSION_TTL_MS = 14 * 60 * 60 * 1000;

  async registerBelongsToEnterprise(registerId: string, enterpriseId: string): Promise<boolean> {
    const r = await this.pool.query(
      'SELECT 1 FROM cash_registers WHERE id = $1 AND enterprise_id = $2',
      [registerId, enterpriseId]
    );
    return r.rows.length > 0;
  }

  async createCashRegisterSession(userId: string, registerId: string): Promise<string> {
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + AuthService.CASH_SESSION_TTL_MS);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Старые сессии кассира на этой кассе гасим, чтобы «последняя» была однозначной
      await client.query(
        `UPDATE cash_register_sessions SET status = 'locked', locked_at = NOW(), expires_at = NOW()
          WHERE user_id = $1 AND register_id = $2 AND expires_at > NOW()`,
        [userId, registerId]
      );
      await client.query(
        `INSERT INTO cash_register_sessions (id, user_id, register_id, status, expires_at)
         VALUES ($1, $2, $3, 'active', $4)`,
        [sessionId, userId, registerId, expiresAt]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    return sessionId;
  }

  /** Последняя сессия кассира на кассе (без ORDER BY бралась случайная из нескольких). */
  async getCashRegisterSessionByRegister(registerId: string, userId: string): Promise<any> {
    const result = await this.pool.query(
      `SELECT id, user_id, register_id, status, locked_at, expires_at, created_at
         FROM cash_register_sessions
        WHERE register_id = $1 AND user_id = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [registerId, userId]
    );
    return result.rows[0] || null;
  }

  async setCashRegisterSessionStatus(sessionId: string, status: 'active' | 'locked'): Promise<void> {
    if (status === 'locked') {
      await this.pool.query(
        `UPDATE cash_register_sessions SET status = 'locked', locked_at = NOW() WHERE id = $1`,
        [sessionId]
      );
    } else {
      // Разблокировка продлевает сессию на смену вперёд
      await this.pool.query(
        `UPDATE cash_register_sessions
            SET status = 'active', locked_at = NULL, expires_at = $1
          WHERE id = $2`,
        [new Date(Date.now() + AuthService.CASH_SESSION_TTL_MS), sessionId]
      );
    }
  }
}

export class AuthError extends Error {
  statusCode: number;
  /** Машинный код для клиента (касса отличает «планшет отвязан» от «неверный PIN») */
  code?: string;

  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.name = 'AuthError';
  }
}

export default AuthService;
