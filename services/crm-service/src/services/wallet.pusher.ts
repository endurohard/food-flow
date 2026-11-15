/**
 * Рассылка push в Apple Wallet: раз в интервал берёт карты, у которых
 * wallet_updated_at новее wallet_pushed_at (триггер БД ставит метку при
 * любом изменении баллов/уровня), и будит их телефоны пустым push.
 * Опрос, а не вызов из каждого места начисления: баллы меняют API,
 * событие заказа и ручные правки — триггер видит все, код — нет.
 */
import { CRMService } from './crm.service';
import { WalletConfig, PushResult, apnsSender } from './wallet.service';
import { logger } from '../utils/logger';

export type Sender = (pushToken: string) => Promise<PushResult>;

/** Один проход. Возвращает, сколько карт отмечено разосланными. */
export async function walletPushTick(crm: CRMService, passTypeId: string, send: Sender): Promise<number> {
  const pending = await crm.walletPending(passTypeId);
  let done = 0;
  for (const p of pending) {
    let failed = false;
    for (const token of p.tokens) {
      const r = await send(token);
      if (r === 'gone') await crm.walletDropToken(token);
      else if (r === 'error') failed = true;
    }
    // Сбой APNs (сеть, настройка) — не отмечаем: следующий проход повторит
    if (!failed) { await crm.walletMarkPushed(p.profileId, p.updatedAt); done++; }
  }
  return done;
}

export function startWalletPusher(crm: CRMService, cfg: WalletConfig, intervalMs = 30000, send: Sender = apnsSender(cfg)): () => void {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;   // долгий проход не накладывается на следующий
    busy = true;
    try {
      const n = await walletPushTick(crm, cfg.passTypeId, send);
      if (n) logger.info(`Apple Wallet: обновлено карт ${n}`);
    } catch (e) {
      logger.error('Apple Wallet push error:', e);
    } finally { busy = false; }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
