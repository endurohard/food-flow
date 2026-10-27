/**
 * Раздача APK кассы под домен организации.
 *
 * APK один на всю платформу (универсальный): адрес сервера касса получает
 * при привязке — из QR или короткого кода организации на странице скачивания.
 * Персонализация тут только в имени файла: кассир видит, под какую
 * организацию он скачал файл, и не путает терминалы разных заведений.
 *
 * Файл лежит рядом со статикой (`public/downloads/`) и в git не хранится —
 * он собирается скриптом scripts/publish-pos-apk.sh и копируется на сервер.
 * Отсутствие файла — это 404 с внятным текстом, а не «скачалось ничего»:
 * кнопка на странице обязана честно сказать, что сборка не загружена.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const APK_DIR = path.join(__dirname, 'public', 'downloads');
const APK_FILE = 'foodflow-pos.apk';
const META_FILE = 'foodflow-pos.json';

/**
 * Метка организации из хоста: jezva.food-flow.ru → jezva.
 * Голый домен, www, localhost и IP поддоменом не считаем — для них имя
 * файла остаётся общим. Логика повторяет getEnterpriseByHost в user-service,
 * но здесь она нужна только для имени файла и к БД не обращается.
 */
function subdomainFromHost(host) {
  if (!host || typeof host !== 'string') return null;
  const hostname = host.split(',')[0].trim().toLowerCase().split(':')[0];
  if (!hostname || /^[0-9.]+$/.test(hostname)) return null;
  const labels = hostname.split('.');
  if (labels.length < 3) return null;
  const label = labels[0];
  if (!label || label === 'www') return null;
  // В имя файла пускаем только безопасные символы: host приходит от клиента
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(label)) return null;
  return label;
}

/** Имя скачиваемого файла: с меткой организации, если она есть в адресе. */
function apkFileName(host) {
  const sub = subdomainFromHost(host);
  return sub ? `foodflow-pos-${sub}.apk` : 'foodflow-pos.apk';
}

/** Хост, по которому клиент реально обратился (за Kong — X-Forwarded-Host). */
function requestHost(req) {
  const fwd = req.headers['x-forwarded-host'];
  return (Array.isArray(fwd) ? fwd[0] : fwd) || req.headers.host || '';
}

/**
 * Метаданные сборки. Источник — json рядом с apk, который пишет скрипт
 * публикации; размер и дату берём с файловой системы, чтобы метаданные
 * не разошлись с тем, что реально отдаётся.
 */
function readMeta(dir = APK_DIR) {
  const apkPath = path.join(dir, APK_FILE);
  let stat = null;
  try {
    stat = fs.statSync(apkPath);
  } catch (e) {
    return { available: false };
  }
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8'));
  } catch (e) {
    // json может отсутствовать: тогда отдаём то, что знаем о файле
    meta = {};
  }
  return {
    available: true,
    size: stat.size,
    uploadedAt: stat.mtime.toISOString(),
    versionName: meta.versionName || null,
    versionCode: meta.versionCode || null,
    sha256: meta.sha256 || null,
    minSdk: meta.minSdk || null,
    builtAt: meta.builtAt || null
  };
}

function createDownloadsRouter(dir = APK_DIR) {
  const router = express.Router();

  // Метаданные для страницы скачивания: есть ли сборка, какая версия, размер
  router.get('/pos.json', (req, res) => {
    const meta = readMeta(dir);
    res.set('Cache-Control', 'no-store');
    if (!meta.available) {
      return res.status(404).json({
        available: false,
        message: 'Сборка кассы не загружена на сервер'
      });
    }
    return res.json({ ...meta, fileName: apkFileName(requestHost(req)) });
  });

  router.get('/pos.apk', (req, res) => {
    const apkPath = path.join(dir, APK_FILE);
    if (!fs.existsSync(apkPath)) {
      res.set('Cache-Control', 'no-store');
      return res.status(404).json({
        error: 'Not Found',
        message: 'Сборка кассы не загружена на сервер'
      });
    }
    // Android ставит файл по этому типу. express.download выставляет его и сам
    // по расширению .apk — оставлено явно, чтобы тип не зависел от имени файла.
    res.type('application/vnd.android.package-archive');
    return res.download(apkPath, apkFileName(requestHost(req)));
  });

  return router;
}

module.exports = {
  createDownloadsRouter,
  subdomainFromHost,
  apkFileName,
  requestHost,
  readMeta,
  APK_DIR,
  APK_FILE,
  META_FILE
};
