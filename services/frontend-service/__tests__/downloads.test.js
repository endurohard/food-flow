/**
 * Раздача APK кассы: имя файла под организацию и честный 404.
 *
 * Проверяется поведение, за которое бьёт пользователь: кнопка «Скачать»
 * не должна отдавать 404-страницу вместо файла, а кассир должен видеть,
 * под какую организацию скачан apk.
 */

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const {
  createDownloadsRouter,
  subdomainFromHost,
  apkFileName,
  readMeta,
  APK_FILE,
  META_FILE
} = require('../downloads');

describe('subdomainFromHost', () => {
  it('выделяет метку организации', () => {
    expect(subdomainFromHost('jezva.food-flow.ru')).toBe('jezva');
    expect(subdomainFromHost('jezva.food-flow.ru:443')).toBe('jezva');
    // за Kong заголовок может прийти списком
    expect(subdomainFromHost('jezva.food-flow.ru, kong')).toBe('jezva');
  });

  it('голый домен, www, localhost и IP метками не считает', () => {
    expect(subdomainFromHost('food-flow.ru')).toBeNull();
    expect(subdomainFromHost('www.food-flow.ru')).toBeNull();
    expect(subdomainFromHost('localhost')).toBeNull();
    expect(subdomainFromHost('localhost:3000')).toBeNull();
    expect(subdomainFromHost('192.168.1.10')).toBeNull();
    expect(subdomainFromHost('')).toBeNull();
    expect(subdomainFromHost(undefined)).toBeNull();
  });

  it('не пускает в имя файла посторонние символы из host', () => {
    // host приходит от клиента: путь/кавычки/слэш не должны попасть в Content-Disposition
    expect(subdomainFromHost('../etc.food-flow.ru')).toBeNull();
    expect(subdomainFromHost('a"b.food-flow.ru')).toBeNull();
    expect(subdomainFromHost('a/b.food-flow.ru')).toBeNull();
    expect(subdomainFromHost('ЖЕЗВА.food-flow.ru')).toBeNull();
  });
});

describe('apkFileName', () => {
  it('подставляет метку организации', () => {
    expect(apkFileName('jezva.food-flow.ru')).toBe('foodflow-pos-jezva.apk');
  });

  it('без поддомена отдаёт общее имя', () => {
    expect(apkFileName('food-flow.ru')).toBe('foodflow-pos.apk');
  });
});

// ── интеграционная часть: поднимаем роутер на реальном http-сервере ──────

function startServer(dir) {
  const app = express();
  app.use('/downloads', createDownloadsRouter(dir));
  const server = http.createServer(app);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function request(server, pathname, host) {
  const { port } = server.address();
  const headers = host ? { Host: host } : {};
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }));
    }).on('error', reject);
  });
}

describe('роутер /downloads', () => {
  let dir;
  let server;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-apk-'));
    server = await startServer(dir);
  });

  afterEach(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('без загруженной сборки отдаёт 404 с внятным текстом, а не пустой файл', async () => {
    const apk = await request(server, '/downloads/pos.apk', 'jezva.food-flow.ru');
    expect(apk.status).toBe(404);
    expect(JSON.parse(apk.body.toString()).message).toMatch(/не загружена/i);

    const meta = await request(server, '/downloads/pos.json', 'jezva.food-flow.ru');
    expect(meta.status).toBe(404);
    expect(JSON.parse(meta.body.toString()).available).toBe(false);
  });

  it('отдаёт файл под именем организации и с типом для установщика Android', async () => {
    fs.writeFileSync(path.join(dir, APK_FILE), 'APKDATA');
    const res = await request(server, '/downloads/pos.apk', 'jezva.food-flow.ru');
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('APKDATA');
    expect(res.headers['content-type']).toMatch('application/vnd.android.package-archive');
    expect(res.headers['content-disposition']).toMatch('foodflow-pos-jezva.apk');
  });

  it('метаданные содержат версию из json и фактический размер файла', async () => {
    fs.writeFileSync(path.join(dir, APK_FILE), Buffer.alloc(2048, 1));
    fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify({
      versionName: '1.0.0', versionCode: 1, minSdk: 25, sha256: 'abc'
    }));
    const res = await request(server, '/downloads/pos.json', 'jezva.food-flow.ru');
    const body = JSON.parse(res.body.toString());
    expect(res.status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.size).toBe(2048);
    expect(body.versionName).toBe('1.0.0');
    expect(body.minSdk).toBe(25);
    expect(body.fileName).toBe('foodflow-pos-jezva.apk');
    // кэшировать нельзя: иначе после обновления сборки страница покажет старую версию
    expect(res.headers['cache-control']).toMatch('no-store');
  });

  it('битый json не ломает выдачу — размер и дата берутся с файловой системы', async () => {
    fs.writeFileSync(path.join(dir, APK_FILE), Buffer.alloc(10, 1));
    fs.writeFileSync(path.join(dir, META_FILE), '{не json');
    const meta = readMeta(dir);
    expect(meta.available).toBe(true);
    expect(meta.size).toBe(10);
    expect(meta.versionName).toBeNull();
  });
});
