import { tierDiscountsSchema } from '../crm.routes';

it('проценты по уровням: целые 0..100, известные уровни', () => {
  expect(tierDiscountsSchema.validate({ bronze: 3, silver: 5, gold: 10, platinum: 15 }).error).toBeUndefined();
  expect(tierDiscountsSchema.validate({}).error).toBeUndefined();
  for (const bad of [{ gold: 10.5 }, { gold: -1 }, { gold: 101 }, { vip: 5 }, { gold: 'десять' }]) {
    const { error } = tierDiscountsSchema.validate(bad);
    expect(error).toBeDefined();
  }
  expect(tierDiscountsSchema.validate({ gold: 10.5 }).error!.message).toBe('Скидка по уровню — целое число от 0 до 100');
});
