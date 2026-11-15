/**
 * Настройки Apple Wallet на время работы сервиса: читаются один раз при
 * старте (файлы сертификатов на томе). Тесты подставляют свои через
 * setWalletConfig.
 */
import { WalletConfig, loadWalletConfig } from './wallet.service';

let cached: WalletConfig | null | undefined;

export function getWalletConfig(): WalletConfig | null {
  if (cached === undefined) cached = loadWalletConfig();
  return cached;
}

export function setWalletConfig(cfg: WalletConfig | null | undefined): void {
  cached = cfg;
}
