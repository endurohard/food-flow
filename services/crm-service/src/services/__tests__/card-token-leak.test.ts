/**
 * Секрет ссылки на карту не уходит ни в один ответ с профилем клиента:
 * список, карточка, создание, изменение возвращают строку целиком (cp.* /
 * RETURNING *), и без фильтра card_token каждого клиента видел бы менеджер.
 */
import { CRMService } from '../crm.service';

const SECRET = 'c'.repeat(64);
const ROW = { id: 'p1', user_id: 'u1', enterprise_id: 'e1', card_number: '10000001', card_token: SECRET, first_name: 'Анна' };
function svc() {
  const s = new CRMService('postgres://unused');
  (s as any).pool = { query: async () => ({ rows: [{ ...ROW }], rowCount: 1 }) };
  return s;
}

it.each([
  ['список клиентов', (s: CRMService) => s.listCustomers({ enterpriseId: 'e1' })],
  ['карточка клиента', (s: CRMService) => s.getCustomerProfile('u1', 'e1')],
  ['создание профиля', (s: CRMService) => s.createProfile({ userId: 'u1', enterpriseId: 'e1' })],
  ['изменение профиля', (s: CRMService) => s.updateProfile('u1', { notes: 'x' }, 'e1')]
])('%s — без card_token, номер карты на месте', async (_name, run) => {
  const out = await run(svc());
  const json = JSON.stringify(out);
  expect(json).not.toContain(SECRET);
  expect(json).not.toContain('card_token');
  expect(json).toContain('10000001');
});
