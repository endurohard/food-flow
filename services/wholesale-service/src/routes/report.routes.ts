import { Router, Request, Response } from 'express';
import pkg from 'pg';
const { Pool } = pkg;
import { authenticateUser, requireRole, ROLES } from '../middleware/auth.middleware';
import { WholesaleReportService } from '../services/report.service';
import { logger } from '../utils/logger';

export function reportRoutes(pool: InstanceType<typeof Pool>): Router {
  const router = Router();
  const service = new WholesaleReportService(pool);

  const REPORT_ROLES = [ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER];

  const handler = (fn: (filters: any) => Promise<any>, key?: string) =>
    async (req: Request, res: Response) => {
      try {
        const isSuper = req.userRole === 'super_admin';
        if (!isSuper && !req.enterpriseId) {
          return res.status(403).json({ error: 'Forbidden', message: 'Требуется контекст предприятия' });
        }
        const result = await fn({
          enterpriseId: isSuper ? undefined : req.enterpriseId,
          from: req.query.from as string | undefined,
          to: req.query.to as string | undefined
        });
        res.json(key ? { [key]: result } : result);
      } catch (err) {
        logger.error('wholesale report failed', err);
        res.status(500).json({ error: 'Internal Server Error' });
      }
    };

  router.get('/reports/drivers', authenticateUser, requireRole(...REPORT_ROLES), handler((f) => service.driversReport(f), 'drivers'));
  router.get('/reports/managers', authenticateUser, requireRole(...REPORT_ROLES), handler((f) => service.managersReport(f), 'managers'));
  router.get('/reports/summary', authenticateUser, requireRole(...REPORT_ROLES), handler((f) => service.summaryReport(f)));

  return router;
}

export default reportRoutes;
