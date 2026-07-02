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

export const authenticateUser = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    // Межсервисные вызовы (driver-bot и др.): X-Internal-Token + X-User-Id
    const internalToken = req.headers['x-internal-token'] as string | undefined;
    if (internalToken && config.internalToken && internalToken === config.internalToken) {
      req.userId = (req.headers['x-user-id'] as string) || undefined;
      req.enterpriseId = (req.headers['x-enterprise-id'] as string) || undefined;
      req.userRole = 'admin'; // внутренний вызов проходит ролевые проверки
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const decoded = jwt.verify(authHeader.substring(7), config.jwt.secret) as any;
    req.userId = decoded.userId;
    req.userRole = decoded.role;
    req.enterpriseId = decoded.enterpriseId;
    req.enterpriseRole = decoded.enterpriseRole;
    next();
  } catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
};

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
