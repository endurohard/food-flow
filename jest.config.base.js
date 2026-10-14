const fs = require('fs');
const path = require('path');

/**
 * Общий конфиг jest для сервисов на TypeScript.
 *
 * Каждый сервис подключает его своим jest.config.js:
 *   module.exports = require('../../jest.config.base');
 *
 * Так настройки живут в одном месте, а не копируются по 16 сервисам.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // roots задаём только если src существует: у части сервисов код лежит
  // в корне, и жёсткий <rootDir>/src ронял jest с Validation Error.
  roots: fs.existsSync(path.join(process.cwd(), 'src')) ? ['<rootDir>/src'] : ['<rootDir>'],
  testMatch: ['**/*.test.ts', '**/*.spec.ts'],
  // dist/ — скомпилированный вывод, в нём тесты искать не нужно
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  clearMocks: true,
  // Тесты не должны молча висеть: БД и брокер в юнит-тестах замоканы
  testTimeout: 10000,
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      // Тесты не обязаны проходить строгую типизацию прода:
      // моки намеренно частичные, иначе каждый мок пришлось бы
      // дописывать до полного интерфейса pg.Pool.
      diagnostics: false
    }]
  }
};
