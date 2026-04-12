import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
declare global { namespace Express { interface Request { userId?: string; userRole?: string; enterpriseId?: string; } } }
export const authenticateUser = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const decoded = jwt.verify(authHeader.substring(7), config.jwt.secret) as any;
    req.userId = decoded.userId; req.userRole = decoded.role; req.enterpriseId = decoded.enterpriseId;
    next();
  } catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
};
