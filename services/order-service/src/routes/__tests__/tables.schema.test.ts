import { createTableSchema, updateTableSchema } from '../tables';

const REST = '22222222-2222-4222-8222-222222222222';

describe('схема POST /api/tables', () => {
  it('принимает тело, которое шлёт экран «Столы» (restaurantId в теле, номер числом)', () => {
    // Регресс: restaurantId не был описан в схеме → каждый POST получал 400
    const { error, value } = createTableSchema.validate({ restaurantId: REST, tableNumber: 3, section: 'main', seats: 2 });
    expect(error).toBeUndefined();
    expect(value.tableNumber).toBe('3');
  });

  it('номер строкой тоже годится', () => {
    expect(createTableSchema.validate({ restaurantId: REST, tableNumber: 'Б-3' }).error).toBeUndefined();
  });

  it('без точки и без номера — ошибка', () => {
    expect(createTableSchema.validate({ tableNumber: 1 }).error).toBeDefined();
    expect(createTableSchema.validate({ restaurantId: REST }).error).toBeDefined();
  });

  it('ноль мест не принимается', () => {
    expect(createTableSchema.validate({ restaurantId: REST, tableNumber: 1, seats: 0 }).error).toBeDefined();
  });
});

describe('схема PUT /api/tables/:id', () => {
  it('принимает статус, места и номер', () => {
    expect(updateTableSchema.validate({ status: 'occupied', seats: 4, tableNumber: 2 }).error).toBeUndefined();
  });

  it('неизвестный статус отвергается', () => {
    expect(updateTableSchema.validate({ status: 'broken' }).error).toBeDefined();
  });

  it('пустое тело отвергается', () => {
    expect(updateTableSchema.validate({}).error).toBeDefined();
  });
});
