/** Простая in-memory сессия на чат (таймауты не требуются) */

export interface ReturnItemDraft {
  orderItemId: string;
  name: string;
  unit: string | null;
  quantity: number;
  disposition: 'restock' | 'write_off';
  reason?: string;
}

export interface AvailableReturnItem {
  id: string;
  name: string;
  unit: string | null;
  /** максимум к возврату: shipped (или ordered) минус уже возвращённое */
  max: number;
}

export interface CurrentReturnItem {
  orderItemId: string;
  name: string;
  unit: string | null;
  max: number;
  quantity?: number;
  disposition?: 'restock' | 'write_off';
}

export type SessionState =
  | {
      type: 'pay_amount';
      orderId: string;
      invoiceNumber: string | null;
      remaining: number;
    }
  | {
      type: 'return';
      orderId: string;
      invoiceNumber: string | null;
      stage: 'pick_item' | 'quantity' | 'disposition' | 'reason' | 'more';
      availableItems: AvailableReturnItem[];
      items: ReturnItemDraft[];
      current?: CurrentReturnItem;
    };

export const sessions = new Map<number, SessionState>();
