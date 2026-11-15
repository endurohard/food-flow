/**
 * SQL регистраций Apple Wallet и выборки для рассылки: условия в самих
 * запросах (мок БД отдаёт заготовку, поэтому проверяем текст запроса).
 */
import { CRMService } from '../crm.service';

function svc(rows: any[] = []) {
  const calls: { sql: string; params: any[] }[] = [];
  const s = new CRMService('postgres://unused');
  (s as any).pool = { query: async (sql: string, params: any[] = []) => { calls.push({ sql, params }); return { rows, rowCount: rows.length }; } };
  return { s, calls };
}

it('регистрация — upsert по (телефон, тип, номер): повтор обновляет токен, а не плодит строки', async () => {
  const { s, calls } = svc([{ inserted: true }]);
  await expect(s.walletRegister('dev', 'tok', 'pass.x', '10000001', 'p1')).resolves.toBe(true);
  expect(calls[0].sql).toMatch(/ON CONFLICT \(device_library_id, pass_type_id, serial_number\)\s+DO UPDATE SET push_token = EXCLUDED\.push_token/);
  expect(calls[0].params).toEqual(['dev', 'tok', 'pass.x', '10000001', 'p1']);
  await expect(svc([{ inserted: false }]).s.walletRegister('d', 't', 'p', '1', 'p1')).resolves.toBe(false);
});

it('список изменённых: только карты этого телефона и типа, новее метки; lastUpdated — максимум', async () => {
  const { s, calls } = svc([
    { serial_number: '10000001', wallet_updated_at: '2026-11-14T10:00:00Z' },
    { serial_number: '10000002', wallet_updated_at: '2026-11-14T11:00:00Z' }]);
  const r = await s.walletUpdatedSerials('dev', 'pass.x', '2026-11-13T00:00:00Z');
  expect(r).toEqual({ serials: ['10000001', '10000002'], lastUpdated: '2026-11-14T11:00:00.000Z' });
  expect(calls[0].sql).toMatch(/wr\.device_library_id = \$1 AND wr\.pass_type_id = \$2/);
  expect(calls[0].sql).toMatch(/cp\.wallet_updated_at > \$3::timestamptz/);
  expect(calls[0].params[2]).toEqual(new Date('2026-11-13T00:00:00Z'));
  // мусор вместо метки — как «с начала», а не ошибка
  const b = svc([]); await b.s.walletUpdatedSerials('dev', 'pass.x', 'мусор');
  expect(b.calls[0].params[2]).toBeNull();
});

it('к рассылке — изменённые после последнего push, только с телефонами этого типа', async () => {
  const { s, calls } = svc([{ id: 'p1', wallet_updated_at: new Date(), tokens: ['t1'] }]);
  await s.walletPending('pass.x');
  expect(calls[0].sql).toMatch(/JOIN wallet_registrations wr ON wr\.customer_profile_id = cp\.id AND wr\.pass_type_id = \$1/);
  expect(calls[0].sql).toMatch(/WHERE cp\.wallet_pushed_at IS NULL OR cp\.wallet_updated_at > cp\.wallet_pushed_at/);
});

it('отметка рассылки — меткой изменения и только вперёд', async () => {
  const { s, calls } = svc();
  const at = new Date('2026-11-14T10:00:00Z');
  await s.walletMarkPushed('p1', at);
  expect(calls[0].sql).toMatch(/SET wallet_pushed_at = \$2 WHERE id = \$1 AND \(wallet_pushed_at IS NULL OR wallet_pushed_at < \$2\)/);
  expect(calls[0].params).toEqual(['p1', at]);
});

it('карта для Wallet ищется по номеру, для страницы — по секрету ссылки', async () => {
  const a = svc([]); await a.s.loadCard('serial', '10000001');
  expect(a.calls[0].sql).toMatch(/WHERE cp\.card_number = \$1/);
  const b = svc([]); await b.s.loadCard('token', 'x');
  expect(b.calls[0].sql).toMatch(/WHERE cp\.card_token = \$1/);
});
