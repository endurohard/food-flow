import { menuItemSchema } from '../menu.routes';

/** Тело, которое шлёт форма блюда в menu.html при пустом описании. */
const frontBody = {
  name: 'Лунго',
  description: '',
  categoryId: undefined,
  price: 0,
  calories: undefined,
  preparationTime: undefined,
  isVegetarian: false,
  weightGrams: undefined,
  icon: 'coffee',
  iconColor: 'cream',
};

describe('Схема блюда — описание необязательно', () => {
  it('пустое описание из формы принимается', () => {
    expect(menuItemSchema.validate(frontBody).error).toBeUndefined();
  });

  it('без описания и с null тоже', () => {
    const { description: _d, ...rest } = frontBody;
    expect(menuItemSchema.validate(rest).error).toBeUndefined();
    expect(menuItemSchema.validate({ ...frontBody, description: null }).error).toBeUndefined();
  });

  it('слишком длинное описание по-прежнему отбивается', () => {
    expect(menuItemSchema.validate({ ...frontBody, description: 'x'.repeat(2001) }).error).toBeDefined();
  });
});
