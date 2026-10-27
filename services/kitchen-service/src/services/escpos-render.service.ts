/**
 * Рендер чеков в байты ESC/POS.
 *
 * Формат считает сервер, а агент на кухне только пишет готовые байты в
 * принтер. Так логика чека живёт в одном месте и не расползается по
 * версиям агентов, установленным на разных точках: изменили формат —
 * он сразу у всех, переустанавливать агент не нужно.
 */

export interface RenderItem {
  name: string;
  quantity: number;
  price?: number;
  specialInstructions?: string;
}

export interface RenderOrder {
  orderNumber: string;
  restaurant?: { name?: string; address?: string; phone?: string };
  customer?: { name?: string; phone?: string };
  items: RenderItem[];
  total?: number;
  orderType?: string;
  stationName?: string;
  specialInstructions?: string;
  timestamp: Date;
}

export interface RenderOptions {
  /** 58 мм ≈ 32 символа, 80 мм ≈ 48 символов */
  paperWidth?: 58 | 80;
  /** Кодовая страница принтера для кириллицы */
  encoding?: 'CP866' | 'CP1251' | 'UTF8';
}

const ESC = 0x1b;
const GS = 0x1d;

/** Карта кодовых страниц ESC/POS (ESC t n) для кириллицы. */
const CODEPAGE_COMMAND: Record<string, number> = {
  CP866: 17, // PC866 Cyrillic #2 — самый совместимый вариант у ESC/POS
  CP1251: 46, // WPC1251
  UTF8: 17, // большинство термопринтеров UTF-8 не умеют, падаем на CP866
};

/**
 * Перекодировка кириллицы в однобайтовую кодовую страницу.
 * iconv-lite в зависимостях нет, а таблицы CP866/CP1251 для русского
 * алфавита регулярны — считаем смещением, без новой зависимости.
 */
function encodeText(text: string, encoding: string): Buffer {
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;

    if (code < 0x80) {
      out.push(code);
      continue;
    }

    if (encoding === 'CP1251') {
      if (code >= 0x410 && code <= 0x44f) {
        out.push(code - 0x410 + 0xc0); // А-я идут непрерывно
        continue;
      }
      if (code === 0x401) { out.push(0xa8); continue; } // Ё
      if (code === 0x451) { out.push(0xb8); continue; } // ё
      if (code === 0x2116) { out.push(0xb9); continue; } // №
    } else {
      // CP866: А-П = 0x80..0x8F, Р-Я = 0x90..0x9F, а-п = 0xA0..0xAF,
      // р-я = 0xE0..0xEF — три непрерывных блока с разрывом.
      if (code >= 0x410 && code <= 0x43f) { out.push(code - 0x410 + 0x80); continue; }
      if (code >= 0x440 && code <= 0x44f) { out.push(code - 0x440 + 0xe0); continue; }
      if (code === 0x401) { out.push(0xf0); continue; } // Ё
      if (code === 0x451) { out.push(0xf1); continue; } // ё
      if (code === 0x2116) { out.push(0xfc); continue; } // №
    }

    out.push(0x3f); // '?' — нечитаемый символ лучше мусорного байта
  }
  return Buffer.from(out);
}

/** Сборщик потока ESC/POS. Текст и команды пишутся в один буфер по порядку. */
class EscPosBuilder {
  private chunks: Buffer[] = [];
  private plain: string[] = [];
  private readonly width: number;
  private readonly encoding: string;

  constructor(opts: RenderOptions = {}) {
    this.width = opts.paperWidth === 58 ? 32 : 48;
    this.encoding = opts.encoding || 'CP866';
    this.raw(ESC, 0x40); // инициализация
    this.raw(ESC, 0x74, CODEPAGE_COMMAND[this.encoding] ?? 17); // кодовая страница
  }

  get lineWidth(): number {
    return this.width;
  }

  raw(...bytes: number[]): this {
    this.chunks.push(Buffer.from(bytes));
    return this;
  }

  /** 0 — влево, 1 — центр, 2 — вправо */
  align(mode: 0 | 1 | 2): this {
    return this.raw(ESC, 0x61, mode);
  }

  bold(on: boolean): this {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }

  /** Множитель размера 1..4 по ширине и высоте */
  size(w: 1 | 2 | 3 | 4, h: 1 | 2 | 3 | 4): this {
    return this.raw(GS, 0x21, ((w - 1) << 4) | (h - 1));
  }

  text(line = ''): this {
    this.chunks.push(encodeText(line, this.encoding));
    this.plain.push(line);
    return this;
  }

  line(text = ''): this {
    this.text(text);
    this.chunks.push(Buffer.from([0x0a]));
    return this;
  }

  feed(n = 1): this {
    for (let i = 0; i < n; i++) this.line('');
    return this;
  }

  rule(char = '-'): this {
    return this.line(char.repeat(this.width));
  }

  /** Строка «слева ... справа» с выравниванием по ширине бумаги */
  columns(left: string, right: string): this {
    const space = Math.max(1, this.width - left.length - right.length);
    return this.line(left + ' '.repeat(space) + right);
  }

  cut(): this {
    // Отрез выполняется после подачи: без неё принтер режет по тексту.
    this.feed(4);
    return this.raw(GS, 0x56, 0x42, 0x00);
  }

  build(): { payload: Buffer; preview: string } {
    return { payload: Buffer.concat(this.chunks), preview: this.plain.join('\n') };
  }
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Moscow',
  });
}

function formatDateTime(d: Date): string {
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Moscow',
  });
}

/**
 * Кухонный бегунок: номер заказа крупно, состав, комментарии.
 * Ни цен, ни адресов — повару они не нужны, а место на бумаге нужно.
 */
export function renderKitchenTicket(order: RenderOrder, opts: RenderOptions = {}) {
  const b = new EscPosBuilder(opts);

  b.align(1);
  if (order.stationName) {
    b.bold(true).line(order.stationName.toUpperCase()).bold(false);
  }
  b.size(3, 3).bold(true).line(`#${order.orderNumber}`).bold(false).size(1, 1);

  const typeLabels: Record<string, string> = {
    delivery: 'ДОСТАВКА',
    pickup: 'САМОВЫВОЗ',
    'dine-in': 'В ЗАЛЕ',
    dine_in: 'В ЗАЛЕ',
  };
  if (order.orderType && typeLabels[order.orderType]) {
    b.size(2, 1).line(typeLabels[order.orderType]).size(1, 1);
  }

  b.line(formatTime(order.timestamp));
  b.rule();
  b.align(0).feed();

  for (const item of order.items) {
    b.size(2, 2).bold(true).line(`${item.quantity}x ${item.name.toUpperCase()}`).bold(false).size(1, 1);
    if (item.specialInstructions) {
      b.line(`  >>> ${item.specialInstructions}`);
    }
    b.feed();
  }

  b.rule();

  if (order.specialInstructions) {
    b.align(1).bold(true).line('КОММЕНТАРИЙ').bold(false);
    b.align(0).line(order.specialInstructions);
    b.rule();
  }

  b.cut();
  return b.build();
}

/** Чек гостю: позиции с ценами и итог. */
export function renderCustomerReceipt(order: RenderOrder, opts: RenderOptions = {}) {
  const b = new EscPosBuilder(opts);

  b.align(1);
  if (order.restaurant?.name) {
    b.bold(true).size(2, 2).line(order.restaurant.name).size(1, 1).bold(false);
  }
  if (order.restaurant?.address) b.line(order.restaurant.address);
  if (order.restaurant?.phone) b.line(order.restaurant.phone);
  b.feed();

  b.bold(true).size(2, 2).line(`Заказ № ${order.orderNumber}`).size(1, 1).bold(false);
  b.align(0);
  b.line(formatDateTime(order.timestamp));
  if (order.customer?.name) b.line(`Гость: ${order.customer.name}`);
  b.rule();

  let computed = 0;
  for (const item of order.items) {
    b.bold(true).line(item.name).bold(false);
    const price = item.price ?? 0;
    const sum = price * item.quantity;
    computed += sum;
    b.columns(`  ${item.quantity} x ${price.toFixed(2)}`, sum.toFixed(2));
    if (item.specialInstructions) b.line(`  >>> ${item.specialInstructions}`);
  }

  b.rule();
  // Итог берём из заказа, а не из суммы позиций: в total уже учтены
  // скидки, доставка и прочие начисления, посчитанные на сервере.
  const total = order.total ?? computed;
  b.bold(true).size(1, 2).columns('ИТОГО', total.toFixed(2)).size(1, 1).bold(false);
  b.rule();

  if (order.specialInstructions) {
    b.line('Комментарий к заказу:');
    b.line(order.specialInstructions);
    b.rule();
  }

  b.align(1).feed().line('Спасибо за заказ!');
  b.cut();
  return b.build();
}

/** Тестовый чек — им агент и станция проверяются после установки. */
export function renderTestTicket(label: string, opts: RenderOptions = {}) {
  const b = new EscPosBuilder(opts);

  b.align(1).bold(true).size(2, 2).line('ТЕСТ ПЕЧАТИ').size(1, 1).bold(false);
  b.rule();
  b.align(0);
  b.line(`Станция: ${label}`);
  b.line(`Время: ${formatDateTime(new Date())}`);
  b.line(`Ширина строки: ${b.lineWidth} симв.`);
  b.rule();
  b.align(1).line('Кириллица: ЁёАБВГДЯ абвгдя №1');
  b.line('Принтер работает');
  b.cut();
  return b.build();
}
