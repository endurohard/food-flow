/**
 * Отображение количеств: храним в базовой единице, показываем в удобной.
 *
 * В базе всё лежит в килограммах и литрах (0.014 кг), как в расчётах
 * себестоимости. Человеку же привычнее граммы (14 г) — так показывает iiko.
 * Пересчёт делается ТОЛЬКО при выводе: данные и расчёты не трогаются,
 * иначе поедет себестоимость, а при обратном переводе накопится ошибка
 * округления.
 */
(function (global) {
  'use strict';

  // Порог перевода. 1 кг = 1000 г, поэтому всё, что меньше килограмма,
  // показываем в граммах: 0,014 кг плохо читается, 14 г — хорошо.
  var SMALL = {
    'кг': { small: 'г',  factor: 1000 },
    'л':  { small: 'мл', factor: 1000 }
  };

  /**
   * Форматирует количество для показа.
   * @param {number|string} value количество в базовой единице
   * @param {string} unit базовая единица ('кг', 'л', 'шт', ...)
   * @returns {{text: string, value: number, unit: string}}
   */
  function formatQty(value, unit) {
    var n = parseFloat(value);
    if (isNaN(n)) return { text: '—', value: NaN, unit: unit || '' };

    var rule = SMALL[unit];
    // Ноль показываем в базовой единице: «0 г» вместо «0 кг» сбивает с толку
    // при пустой строке состава.
    if (rule && n !== 0 && Math.abs(n) < 1) {
      var small = n * rule.factor;
      return { text: trim(small, 3) + ' ' + rule.small, value: small, unit: rule.small };
    }
    return { text: trim(n, 3) + (unit ? ' ' + unit : ''), value: n, unit: unit || '' };
  }

  /** Только текст — для вставки в таблицу. */
  function qty(value, unit) {
    return formatQty(value, unit).text;
  }

  /**
   * Обрезает хвостовые нули: 14.000 → «14», 0.014 → «0,014».
   * Десятичный разделитель — запятая, как во всей админке.
   */
  function trim(n, digits) {
    var s = n.toFixed(digits);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s.replace('.', ',');
  }

  var api = { formatQty: formatQty, qty: qty, SMALL: SMALL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.Units = api;
}(typeof window !== 'undefined' ? window : globalThis));
