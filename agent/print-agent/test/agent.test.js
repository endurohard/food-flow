'use strict';

/**
 * Тесты цикла агента против настоящего HTTP-сервера и настоящего
 * TCP-«принтера»: моки клиента проверяли бы моки, а не поведение.
 *
 * Серверы закрываются через t.after, а не в конце тела теста: при
 * падении ассерта закрытие в теле не выполняется, открытый сокет
 * держит процесс, и прогон висит навсегда вместо честного красного.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');

const { PrintAgent } = require('../src/index');

const silentLogger = { info() {}, warn() {}, error() {} };

/** Сервер-заглушка FoodFlow: отдаёт станции и задания, пишет отчёты. */
function fakeServer(t, { stations, jobs, token = 'tok' }) {
  const state = { results: [], statuses: [], helloCount: 0, tokensSeen: [], unauthorized: 0 };

  const server = http.createServer((req, res) => {
    const seen = req.headers['x-agent-token'];
    state.tokensSeen.push(seen);
    if (seen !== token) {
      state.unauthorized++;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Неизвестный токен' }));
      return;
    }

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const json = (obj) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (req.url === '/api/print-agent/hello') {
        state.helloCount++;
        state.lastHello = body;
        json({ success: true, data: { agent: { name: 'Кухня' }, stations, pollIntervalMs: 20 } });
        return;
      }
      if (req.url.startsWith('/api/print-agent/jobs?')) {
        json({ success: true, data: jobs.splice(0, 5) });
        return;
      }
      const resultMatch = req.url.match(/^\/api\/print-agent\/jobs\/([^/]+)\/result$/);
      if (resultMatch) {
        state.results.push({ jobId: resultMatch[1], ...body });
        json({ success: true });
        return;
      }
      const statusMatch = req.url.match(/^\/api\/print-agent\/stations\/([^/]+)\/status$/);
      if (statusMatch) {
        state.statuses.push({ stationId: statusMatch[1], ...body });
        json({ success: true });
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const handle = {
        url: `http://127.0.0.1:${server.address().port}`,
        state,
        close: () => new Promise((r) => server.close(r)),
      };
      // Уборка привязана к тесту: срабатывает и при падении ассерта.
      if (t) t.after(() => handle.close());
      resolve(handle);
    });
  });
}

function fakePrinter(t) {
  const received = [];
  const sockets = [];
  const server = net.createServer((s) => {
    sockets.push(s);
    s.on('data', (c) => received.push(c));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const handle = {
        port: server.address().port,
        get data() {
          return Buffer.concat(received);
        },
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(r);
          }),
      };
      if (t) t.after(() => handle.close());
      resolve(handle);
    });
  });
}

function makeAgent(serverUrl, token = 'tok') {
  return new PrintAgent({ serverUrl, token, pollIntervalMs: 10 }, silentLogger);
}

/** Ждёт выполнения условия: печать асинхронна, фиксированный sleep хрупок. */
async function waitFor(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

test('агент печатает задание и подтверждает успех серверу', async (t) => {
  const printer = await fakePrinter(t);
  const station = { id: 1, name: 'Горячий цех', type: 'network', address: `127.0.0.1:${printer.port}` };
  const payload = Buffer.from([0x1b, 0x40, 0x42, 0x4f, 0x52, 0x53, 0x43, 0x48]);
  const srv = await fakeServer(t, {
    stations: [station],
    jobs: [{ id: 'j1', kind: 'kitchen', copies: 1, station, payload: payload.toString('base64') }],
  });

  const agent = makeAgent(srv.url);
  await agent.handshake();
  const count = await agent.pollOnce();
  await waitFor(() => printer.data.length >= payload.length);

  assert.strictEqual(count, 1);
  assert.deepStrictEqual(printer.data, payload, 'на принтер ушли не те байты');
  assert.strictEqual(srv.state.results.length, 1, 'сервер не получил подтверждение');
  assert.strictEqual(srv.state.results[0].jobId, 'j1');
  assert.strictEqual(srv.state.results[0].ok, true);
});

test('сервер получает отчёт ok:false, когда принтер недоступен', async (t) => {
  const station = { id: 1, name: 'Мёртвый', type: 'network', address: '127.0.0.1:1' };
  const srv = await fakeServer(t, {
    stations: [station],
    jobs: [{ id: 'j2', kind: 'kitchen', copies: 1, station, payload: 'AQ==' }],
  });

  const agent = makeAgent(srv.url);
  await agent.handshake();
  await agent.pollOnce();

  assert.strictEqual(srv.state.results.length, 1, 'об ошибке печати обязан прийти отчёт');
  assert.strictEqual(srv.state.results[0].ok, false);
  assert.match(srv.state.results[0].error, /Нет связи|Таймаут/);
});

test('copies печатается указанное число раз, а не один', async (t) => {
  const printer = await fakePrinter(t);
  const station = { id: 1, name: 'Касса', type: 'network', address: `127.0.0.1:${printer.port}` };
  const srv = await fakeServer(t, {
    stations: [station],
    jobs: [{ id: 'j3', kind: 'receipt', copies: 3, station, payload: Buffer.from('AB').toString('base64') }],
  });

  const agent = makeAgent(srv.url);
  await agent.handshake();
  await agent.pollOnce();
  await waitFor(() => printer.data.length >= 6);

  assert.strictEqual(printer.data.toString(), 'ABABAB', 'напечатано не 3 копии');
});

test('агент сообщает серверу свою версию и платформу', async (t) => {
  const srv = await fakeServer(t, { stations: [], jobs: [] });
  const agent = makeAgent(srv.url);

  await agent.handshake();

  assert.ok(srv.state.lastHello.version, 'версия не отправлена');
  assert.ok(srv.state.lastHello.platform.includes(process.platform));
  assert.ok(srv.state.lastHello.hostname);
});

test('интервал опроса берётся с сервера, а не только из конфига', async (t) => {
  const srv = await fakeServer(t, { stations: [], jobs: [] });
  const agent = makeAgent(srv.url);
  assert.strictEqual(agent.pollIntervalMs, 10);
  await agent.handshake();
  assert.strictEqual(agent.pollIntervalMs, 20, 'серверный pollIntervalMs проигнорирован');
});

test('статус станции отправляется и не дублируется при неизменном состоянии', async (t) => {
  const printer = await fakePrinter(t);
  const station = { id: 7, name: 'Бар', type: 'network', address: `127.0.0.1:${printer.port}` };
  const srv = await fakeServer(t, { stations: [station], jobs: [] });

  const agent = makeAgent(srv.url);
  await agent.handshake();
  await agent.syncStationStatus();
  await agent.syncStationStatus();

  assert.deepStrictEqual(srv.state.statuses, [{ stationId: '7', status: 'online' }]);
});

test('неверный токен даёт 401 и агент не уходит в бесконечный цикл', async (t) => {
  const srv = await fakeServer(t, { stations: [], jobs: [], token: 'right' });
  const agent = makeAgent(srv.url, 'wrong');

  await assert.rejects(agent.handshake(), (err) => {
    assert.strictEqual(err.statusCode, 401);
    return true;
  });

  const exitBefore = process.exitCode;
  // run() обязан завершиться сам: без выхода по 401 этот await повис бы
  await agent.run();
  assert.strictEqual(process.exitCode, 1, 'при неверном токене агент должен выйти с ошибкой');
  process.exitCode = exitBefore;
});

test('токен уходит в заголовке, а не в URL: иначе он попадёт в логи прокси', async (t) => {
  const srv = await fakeServer(t, { stations: [], jobs: [] });
  const agent = makeAgent(srv.url);
  await agent.handshake();
  assert.deepStrictEqual(srv.state.tokensSeen, ['tok']);
});

test('упавший сервер не роняет агента и не печатает мусор', async (t) => {
  const srv = await fakeServer(null, { stations: [], jobs: [] });
  const url = srv.url;
  await srv.close();

  const agent = makeAgent(url);
  await assert.rejects(agent.pollOnce());
});
