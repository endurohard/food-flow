#!/usr/bin/env node
'use strict';

/**
 * FoodFlow Print Agent — агент печати на точке.
 *
 * Зачем он нужен. Сервер FoodFlow стоит в дата-центре и не видит
 * принтеры в локальной сети кухни: адрес 192.168.x.x ему недостижим.
 * Агент работает наоборот — сам опрашивает сервер исходящими запросами
 * и печатает на принтер, который видит из своей сети. Публичный IP,
 * проброс портов и VPN на точке не требуются.
 *
 * Байты ESC/POS формирует сервер, агент только пишет их в принтер:
 * формат чека меняется на сервере сразу для всех точек.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ApiClient } = require('./api-client');
const { printToStation, probeStation } = require('./transport');

const VERSION = '1.0.0';

// ─── Логи ────────────────────────────────────────────────────

function createLogger(logFile) {
  const write = (level, msg) => {
    const line = `${new Date().toISOString()} [${level}] ${msg}`;
    // В консоль всегда: при запуске руками видно, что происходит.
    if (level === 'ERROR' || level === 'WARN') console.error(line);
    else console.log(line);
    if (logFile) {
      try {
        fs.appendFileSync(logFile, line + '\n');
      } catch {
        // Недоступный файл логов не должен останавливать печать.
      }
    }
  };
  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
  };
}

// ─── Конфигурация ────────────────────────────────────────────

function defaultConfigPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'FoodFlow', 'print-agent.json');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'FoodFlow', 'print-agent.json');
  }
  return '/etc/foodflow/print-agent.json';
}

function loadConfig() {
  const explicit = process.argv.find((a) => a.startsWith('--config='));
  const configPath = explicit
    ? explicit.slice('--config='.length)
    : process.env.FOODFLOW_AGENT_CONFIG || defaultConfigPath();

  let fileConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      throw new Error(`Файл настроек ${configPath} повреждён: ${err.message}`);
    }
  }

  // Переменные окружения перекрывают файл: так удобнее в Docker.
  const config = {
    serverUrl: process.env.FOODFLOW_SERVER_URL || fileConfig.serverUrl,
    token: process.env.FOODFLOW_AGENT_TOKEN || fileConfig.token,
    pollIntervalMs: Number(
      process.env.FOODFLOW_POLL_INTERVAL_MS || fileConfig.pollIntervalMs || 3000,
    ),
    logFile: process.env.FOODFLOW_AGENT_LOG || fileConfig.logFile || null,
    configPath,
  };

  const missing = [];
  if (!config.serverUrl) missing.push('serverUrl (FOODFLOW_SERVER_URL)');
  if (!config.token) missing.push('token (FOODFLOW_AGENT_TOKEN)');
  if (missing.length) {
    throw new Error(
      `Не заданы обязательные настройки: ${missing.join(', ')}.\n` +
        `Создайте ${configPath} вида {"serverUrl":"https://ваш-сервер","token":"..."} ` +
        `или задайте переменные окружения.`,
    );
  }

  return config;
}

// ─── Основной цикл ───────────────────────────────────────────

class PrintAgent {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.api = new ApiClient({
      serverUrl: config.serverUrl,
      token: config.token,
      logger,
    });
    this.pollIntervalMs = config.pollIntervalMs;
    this.stations = new Map();
    this.stationStatus = new Map();
    this.running = false;
    // Шаг бэкоффа при недоступном сервере: без него агент долбит
    // упавший сервер каждые 3 секунды и засоряет его логи.
    this.backoffMs = 0;
  }

  async handshake() {
    const res = await this.api.hello({
      version: VERSION,
      platform: `${process.platform}-${process.arch}`,
      hostname: os.hostname(),
    });

    const data = (res && res.data) || {};
    this.stations = new Map((data.stations || []).map((s) => [s.id, s]));

    if (data.pollIntervalMs) this.pollIntervalMs = data.pollIntervalMs;

    this.logger.info(
      `Подключён как «${(data.agent && data.agent.name) || 'агент'}», станций: ${this.stations.size}`,
    );
    if (this.stations.size === 0) {
      this.logger.warn(
        'К агенту не привязана ни одна станция. Привяжите принтер в админке: Настройки → Принтеры.',
      );
    }
    for (const st of this.stations.values()) {
      this.logger.info(`  станция #${st.id} «${st.name}» (${st.type} ${st.address || st.device || ''})`);
    }
  }

  /** Сообщает серверу статус станции только при его изменении. */
  async syncStationStatus() {
    for (const st of this.stations.values()) {
      const online = await probeStation(st);
      const status = online ? 'online' : 'offline';
      if (this.stationStatus.get(st.id) === status) continue;

      this.stationStatus.set(st.id, status);
      try {
        await this.api.reportStationStatus(st.id, status);
        this.logger.info(`Станция «${st.name}»: ${status}`);
      } catch (err) {
        this.logger.warn(`Не удалось сообщить статус станции ${st.id}: ${err.message}`);
      }
    }
  }

  async processJob(job) {
    // Станция приходит в задании, но её настройки могли измениться —
    // берём свежие из handshake, если такая станция у нас есть.
    const station = (job.station && job.station.id && this.stations.get(job.station.id)) || job.station;
    const data = Buffer.from(job.payload, 'base64');
    const copies = job.copies > 0 ? job.copies : 1;

    for (let i = 0; i < copies; i++) {
      await printToStation(station, data);
    }

    this.logger.info(
      `Напечатано задание ${job.id} (${job.kind}) на «${station.name || 'принтер'}»` +
        (copies > 1 ? `, копий: ${copies}` : ''),
    );
  }

  async pollOnce() {
    const res = await this.api.fetchJobs(5);
    const jobs = (res && res.data) || [];

    for (const job of jobs) {
      try {
        await this.processJob(job);
        await this.api.reportResult(job.id, true);
      } catch (err) {
        // Отчитаться об ошибке обязательно: иначе задание висит
        // in_progress и чек не выйдет даже после починки принтера.
        this.logger.error(`Задание ${job.id} не напечатано: ${err.message}`);
        try {
          await this.api.reportResult(job.id, false, err.message);
        } catch (reportErr) {
          this.logger.error(`Не удалось сообщить об ошибке печати: ${reportErr.message}`);
        }
      }
    }

    return jobs.length;
  }

  async run() {
    this.running = true;
    this.logger.info(`FoodFlow Print Agent ${VERSION}, сервер: ${this.config.serverUrl}`);

    let sinceHandshake = Infinity;

    while (this.running) {
      try {
        // Периодический handshake: он же heartbeat и он же подхватывает
        // новые станции без перезапуска агента.
        if (sinceHandshake >= 60000) {
          await this.handshake();
          await this.syncStationStatus();
          sinceHandshake = 0;
        }

        await this.pollOnce();
        this.backoffMs = 0;
      } catch (err) {
        if (err.statusCode === 401) {
          // Неверный токен сам не починится — повторять бессмысленно.
          this.logger.error(
            'Сервер отверг токен агента. Проверьте token в настройках или перевыпустите его в админке.',
          );
          process.exitCode = 1;
          return;
        }
        this.backoffMs = Math.min(this.backoffMs ? this.backoffMs * 2 : 5000, 60000);
        this.logger.warn(
          `Связь с сервером потеряна (${err.message}). Повтор через ${Math.round(
            this.backoffMs / 1000,
          )} с.`,
        );
        sinceHandshake = Infinity; // после восстановления связи — заново
      }

      const wait = this.backoffMs || this.pollIntervalMs;
      sinceHandshake += wait;
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  stop() {
    this.running = false;
  }
}

// ─── Запуск ──────────────────────────────────────────────────

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    process.exit(1);
  }

  const logger = createLogger(config.logFile);
  const agent = new PrintAgent(config, logger);

  const shutdown = (signal) => {
    logger.info(`Получен ${signal}, завершаю работу`);
    agent.stop();
    setTimeout(() => process.exit(0), 1000);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await agent.run();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[ERROR] Агент остановлен: ${err.stack || err.message}`);
    process.exit(1);
  });
}

module.exports = { PrintAgent, loadConfig, createLogger, VERSION };
