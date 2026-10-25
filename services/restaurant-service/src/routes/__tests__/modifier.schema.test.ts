import { modifierSchema } from '../menu.routes';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

/** Короткая обёртка: только факт прохождения и текст ошибки. */
function check(body: any) {
  const { error } = modifierSchema.validate(body);
  return { ok: !error, message: error?.details[0].message };
}

describe('Схема модификатора — складская связь', () => {
  it('принимает модификатор без учёта (как было до миграции 034)', () => {
    // Старые модификаторы влияют только на цену — ломать их нельзя
    expect(check({ name: 'Трубочка', priceAdjustment: 0 }).ok).toBe(true);
  });

  it('принимает позицию склада с расходом', () => {
    expect(check({ name: 'Доп. сыр', inventoryItemId: UUID_A, quantity: 0.02 }).ok).toBe(true);
  });

  it('принимает техкарту с расходом', () => {
    expect(check({ name: 'Соус Цезарь', techCardId: UUID_A, quantity: 1 }).ok).toBe(true);
  });

  it('отвергает оба источника разом', () => {
    // Иначе один выбор в чеке списал бы и позицию, и всю рецептуру
    const r = check({ name: 'Оба', inventoryItemId: UUID_A, techCardId: UUID_B, quantity: 1 });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/не оба источника/);
  });

  it('отвергает позицию склада без расхода', () => {
    const r = check({ name: 'Сыр', inventoryItemId: UUID_A });
    expect(r.ok).toBe(false);
  });

  it('отвергает техкарту без расхода', () => {
    const r = check({ name: 'Соус', techCardId: UUID_A });
    expect(r.ok).toBe(false);
  });

  it('отвергает источник с расходом null', () => {
    // Ловушка: правило `with` считается выполненным при quantity: null,
    // и такой модификатор молча не списывал бы ничего.
    expect(check({ name: 'Сыр', inventoryItemId: UUID_A, quantity: null }).ok).toBe(false);
    expect(check({ name: 'Соус', techCardId: UUID_A, quantity: null }).ok).toBe(false);
  });

  it('отвергает нулевой и отрицательный расход', () => {
    expect(check({ name: 'Сыр', inventoryItemId: UUID_A, quantity: 0 }).ok).toBe(false);
    expect(check({ name: 'Сыр', inventoryItemId: UUID_A, quantity: -1 }).ok).toBe(false);
  });

  it('отвергает нечисловой расход', () => {
    expect(check({ name: 'Сыр', inventoryItemId: UUID_A, quantity: 'много' }).ok).toBe(false);
  });

  it('отвергает источник, который не UUID', () => {
    expect(check({ name: 'Сыр', inventoryItemId: '42', quantity: 1 }).ok).toBe(false);
  });
});
