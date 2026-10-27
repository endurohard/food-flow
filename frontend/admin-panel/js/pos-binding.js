/**
 * Код привязки кассы к организации — общий хелпер страницы скачивания.
 *
 * Держится отдельно от разметки, чтобы покрываться юнит-тестами: ошибка здесь
 * означает QR, по которому терминал уйдёт работать на чужой сервер.
 * Правила разбора хоста те же, что в Binding.kt (Android) и downloads.js
 * (frontend-service) — три места обязаны считать поддомен одинаково.
 */
(function (global) {
  'use strict';

  // Та же метка DNS, что в CHECK миграции 029: [a-z0-9-], 2..63, без дефиса по краям
  var LABEL = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;

  var POS_BINDING = {
    /**
     * Метка организации из хоста: jezva.food-flow.ru → jezva.
     * Голый домен, www, localhost и IP метками не считаются — иначе на
     * 127.0.0.1 в QR уезжает «127» как код организации.
     */
    orgLabel: function (hostname) {
      if (!hostname || typeof hostname !== 'string') return null;
      var h = hostname.toLowerCase();
      if (/^[0-9.]+$/.test(h)) return null;
      var labels = h.split('.');
      if (labels.length < 3) return null;
      var first = labels[0];
      if (first === 'www' || !LABEL.test(first)) return null;
      return first;
    },

    /** Базовый домен платформы: всё после метки организации. */
    platformDomain: function (hostname) {
      if (!hostname) return '';
      var labels = hostname.toLowerCase().split('.');
      return labels.length >= 3 ? labels.slice(1).join('.') : hostname.toLowerCase();
    },

    /**
     * Ссылка привязки для QR. Адрес сервера кладём всегда: касса обязана
     * получить его целиком, а не угадывать по метке — установки бывают
     * на своих доменах и нестандартных портах.
     */
    bindingUrl: function (origin, label, orgName) {
      var u = 'ffpos://setup?api=' + encodeURIComponent(origin);
      if (label) u += '&sub=' + encodeURIComponent(label);
      if (orgName) u += '&org=' + encodeURIComponent(orgName);
      return u;
    },

    /** Размер файла для показа: мегабайты с запятой, как принято в ru-локали. */
    formatSize: function (bytes) {
      return (bytes / (1024 * 1024)).toFixed(1).replace('.', ',') + ' МБ';
    }
  };

  if (typeof module === 'object' && module.exports) module.exports = POS_BINDING;
  if (global) global.POS_BINDING = POS_BINDING;
})(typeof window !== 'undefined' ? window : null);
