import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export const REQUEST_ID_HEADER = 'x-request-id';

export const requestIdMiddleware = (req: Request, _res: Response, next: NextFunction): void => {
  if (!req.headers[REQUEST_ID_HEADER]) {
    req.headers[REQUEST_ID_HEADER] = crypto.randomUUID();
  }
  next();
};

export const getRequestId = (req: Request): string =>
  (req.headers[REQUEST_ID_HEADER] as string) || 'unknown';
