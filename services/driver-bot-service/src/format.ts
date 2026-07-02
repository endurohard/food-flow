import { WholesaleOrder } from './wholesale-api';

export function num(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : 0;
}

/** 12345.5 → «12 345,50 ₽» (без toLocaleString — в alpine может не быть ru-ICU) */
export function fmtMoney(v: string | number): string {
  const rounded = Math.round(num(v) * 100) / 100;
  const [int, frac] = Math.abs(rounded).toFixed(2).split('.');
  const withSep = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const sign = rounded < 0 ? '-' : '';
  return frac === '00' ? `${sign}${withSep} ₽` : `${sign}${withSep},${frac} ₽`;
}

/** Количество без хвостовых нулей: 10.000 → «10», 2.500 → «2,5» */
export function fmtQty(v: string | number): string {
  return String(parseFloat(num(v).toFixed(3))).replace('.', ',');
}

/** ISO-дата → «дд.мм.гггг» */
export function fmtDate(v: string | null): string {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

export function orderTitle(order: { invoice_number: string | null; id: string }): string {
  return order.invoice_number || `#${order.id.slice(0, 8)}`;
}

/** Карточка заказа для водителя */
export function orderCard(order: WholesaleOrder): string {
  const lines: string[] = [];
  lines.push(`📦 Накладная ${orderTitle(order)}`);
  lines.push(
    `🏢 ${order.counterparty_name}${order.counterparty_phone ? ` (${order.counterparty_phone})` : ''}`
  );
  if (order.delivery_address) lines.push(`📍 ${order.delivery_address}`);
  if (order.delivery_date) lines.push(`📅 Доставка: ${fmtDate(order.delivery_date)}`);

  if (order.items && order.items.length > 0) {
    lines.push('');
    lines.push('Состав:');
    for (const it of order.items) {
      const qty = it.shipped_quantity !== null && it.shipped_quantity !== undefined
        ? it.shipped_quantity
        : it.quantity;
      lines.push(`— ${it.name} × ${fmtQty(qty)} ${it.unit || 'шт'}`);
    }
    lines.push('');
  }

  const total = num(order.total_amount);
  const paid = num(order.paid_amount);
  const debt = Math.round((total - paid) * 100) / 100;
  lines.push(`💵 Сумма: ${fmtMoney(total)}`);
  if (debt > 0) {
    lines.push(`✅ Оплачено: ${fmtMoney(paid)} | ❗️ Долг: ${fmtMoney(debt)}`);
  } else {
    lines.push('✅ Оплачен полностью');
  }
  return lines.join('\n');
}
