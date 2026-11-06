import pkg from 'pg';
const { Pool } = pkg;
import { config } from '../config';
import { StockAlertService, httpNotifier } from './stock-alert.service';

/** Один экземпляр на процесс: им пользуются роуты и периодическая проверка. */
export const stockAlerts = new StockAlertService(
  new Pool({ connectionString: config.database.url, max: 3 }),
  httpNotifier(config.userServiceUrl, config.internalToken)
);

/** Фоновая проверка после списания: ошибка не должна ломать само списание. */
export function checkStockLater(warehouseId: string, itemIds: string[]): void {
  if (!itemIds.length) return;
  stockAlerts.sweep({ warehouseId, itemIds }).catch((e) =>
    console.error('stock alerts sweep failed:', e.message || e));
}
