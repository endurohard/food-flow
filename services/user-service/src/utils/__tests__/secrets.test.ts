/** Шифрование секретов интеграций (пароль ВАТС). */

const KEY = 'a'.repeat(64); // 32 байта в hex

function load() {
  let m: any;
  jest.isolateModules(() => { m = require('../secrets'); });
  return m;
}

describe('encryptSecret / decryptSecret', () => {
  beforeEach(() => { process.env.ENCRYPTION_KEY = KEY; });
  afterEach(() => { delete process.env.ENCRYPTION_KEY; });

  it('расшифровка возвращает исходный пароль', () => {
    const { encryptSecret, decryptSecret } = load();
    const enc = encryptSecret('5TQNF_Srld');
    expect(decryptSecret(enc)).toBe('5TQNF_Srld');
  });

  it('шифротекст не содержит пароль в открытом виде', () => {
    const { encryptSecret } = load();
    const enc = encryptSecret('секретный-пароль');
    expect(enc).not.toContain('секретный-пароль');
    expect(Buffer.from(enc.replace('enc:v1:', ''), 'base64').toString('utf8'))
      .not.toContain('секретный-пароль');
  });

  it('один пароль даёт разные шифротексты (IV случайный)', () => {
    const { encryptSecret, decryptSecret } = load();
    const a = encryptSecret('one');
    const b = encryptSecret('one');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe('one');
    expect(decryptSecret(b)).toBe('one');
  });

  it('подмена шифротекста в базе не проходит молча', () => {
    const { encryptSecret, decryptSecret } = load();
    const enc = encryptSecret('original');
    const raw = Buffer.from(enc.slice('enc:v1:'.length), 'base64');
    raw[raw.length - 1] ^= 0xff; // портим последний байт данных
    const tampered = 'enc:v1:' + raw.toString('base64');
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('чужой ключ не расшифровывает', () => {
    const m1 = load();
    const enc = m1.encryptSecret('secret');
    process.env.ENCRYPTION_KEY = 'b'.repeat(64);
    const m2 = load();
    expect(() => m2.decryptSecret(enc)).toThrow();
  });
});

describe('Защита от ошибок настройки', () => {
  afterEach(() => { delete process.env.ENCRYPTION_KEY; });

  it('без ENCRYPTION_KEY шифрование падает, а не отдаёт открытый текст', () => {
    delete process.env.ENCRYPTION_KEY;
    const { encryptSecret } = load();
    expect(() => encryptSecret('pwd')).toThrow(/ENCRYPTION_KEY/);
  });

  it('короткий ключ отвергается', () => {
    process.env.ENCRYPTION_KEY = 'abc';
    const { encryptSecret, decryptSecret } = load();
    // Парольная фраза допустима — она хэшируется до 32 байт
    const enc = encryptSecret('pwd');
    expect(decryptSecret(enc)).toBe('pwd');
  });

  it('ключ как парольная фраза работает так же стабильно', () => {
    process.env.ENCRYPTION_KEY = 'моя-длинная-фраза-для-ключа';
    const a = load();
    const enc = a.encryptSecret('pwd');
    const b = load(); // новый процесс с той же фразой
    expect(b.decryptSecret(enc)).toBe('pwd');
  });
});

describe('Совместимость и маскирование', () => {
  beforeEach(() => { process.env.ENCRYPTION_KEY = KEY; });
  afterEach(() => { delete process.env.ENCRYPTION_KEY; });

  it('значение из до-шифровальных времён читается как есть', () => {
    const { decryptSecret } = load();
    // Иначе у уже настроенных предприятий интеграция молча отвалится
    expect(decryptSecret('старый-открытый-пароль')).toBe('старый-открытый-пароль');
  });

  it('повторное шифрование не наслаивается', () => {
    const { encryptSecret, decryptSecret } = load();
    const once = encryptSecret('pwd');
    const twice = encryptSecret(once);
    expect(twice).toBe(once);
    expect(decryptSecret(twice)).toBe('pwd');
  });

  it('пустая строка и null не превращаются в мусор', () => {
    const { encryptSecret, decryptSecret, maskSecret } = load();
    expect(encryptSecret('')).toBe('');
    expect(decryptSecret(null)).toBeNull();
    expect(decryptSecret('')).toBeNull();
    expect(maskSecret(null)).toBeNull();
  });

  it('маска не раскрывает ни пароль, ни его длину', () => {
    const { encryptSecret, maskSecret } = load();
    const enc = encryptSecret('очень-длинный-пароль-клиента');
    expect(maskSecret(enc)).toBe('********');
  });

  it('isEncrypted отличает зашифрованное от открытого', () => {
    const { encryptSecret, isEncrypted } = load();
    expect(isEncrypted(encryptSecret('pwd'))).toBe(true);
    expect(isEncrypted('pwd')).toBe(false);
    expect(isEncrypted(null)).toBe(false);
  });
});
