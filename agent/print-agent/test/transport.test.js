'use strict';

/**
 * Тесты транспорта печати. Сетевой принтер поднимается настоящим
 * TCP-сервером: мок socket.write проверял бы мок, а не передачу байт.
 */

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { printToStation, probeStation, printNetwork } = require('../src/transport');

/** Поднимает принтер-заглушку, собирает принятые байты. */
function fakePrinter({ slowReadMs = 0 } = {}) {
  const received = [];
  const server = net.createServer((socket) => {
    // Медленный приём имитирует настоящий термопринтер: он разбирает
    // буфер неспешно. Без этого весь чек целиком влезает в буфер ядра
    // на loopback, и обрыв соединения сразу после write() остаётся
    // незаметным — ровно так мутация «destroy вместо end» и пряталась.
    if (slowReadMs) {
      socket.pause();
      setTimeout(() => socket.resume(), slowReadMs);
    }
    socket.on('data', (c) => received.push(c));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        received,
        get data() {
          return Buffer.concat(received);
        },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('сетевая печать доставляет байты целиком', async () => {
  const printer = await fakePrinter();
  const payload = Buffer.concat([Buffer.from([0x1b, 0x40]), Buffer.alloc(200_000, 0x41)]);

  await printToStation({ type: 'network', address: `127.0.0.1:${printer.port}` }, payload);
  await new Promise((r) => setTimeout(r, 100));

  assert.strictEqual(printer.data.length, payload.length, 'чек передан не полностью');
  assert.deepStrictEqual(printer.data.subarray(0, 2), Buffer.from([0x1b, 0x40]));
  await printer.close();
});

test('длинный чек не обрезается: доставка ждёт выгрузки буфера', async () => {
  // Принтер читает с задержкой, буфер ядра переполняется, и колбэк
  // write() срабатывает только после того, как все байты приняты.
  // Тест ловит пропуск этого ожидания (resolve до конца передачи).
  // Замена end() на destroy() ПОСЛЕ колбэка, наоборот, ненаблюдаема:
  // данные уже в буфере ядра и будут доставлены — такую мутацию не
  // убить, и ослаблять под неё ассерт не нужно.
  const printer = await fakePrinter({ slowReadMs: 400 });
  const payload = Buffer.alloc(8 * 1024 * 1024, 0x42);

  await printToStation({ type: 'network', address: `127.0.0.1:${printer.port}` }, payload);
  await new Promise((r) => setTimeout(r, 800));

  assert.strictEqual(
    printer.data.length,
    payload.length,
    `чек обрезан: дошло ${printer.data.length} из ${payload.length} байт`,
  );
  await printer.close();
});

test('недоступный принтер даёт ошибку, а не тихий успех', async () => {
  await assert.rejects(
    // порт 1 закрыт на любой машине
    printNetwork('127.0.0.1:1', Buffer.from('x'), 1000),
    /Нет связи|Таймаут/,
  );
});

test('пустой адрес сетевого принтера отвергается с внятным текстом', async () => {
  await assert.rejects(
    printToStation({ type: 'network', address: '' }, Buffer.from('x')),
    /адрес сетевого принтера/,
  );
});

test('порт по умолчанию 9100, когда в адресе только IP', async () => {
  // Проверяем через заглушку на 9100, если он свободен; иначе — что
  // попытка идёт именно на 9100, а не на NaN (NaN дал бы другую ошибку).
  await assert.rejects(printNetwork('127.0.0.1', Buffer.from('x'), 800), (err) => {
    assert.match(err.message, /127\.0\.0\.1:9100/);
    return true;
  });
});

test('печать в устройство пишет те же байты', async () => {
  const device = path.join(os.tmpdir(), `ff-dev-${Date.now()}`);
  const payload = Buffer.from([0x1b, 0x40, 0x41, 0x42]);

  await printToStation({ type: 'usb', device }, payload);

  assert.deepStrictEqual(fs.readFileSync(device), payload);
  fs.unlinkSync(device);
});

test('несуществующий путь устройства даёт ошибку с путём в тексте', async () => {
  await assert.rejects(
    printToStation({ type: 'usb', device: '/nope/really-nope/lp0' }, Buffer.from('x')),
    /\/nope\/really-nope\/lp0/,
  );
});

test('неизвестный тип принтера не печатает молча', async () => {
  await assert.rejects(
    printToStation({ type: 'telepathy' }, Buffer.from('x')),
    /Неизвестный тип принтера/,
  );
});

test('bluetooth без устройства объясняет, что нужно указать', async () => {
  await assert.rejects(
    printToStation({ type: 'bluetooth' }, Buffer.from('x')),
    /спаренному устройству/,
  );
});

test('probeStation отличает живой принтер от мёртвого', async () => {
  const printer = await fakePrinter();
  assert.strictEqual(
    await probeStation({ type: 'network', address: `127.0.0.1:${printer.port}` }),
    true,
  );
  await printer.close();
  assert.strictEqual(await probeStation({ type: 'network', address: '127.0.0.1:1' }, 500), false);
});

test('probeStation для usb проверяет наличие файла устройства', async () => {
  const device = path.join(os.tmpdir(), `ff-probe-${Date.now()}`);
  fs.writeFileSync(device, '');
  assert.strictEqual(await probeStation({ type: 'usb', device }), true);
  fs.unlinkSync(device);
  assert.strictEqual(await probeStation({ type: 'usb', device }), false);
});
