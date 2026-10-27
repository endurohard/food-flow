import {
  renderKitchenTicket,
  renderCustomerReceipt,
  renderTestTicket,
  RenderOrder,
} from '../escpos-render.service';

/** Поиск последовательности байт в буфере — проверка команд ESC/POS. */
function hasBytes(buf: Buffer, bytes: number[]): boolean {
  return buf.includes(Buffer.from(bytes));
}

const order: RenderOrder = {
  orderNumber: '1042',
  restaurant: { name: 'Тестовая точка', address: 'ул. Ленина 1', phone: '+7 999 000-00-00' },
  customer: { name: 'Иван' },
  items: [
    { name: 'Борщ', quantity: 2, price: 350 },
    { name: 'Пельмени', quantity: 1, price: 420, specialInstructions: 'без лука' },
  ],
  total: 1120,
  orderType: 'dine-in',
  timestamp: new Date('2026-10-26T12:30:00Z'),
};

describe('escpos-render: кухонный бегунок', () => {
  it('инициализирует принтер и выставляет кодовую страницу', () => {
    const { payload } = renderKitchenTicket(order);
    // ESC @ — инициализация, должна быть первой
    expect(payload.subarray(0, 2)).toEqual(Buffer.from([0x1b, 0x40]));
    // ESC t 17 — кодовая страница CP866 для кириллицы
    expect(hasBytes(payload, [0x1b, 0x74, 17])).toBe(true);
  });

  it('содержит номер заказа и все позиции', () => {
    const { preview } = renderKitchenTicket(order);
    expect(preview).toContain('#1042');
    expect(preview).toContain('2x БОРЩ');
    expect(preview).toContain('1x ПЕЛЬМЕНИ');
  });

  it('печатает комментарий к позиции — без него повар готовит не то', () => {
    const { preview } = renderKitchenTicket(order);
    expect(preview).toContain('без лука');
  });

  it('не содержит цен и итога: повару они не нужны', () => {
    const { preview } = renderKitchenTicket(order);
    expect(preview).not.toContain('350');
    expect(preview).not.toContain('1120');
  });

  it('заканчивается командой отреза бумаги', () => {
    const { payload } = renderKitchenTicket(order);
    expect(hasBytes(payload, [0x1d, 0x56, 0x42, 0x00])).toBe(true);
  });

  it('подача бумаги идёт ДО отреза, иначе принтер режет по тексту', () => {
    const { payload } = renderKitchenTicket(order);
    const cutAt = payload.indexOf(Buffer.from([0x1d, 0x56, 0x42, 0x00]));
    expect(cutAt).toBeGreaterThan(0);
    // Нужны именно НЕСКОЛЬКО пустых строк: одиночный \n остаётся и без
    // подачи (его даёт последняя строка текста), поэтому такой ассерт
    // мутацию «отрез без подачи» не поймал бы.
    const tail = payload.subarray(cutAt - 4, cutAt);
    expect(tail).toEqual(Buffer.from([0x0a, 0x0a, 0x0a, 0x0a]));
  });

  it('кодирует кириллицу в однобайтовую CP866, а не в UTF-8', () => {
    const { payload } = renderKitchenTicket({
      ...order,
      items: [{ name: 'Борщ', quantity: 1 }],
    });
    // «Б» в CP866 = 0x81; в UTF-8 это была бы пара 0xD0 0x91
    expect(payload.includes(0x81)).toBe(true);
    expect(hasBytes(payload, [0xd0, 0x91])).toBe(false);
  });

  it('CP1251 даёт другие байты для той же буквы', () => {
    const { payload } = renderKitchenTicket(
      { ...order, items: [{ name: 'Б', quantity: 1 }] },
      { encoding: 'CP1251' },
    );
    expect(hasBytes(payload, [0x1b, 0x74, 46])).toBe(true);
    // «Б» в CP1251 = 0xC1
    expect(payload.includes(0xc1)).toBe(true);
  });

  it('пишет название станции, чтобы бегунок не перепутали цехами', () => {
    const { preview } = renderKitchenTicket({ ...order, stationName: 'Горячий цех' });
    expect(preview).toContain('ГОРЯЧИЙ ЦЕХ');
  });
});

describe('escpos-render: чек гостю', () => {
  it('содержит позиции с ценами и итог', () => {
    const { preview } = renderCustomerReceipt(order);
    expect(preview).toContain('Борщ');
    expect(preview).toContain('350.00');
    expect(preview).toContain('ИТОГО');
    expect(preview).toContain('1120.00');
  });

  it('берёт итог из заказа, а не из суммы позиций: в total учтены скидки', () => {
    // 2*350 + 1*420 = 1120, но сервер посчитал со скидкой
    const { preview } = renderCustomerReceipt({ ...order, total: 1000 });
    expect(preview).toContain('1000.00');
    expect(preview).not.toMatch(/ИТОГО\s+1120\.00/);
  });

  it('при отсутствии total считает сумму позиций, а не печатает пустоту', () => {
    const { total, ...rest } = order as any;
    const { preview } = renderCustomerReceipt(rest);
    expect(preview).toContain('1120.00');
  });

  it('узкая бумага 58 мм даёт более короткие строки, чем 80 мм', () => {
    const narrow = renderCustomerReceipt(order, { paperWidth: 58 });
    const wide = renderCustomerReceipt(order, { paperWidth: 80 });
    const longestNarrow = Math.max(...narrow.preview.split('\n').map((l) => l.length));
    const longestWide = Math.max(...wide.preview.split('\n').map((l) => l.length));
    expect(longestNarrow).toBeLessThan(longestWide);
    expect(longestNarrow).toBeLessThanOrEqual(32);
    expect(longestWide).toBeLessThanOrEqual(48);
  });
});

describe('escpos-render: тестовый чек', () => {
  it('называет станцию и содержит проверку кириллицы', () => {
    const { preview } = renderTestTicket('Горячий цех / Epson');
    expect(preview).toContain('ТЕСТ ПЕЧАТИ');
    expect(preview).toContain('Горячий цех / Epson');
    expect(preview).toContain('Кириллица');
  });
});
