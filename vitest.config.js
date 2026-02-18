const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/**/*.test.{js,mjs,ts}'],
          setupFiles: ['./tests/setup.ts'],
        },
      },
      {
        test: {
          name: 'frontend',
          environment: 'jsdom',
          include: ['tests/frontend/**/*.test.tsx'],
          setupFiles: ['./tests/setup.ts'],
        },
      },
    ],
  },
});
