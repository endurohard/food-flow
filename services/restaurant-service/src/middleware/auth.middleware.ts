import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userRole?: string;
      enterpriseId?: string;
      enterpriseRole?: string;
    }
  }
}

/**
 * Canonical role names used across the platform.
 * Global roles (userRole from JWT): customer | restaurant_owner | delivery_driver | admin
 * Enterprise roles (enterpriseRole from enterprise_users): owner | admin | manager | operator | chef | waiter | employee | viewer
 */
export const ROLES = {
  ADMIN: 'admin',
  OWNER: 'owner',
  MANAGER: 'manager',
  OPERATOR: 'operator',
  CHEF: 'chef',
  WAITER: 'waiter',
  EMPLOYEE: 'employee',
  VIEWER: 'viewer'
} as const;

export const authenticateUser = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<any> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing or invalid authorization header'
      });
    }

    const token = authHeader.substring(7);

    const decoded = jwt.verify(token, config.jwt.secret) as {
      userId: string;
      email: string;
      role: string;
      enterpriseId?: string;
      enterpriseRole?: string;
    };

    req.userId = decoded.userId;
    req.userRole = decoded.role;
    if (decoded.enterpriseId) {
      req.enterpriseId = decoded.enterpriseId;
    }
    if (decoded.enterpriseRole) {
      req.enterpriseRole = decoded.enterpriseRole;
    }

    next();
  } catch (error) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired token'
    });
  }
};

/**
 * Optional auth - sets userId if token present, but doesn't require it
 */
export const optionalAuth = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const decoded = jwt.verify(token, config.jwt.secret) as any;
      req.userId = decoded.userId;
      req.userRole = decoded.role;
      req.enterpriseId = decoded.enterpriseId;
      req.enterpriseRole = decoded.enterpriseRole;
    }
  } catch {
    // Token invalid, continue without auth
  }
  next();
};

/**
 * Role gate. Allows request through if ANY of these holds:
 *  - global admin (userRole === 'admin')
 *  - restaurant owner (userRole === 'restaurant_owner')
 *  - enterpriseRole matches one of allowedRoles
 *  - userRole matches one of allowedRoles (legacy compatibility)
 * Otherwise responds 403.
 */
export const requireRole = (...allowedRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction): any => {
    const userRole = req.userRole;
    const enterpriseRole = req.enterpriseRole;

    if (userRole === 'admin') return next();
    if (userRole === 'restaurant_owner') return next();
    if (enterpriseRole && allowedRoles.includes(enterpriseRole)) return next();
    if (userRole && allowedRoles.includes(userRole)) return next();

    return res.status(403).json({
      error: 'Forbidden',
      message: 'Insufficient role',
      required: allowedRoles
    });
  };
};
