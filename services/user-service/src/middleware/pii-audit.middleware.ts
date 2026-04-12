import { Request, Response, NextFunction } from 'express';
import pkg from 'pg';
const { Pool } = pkg;
import { config } from '../config';

const auditPool = new Pool({ connectionString: config.database.url, max: 2 });

const PII_FIELDS = ['email', 'phone', 'first_name', 'last_name', 'pbx_extension', 'pbx_username', 'pbx_password', 'pbx_ws_password'];

export const logPiiAccess = (entity: string, fieldsAccessed: string[]) => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const userId = (req as any).userId;
    if (!userId) { next(); return; }

    auditPool.query(
      `INSERT INTO pii_access_log (user_id, enterprise_id, accessed_entity, accessed_id, fields_accessed, action, ip_address, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        userId,
        (req as any).enterpriseId || null,
        entity,
        req.params.userId || req.params.id || null,
        fieldsAccessed,
        req.method === 'GET' ? 'read' : 'write',
        req.ip,
        req.headers['x-request-id'] || null
      ]
    ).catch(() => {});

    next();
  };
};

export { PII_FIELDS };
