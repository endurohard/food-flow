import { config } from './config';
import { logger } from './utils/logger';

/** Ошибка бизнес-уровня от wholesale-service ({error} / {message} c HTTP 4xx) */
export class WholesaleApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'WholesaleApiError';
  }
}

export interface AuthCtx {
  userId: string;
  enterpriseId?: string | null;
}

export interface WholesaleOrderItem {
  id: string;
  name: string;
  quantity: string;
  shipped_quantity: string | null;
  returned_quantity: string;
  unit: string | null;
  price: string;
  total: string;
}

export interface WholesaleOrder {
  id: string;
  invoice_number: string | null;
  counterparty_name: string;
  counterparty_phone: string | null;
  delivery_address: string | null;
  delivery_date: string | null;
  total_amount: string;
  paid_amount: string;
  payment_status: string;
  status: string;
  items?: WholesaleOrderItem[];
  payments?: unknown[];
}

export interface WholesaleReturn {
  id: string;
  return_number: string | null;
  status: string;
  total_amount: string;
}

async function request<T>(
  method: string,
  path: string,
  auth: AuthCtx,
  body?: unknown
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Internal-Token': config.internalToken,
    'X-User-Id': auth.userId
  };
  if (auth.enterpriseId) headers['X-Enterprise-Id'] = auth.enterpriseId;

  let res: Response;
  try {
    res = await fetch(`${config.wholesaleServiceUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    logger.error(`wholesale-service unreachable: ${method} ${path}`, e);
    throw new WholesaleApiError('Сервис временно недоступен, попробуйте позже', 0);
  }

  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON body */
  }

  if (!res.ok) {
    const msg =
      (typeof data.message === 'string' && data.message) ||
      (typeof data.error === 'string' && data.error) ||
      `HTTP ${res.status}`;
    throw new WholesaleApiError(msg, res.status);
  }
  return data as T;
}

/** Заказы водителя со статусом shipped */
export async function listShippedOrders(auth: AuthCtx): Promise<WholesaleOrder[]> {
  const data = await request<{ orders: WholesaleOrder[] }>(
    'GET',
    `/api/wholesale/orders?driverId=${encodeURIComponent(auth.userId)}&status=shipped`,
    auth
  );
  return data.orders || [];
}

/** Заказ с составом (items[]) и платежами */
export async function getOrder(auth: AuthCtx, orderId: string): Promise<WholesaleOrder> {
  const data = await request<{ order: WholesaleOrder }>(
    'GET',
    `/api/wholesale/orders/${orderId}`,
    auth
  );
  return data.order;
}

export async function deliverOrder(auth: AuthCtx, orderId: string): Promise<WholesaleOrder> {
  const data = await request<{ order: WholesaleOrder }>(
    'POST',
    `/api/wholesale/orders/${orderId}/deliver`,
    auth,
    {}
  );
  return data.order;
}

export async function payOrder(
  auth: AuthCtx,
  orderId: string,
  amount: number,
  notes?: string
): Promise<{ order?: WholesaleOrder }> {
  return request(
    'POST',
    `/api/wholesale/orders/${orderId}/pay`,
    auth,
    { amount, method: 'cash', notes: notes || 'Принято водителем (Telegram-бот)' }
  );
}

export interface ReturnItemPayload {
  orderItemId: string;
  quantity: number;
  disposition: 'restock' | 'write_off';
  reason?: string;
}

export async function createReturn(
  auth: AuthCtx,
  orderId: string,
  items: ReturnItemPayload[],
  reason?: string
): Promise<WholesaleReturn> {
  const data = await request<{ return: WholesaleReturn }>(
    'POST',
    `/api/wholesale/orders/${orderId}/returns`,
    auth,
    { reason, items }
  );
  return data.return;
}

export async function confirmReturn(auth: AuthCtx, returnId: string): Promise<WholesaleReturn> {
  const data = await request<{ return: WholesaleReturn }>(
    'POST',
    `/api/wholesale/returns/${returnId}/confirm`,
    auth,
    {}
  );
  return data.return;
}
