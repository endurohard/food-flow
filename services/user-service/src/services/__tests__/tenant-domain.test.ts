import { subdomainFromName, ensureSubdomainCertificate, isReservedSubdomain } from '../tenant-domain.service';

describe('поддомен из названия организации', () => {
  it.each([
    ['Кофейня 104', 'kofeynya-104'],
    ['Jezva', 'jezva'],
    ['  Шаурма & Плов!! ', 'shaurma-plov'],
    ['Органика', 'organika'],
    ['Щи да каша', 'schi-da-kasha'],
  ])('%s → %s', (name, sub) => {
    const r = subdomainFromName(name);
    expect(r).toBe(sub);
    // Формат обязан проходить CHECK enterprises_subdomain_format
    expect(r).toMatch(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])$/);
  });

  it('служебное имя и пустой результат — пусто, решает вызывающий', () => {
    expect(subdomainFromName('www')).toBe('');
    expect(subdomainFromName('!!!')).toBe('');
    expect(isReservedSubdomain('api')).toBe(true);
    expect(isReservedSubdomain('kofeynya-104')).toBe(false);
  });

  it('длинное название обрезается без дефиса на конце', () => {
    const r = subdomainFromName('Очень длинное название ресторана восточной кухни на набережной');
    expect(r.length).toBeLessThanOrEqual(40);
    expect(r).not.toMatch(/-$/);
  });
});

describe('сертификат на поддомен', () => {
  const OLD = process.env.EDGE_KONG_ADMIN_URL;
  afterEach(() => { process.env.EDGE_KONG_ADMIN_URL = OLD; });

  it('заказывает POST /acme на <sub>.food-flow.ru у фронтового Kong', async () => {
    process.env.EDGE_KONG_ADMIN_URL = 'http://edge:8001/';
    const calls: any[] = [];
    const fake: any = async (url: string, opts: any) => {
      calls.push({ url, body: JSON.parse(opts.body), method: opts.method });
      return { ok: true, status: 201, json: async () => ({ message: 'created' }) };
    };
    const r = await ensureSubdomainCertificate('kofeynya-104', fake);
    expect(r.status).toBe('issued');
    expect(calls).toEqual([{ url: 'http://edge:8001/acme', method: 'POST', body: { host: 'kofeynya-104.food-flow.ru' } }]);
  });

  it('ошибка Kong — failed с причиной, без исключения (создание организации не падает)', async () => {
    process.env.EDGE_KONG_ADMIN_URL = 'http://edge:8001';
    const fake: any = async () => ({ ok: false, status: 400, json: async () => ({ message: 'domain not allowed' }) });
    const r = await ensureSubdomainCertificate('x1', fake);
    expect(r).toMatchObject({ status: 'failed', message: 'domain not allowed' });
    const boom: any = async () => { throw new Error('ECONNREFUSED'); };
    expect(await ensureSubdomainCertificate('x1', boom)).toMatchObject({ status: 'failed', message: 'ECONNREFUSED' });
  });

  it('без адреса Kong или без поддомена — skipped', async () => {
    delete process.env.EDGE_KONG_ADMIN_URL;
    expect((await ensureSubdomainCertificate('x1')).status).toBe('skipped');
    process.env.EDGE_KONG_ADMIN_URL = 'http://edge:8001';
    expect((await ensureSubdomainCertificate(null)).status).toBe('skipped');
  });
});
