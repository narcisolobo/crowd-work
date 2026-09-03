import { defineConfig } from 'vitest/config';

const config = defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
  },
});

export default config;
