/**
 * frontend-service — обычный JS, без ts-jest: общий базовый конфиг здесь
 * не подходит (он ищет только *.test.ts через preset ts-jest).
 */
module.exports = {
  testEnvironment: 'node',
  rootDir: __dirname,
  testMatch: ['<rootDir>/__tests__/**/*.test.js'],
  clearMocks: true,
  testTimeout: 10000
};
