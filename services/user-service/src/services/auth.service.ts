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

      // Get enterprise_id if user belongs to one
      const enterpriseResult = await client.query(
        `SELECT enterprise_id FROM enterprise_users WHERE user_id = $1 AND is_active = true LIMIT 1`,
        [user.id]
      );
      const enterpriseId = enterpriseResult.rows[0]?.enterprise_id;

      // Generate tokens
      const tokens = await this.generateTokens(client, {
        userId: user.id,
        email: user.email,
        role: user.role,
        enterpriseId
      });

      await client.query('COMMIT');

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

    // Get enterprise_id from enterprise_users if not on user directly
    let enterpriseId = user.enterprise_id;
    if (!enterpriseId) {
      const euResult = await this.pool.query(
        `SELECT enterprise_id FROM enterprise_users WHERE user_id = $1 AND is_active = true LIMIT 1`,
        [user.id]
      );
      enterpriseId = euResult.rows[0]?.enterprise_id;
    }

    // Generate tokens
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tokens = await this.generateTokens(client, {
        userId: user.id,
        email: user.email,
        role: user.role,
        enterpriseId
      });
      await client.query('COMMIT');

      // Remove sensitive fields
      const { password_hash, ...safeUser } = user;

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

      // Get enterprise_id
      let enterpriseId = row.enterprise_id;
      if (!enterpriseId) {
        const euResult = await client.query(
          `SELECT enterprise_id FROM enterprise_users WHERE user_id = $1 AND is_active = true LIMIT 1`,
          [row.user_id]
        );
        enterpriseId = euResult.rows[0]?.enterprise_id;
      }

      // Generate new token pair
      const tokens = await this.generateTokens(client, {
        userId: row.user_id,
        email: row.email,
        role: row.role,
        enterpriseId
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
}

export class AuthError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'AuthError';
  }
}

export default AuthService;
