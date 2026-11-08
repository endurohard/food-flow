/**
 * Кому какие заказы отдаёт GET /api/orders.
 *
 * Раньше роут всегда подставлял customerId = req.userId, если в запросе его
 * не было. Для клиента приложения это правильно (видит только свои заказы),
 * но у владельца, админа и кассира список сужался до заказов, где клиентом
 * числится он сам, — то есть до пустого. «Заказы» и «Панель» в админке
 * показывали ноль при живых продажах.
 *
 * Сотрудник — тот, у кого в токене есть роль в предприятии (enterpriseRole)
 * или глобальная роль не 'customer'. Кассир хранится в users с role
 * 'customer', поэтому смотреть только на role нельзя.
 */
export interface ListScopeInput {
  userId?: string;
  userRole?: string;
  enterpriseRole?: string;
  enterpriseId?: string;
  queryCustomerId?: string;
}

export type ListScope =
  | { ok: true; enterpriseId?: string; customerId?: string }
  | { ok: false; status: 403; message: string };

export function resolveOrderListScope(i: ListScopeInput): ListScope {
  const isSuper = i.userRole === 'super_admin';
  const isCustomer = !isSuper && !i.enterpriseRole && (!i.userRole || i.userRole === 'customer');

  // Клиент видит только свои заказы — чужой customerId из запроса игнорируем
  if (isCustomer) {
    if (!i.userId) return { ok: false, status: 403, message: 'Нет пользователя в сессии' };
    return { ok: true, enterpriseId: i.enterpriseId, customerId: i.userId };
  }

  // Сотрудник без предприятия получил бы заказы всех организаций сразу
  if (!isSuper && !i.enterpriseId) {
    return { ok: false, status: 403, message: 'Требуется контекст предприятия' };
  }

  return {
    ok: true,
    // super_admin без предприятия в токене видит все организации
    enterpriseId: i.enterpriseId,
    customerId: i.queryCustomerId || undefined,
  };
}
