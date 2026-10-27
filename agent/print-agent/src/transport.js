'use strict';

/**
 * Транспорт печати: как именно байты ESC/POS попадают в принтер.
 *
 * Все способы реализованы на stdlib Node — агент ставится на кухонную
 * машину без npm install и собирается в один исполняемый файл.
 */

const net = require('net');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

/** Сетевой принтер: сырой ESC/POS в TCP-порт (обычно 9100). */
function printNetwork(address, data, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const [host, portRaw] = String(address).split(':');
    const port = parseInt(portRaw, 10) || 9100;

    if (!host) {
      reject(new Error('Не задан адрес сетевого принтера (ожидается IP:порт)'));
      return;
    }

    const socket = new net.Socket();
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => fail(new Error(`Таймаут соединения с ${host}:${port}`)));
    socket.on('error', (err) => fail(new Error(`Нет связи с ${host}:${port}: ${err.message}`)));

    socket.connect(port, host, () => {
      socket.write(data, (err) => {
        if (err) {
          fail(new Error(`Ошибка записи в принтер: ${err.message}`));
          return;
        }
        // end() ждёт, пока буфер уйдёт в сеть: destroy() сразу после
        // write() обрывает передачу и чек печатается обрезанным.
        socket.end(() => {
          if (settled) return;
          settled = true;
          resolve();
        });
      });
    });
  });
}

/**
 * USB/последовательный принтер как файл устройства: /dev/usb/lp0 на Linux,
 * \\.\\USB001 или имя порта на Windows.
 */
function printDevice(device, data) {
  return new Promise((resolve, reject) => {
    if (!device) {
      reject(new Error('Не задан путь к устройству принтера'));
      return;
    }
    fs.writeFile(device, data, (err) => {
      if (err) {
        reject(new Error(`Не удалось записать в ${device}: ${err.message}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * Печать через системную очередь ОС — когда принтер поставлен драйвером.
 * Данные пишутся во временный файл и отдаются системной утилите в
 * raw-режиме: драйвер не должен переинтерпретировать ESC/POS.
 */
function printSystem(printerName, data) {
  return new Promise((resolve, reject) => {
    const tmp = `${os.tmpdir()}/foodflow-print-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.bin`;

    fs.writeFile(tmp, data, (writeErr) => {
      if (writeErr) {
        reject(new Error(`Не удалось создать временный файл: ${writeErr.message}`));
        return;
      }

      const cleanup = () => fs.unlink(tmp, () => {});

      let cmd;
      let args;
      if (process.platform === 'win32') {
        // В Windows raw-печать делается копированием в сетевой ресурс
        // принтера; имя вида \\\\localhost\\ИмяПринтера должно быть расшарено.
        cmd = 'cmd';
        args = ['/c', 'copy', '/b', tmp, printerName];
      } else {
        // CUPS: -oraw отключает фильтры, иначе драйвер съедает ESC/POS
        cmd = 'lp';
        args = ['-d', printerName, '-oraw', tmp];
      }

      const child = spawn(cmd, args, { windowsHide: true });
      let stderr = '';
      child.stderr.on('data', (c) => {
        stderr += c.toString();
      });
      child.on('error', (err) => {
        cleanup();
        reject(new Error(`Не удалось запустить печать: ${err.message}`));
      });
      child.on('close', (code) => {
        cleanup();
        if (code === 0) resolve();
        else reject(new Error(`Печать завершилась с кодом ${code}: ${stderr.trim()}`));
      });
    });
  });
}

/**
 * Печать задания на станцию. Тип станции приходит с сервера.
 * `device` для типа system содержит имя системного принтера.
 */
async function printToStation(station, data) {
  const type = station.type || 'network';

  switch (type) {
    case 'network':
      return printNetwork(station.address, data);
    case 'usb':
      return printDevice(station.device, data);
    case 'system':
      return printSystem(station.device, data);
    case 'bluetooth':
      // Спаренный Bluetooth-принтер виден системе как последовательный
      // порт или системный принтер — отдельного транспорта не требуется.
      if (station.device) return printDevice(station.device, data);
      throw new Error(
        'Для Bluetooth-принтера укажите путь к спаренному устройству (COM-порт или /dev/rfcomm0)',
      );
    default:
      throw new Error(`Неизвестный тип принтера: ${type}`);
  }
}

/** Проверка доступности принтера без печати — для отчёта о статусе станции. */
function probeStation(station, timeoutMs = 3000) {
  const type = station.type || 'network';

  if (type === 'network') {
    return new Promise((resolve) => {
      const [host, portRaw] = String(station.address || '').split(':');
      const port = parseInt(portRaw, 10) || 9100;
      if (!host) {
        resolve(false);
        return;
      }
      const socket = new net.Socket();
      const done = (ok) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs);
      socket.on('timeout', () => done(false));
      socket.on('error', () => done(false));
      socket.connect(port, host, () => done(true));
    });
  }

  if (type === 'usb' || type === 'bluetooth') {
    return Promise.resolve(!!station.device && fs.existsSync(station.device));
  }

  // Системный принтер: наличие очереди проверить дешевле, чем печать,
  // но кросс-платформенно это ненадёжно — считаем доступным.
  return Promise.resolve(!!station.device);
}

module.exports = { printToStation, probeStation, printNetwork, printDevice, printSystem };
