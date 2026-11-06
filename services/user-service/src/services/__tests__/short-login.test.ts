/** Короткий логин: «coffee104» вместо «coffee104@food-flow.ru». */
const queries: { sql: string; params: any[] }[] = [];
let rows: any[] = [];

jest.mock('pg', () => {
  class Pool {
    async query(sql: string, params: any[] = []) { queries.push({ sql, params }); return { rows }; }
    async connect() { return { query: async () => ({ rows: [] }), release: () => {} }; }
  }
  return { default: { Pool }, Pool };
});
jest.mock('../../config', () => ({ config: { database: { url: 'x' }, jwt: { secret: 's' }, bcrypt: { saltRounds: 4 } } }));

import { AuthService, AuthError } from '../auth.service';

const resolve = (login: string, host?: string) => (new AuthService('x') as any).resolveLogin(login, host);
beforeEach(() => { queries.length = 0; rows = []; });

it('email с «@» не трогаем и в базу не ходим', async () => {
  expect(await resolve('kassir1@mail.ru', 'coffee104.food-flow.ru')).toBe('kassir1@mail.ru');
  expect(queries).toHaveLength(0);
});

it('на адресе организации ищем по части до «@» только среди её сотрудников', async () => {
  rows = [{ email: 'kassir1@mail.ru' }];
  expect(await resolve('Kassir1', 'coffee104.food-flow.ru:443')).toBe('kassir1@mail.ru');
  expect(queries[0].sql).toMatch(/e\.subdomain = \$1/);
  expect(queries[0].sql).toMatch(/lower\(split_part\(u\.email, '@', 1\)\) = lower\(\$2\)/);
  expect(queries[0].params).toEqual(['coffee104', 'Kassir1']);
});

it('нет такого сотрудника — тот же 401, что на неверный пароль', async () => {
  await expect(resolve('nobody', 'coffee104.food-flow.ru')).rejects.toMatchObject({ statusCode: 401 });
});

it('два сотрудника с одинаковым логином — 409 с просьбой ввести email', async () => {
  rows = [{ email: 'ivan@a.ru' }, { email: 'ivan@b.ru' }];
  const e: any = await resolve('ivan', 'coffee104.food-flow.ru').catch((x: any) => x);
  expect(e).toBeInstanceOf(AuthError);
  expect(e.statusCode).toBe(409);
});

it('на голом домене и www короткий логин — учётка платформы <логин>@food-flow.ru', async () => {
  expect(await resolve('coffee104', 'food-flow.ru')).toBe('coffee104@food-flow.ru');
  expect(await resolve('coffee104', 'www.food-flow.ru')).toBe('coffee104@food-flow.ru');
  expect(await resolve('coffee104', undefined)).toBe('coffee104@food-flow.ru');
  expect(queries).toHaveLength(0);
});
