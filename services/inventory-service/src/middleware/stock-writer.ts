import { Request, Response, NextFunction } from 'express';
import { stockAlerts } from '../services/stock-alerts.instance';

/** Роли, которым можно заводить поставщиков, накладные и заказы, принимать товар. */
export const STOCK_WRITE_ROLES = ['admin', 'owner', 'manager', 'operator'];

/**
 * Запись в закупки: поставщики, накладные и их позиции, приёмка, заказы
 * поставщикам. Раньше эти маршруты проверяли только вход — провести приход
 * на склад и долг поставщику мог любой сотрудник, в том числе кассир.
 *
 * Пускает руководящие роли и назначенного ответственного за закуп
 * (enterprise_users.is_purchaser) с любой ролью: закупщик и есть тот, кто
 * заказывает и принимает товар.
 */
export async function requireStockWriter(req: Request, res: Response, next: NextFunction): Promise<any> {
  if (req.isInternal) return next();
  const role = req.userRole || '';
  if (['admin', 'restaurant_owner', 'super_admin'].includes(role)) return next();
  if (STOCK_WRITE_ROLES.includes(req.enterpriseRole || '') || STOCK_WRITE_ROLES.includes(role)) return next();
  try {
    if (req.enterpriseId && req.userId && await stockAlerts.isPurchaser(req.enterpriseId, req.userId)) return next();
  } catch (e) {
    console.error('purchaser check failed:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
  return res.status(403).json({
    // Экраны показывают поле error — в нём текст для человека, а не «Forbidden»
    error: 'Закупки ведут владелец, администратор, менеджер, оператор склада или ответственный за закуп',
    message: 'Закупки ведут владелец, администратор, менеджер, оператор склада или ответственный за закуп'
  });
}

/** Деньги поставщику — только руководство: закупщик принимает товар, но не платит. */
export function requireSupplierPayer(req: Request, res: Response, next: NextFunction): any {
  if (req.isInternal) return next();
  const role = req.userRole || '';
  if (['admin', 'restaurant_owner', 'super_admin'].includes(role)) return next();
  if (['owner', 'admin', 'manager'].includes(req.enterpriseRole || '')) return next();
  return res.status(403).json({
    // Экраны показывают поле error — в нём текст для человека, а не «Forbidden»
    error: 'Оплату поставщику проводит владелец, администратор или менеджер',
    message: 'Оплату поставщику проводит владелец, администратор или менеджер'
  });
}
