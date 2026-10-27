'use strict';

/**
 * Клиент серверного API. Запросы только исходящие: кухне не нужен ни
 * публичный IP, ни проброс портов, ни VPN.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

class ApiClient {
  constructor({ serverUrl, token, timeoutMs = 15000, logger = console }) {
    this.base = serverUrl.replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
  }

  request(method, path, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.base + path);
      const mod = url.protocol === 'https:' ? https : http;
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));

      const req = mod.request(
        {
          method,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          headers: {
            // Токен агента, не пользовательский JWT: за агентом нет
            // человека, и токен живёт на кухонной машине постоянно.
            'X-Agent-Token': this.token,
            Accept: 'application/json',
            ...(payload
              ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
              : {}),
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed = null;
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch {
              // Не-JSON от прокси (502 от nginx, HTML-заглушка) — это не
              // ошибка разбора, а сообщение о недоступности сервера.
            }

            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
              return;
            }

            const err = new Error(
              (parsed && parsed.error) || `HTTP ${res.statusCode}: ${text.slice(0, 200)}`,
            );
            err.statusCode = res.statusCode;
            reject(err);
          });
        },
      );

      req.on('timeout', () => {
        req.destroy(new Error(`Таймаут запроса ${method} ${path}`));
      });
      req.on('error', reject);

      if (payload) req.write(payload);
      req.end();
    });
  }

  hello(info) {
    return this.request('POST', '/api/print-agent/hello', info);
  }

  fetchJobs(limit = 5) {
    return this.request('GET', `/api/print-agent/jobs?limit=${limit}`);
  }

  reportResult(jobId, ok, error) {
    return this.request('POST', `/api/print-agent/jobs/${jobId}/result`, { ok, error });
  }

  reportStationStatus(stationId, status) {
    return this.request('POST', `/api/print-agent/stations/${stationId}/status`, { status });
  }
}

module.exports = { ApiClient };
