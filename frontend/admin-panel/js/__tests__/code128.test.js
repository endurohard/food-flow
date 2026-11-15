/**
 * Code128 номера карты. Корректность самих полос дополнительно сверена
 * независимым декодером (BarcodeDetector в Chrome) — здесь структура,
 * выбор набора и контрольный символ.
 */
const C = require('../code128');

test('таблица: 106 символов по 11 модулей и стоп на 13', () => {
  expect(C.PATTERNS).toHaveLength(107);
  C.PATTERNS.slice(0, 106).forEach((p, i) => {
    expect([p, p.split('').reduce((s, d) => s + +d, 0)]).toEqual([p, 11]);
  });
  expect(C.PATTERNS[106].split('').reduce((s, d) => s + +d, 0)).toBe(13);
  expect(new Set(C.PATTERNS).size).toBe(107);   // нет дублей — иначе два символа неразличимы
});

test('8 цифр — набор C, пары цифр, контрольный по модулю 103', () => {
  // 10000001 → старт C(105), 10, 0, 0, 1; контрольный = (105 + 10·1 + 0·2 + 0·3 + 1·4) % 103 = 16
  expect(C.values('10000001')).toEqual([105, 10, 0, 0, 1, 16]);
});

test('нечётные цифры и текст — набор B', () => {
  // старт B(104); '1'→17, '2'→18, '3'→19; (104 + 17 + 36 + 57) % 103 = 8
  expect(C.values('123')).toEqual([104, 17, 18, 19, 8]);
  expect(C.values('A1')[0]).toBe(104);
});

test('ширины: начинается стартом, кончается стопом, сумма модулей сходится', () => {
  const w = C.widths('10000001');
  expect(w.startsWith(C.PATTERNS[105])).toBe(true);
  expect(w.endsWith('2331112')).toBe(true);
  expect(w.split('').reduce((s, d) => s + +d, 0)).toBe(6 * 11 + 13);
});

test('svg: тихие зоны и полосы, без текста из входа', () => {
  const s = C.svg('10000001', { height: 50 });
  expect(s).toMatch(/^<svg [^>]*viewBox="0 0 99 50"/);   // 10 + 79 + 10 модулей
  expect(s).toMatch(/<path d="M10 0h/);
});

test('пустой текст и не-ASCII — ошибка, а не битый код', () => {
  expect(() => C.values('')).toThrow();
  expect(() => C.values('карта')).toThrow();
});
