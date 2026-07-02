import { Telegraf } from 'telegraf';
import { config } from './config';
import { getUnnotifiedOrders, markOrderNotified } from './db';
import { fmtDate, fmtMoney, num } from './format';
import { orderButtons } from './bot';
import { logger } from './utils/logger';

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(bot: Telegraf): Promise<void> {
  if (running) return; // защита от наложения тиков
  running = true;
  try {
    const orders = await getUnnotifiedOrders();
    for (const o of orders) {
      try {
        const title = o.invoice_number || `#${o.id.slice(0, 8)}`;
        const debt = Math.round((num(o.total_amount) - num(o.paid_amount)) * 100) / 100;
        const lines = [
          `🚚 Вам назначена доставка ${title}`,
          `🏢 ${o.counterparty_name}${o.counterparty_phone ? ` (${o.counterparty_phone})` : ''}`
        ];
        if (o.delivery_address) lines.push(`📍 ${o.delivery_address}`);
        if (o.delivery_date) lines.push(`📅 ${fmtDate(o.delivery_date)}`);
        lines.push(`💵 Сумма: ${fmtMoney(o.total_amount)}`);
        if (debt > 0 && debt < num(o.total_amount)) {
          lines.push(`❗️ Долг: ${fmtMoney(debt)}`);
        }

        await bot.telegram.sendMessage(
          Number(o.telegram_chat_id),
          lines.join('\n'),
          orderButtons(o.id)
        );
        await markOrderNotified(o.id);
        logger.info(`Notified driver (chat ${o.telegram_chat_id}) about order ${title}`);
      } catch (e) {
        logger.error(`Failed to notify about order ${o.id}`, e);
      }
    }
  } catch (e) {
    logger.error('Notification poller tick failed', e);
  } finally {
    running = false;
  }
}

export function startPoller(bot: Telegraf): void {
  logger.info(`Starting delivery notification poller (interval ${config.pollIntervalMs} ms)`);
  timer = setInterval(() => void tick(bot), config.pollIntervalMs);
  void tick(bot);
}

export function stopPoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
