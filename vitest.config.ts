import { defineConfig } from 'vitest/config';

defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});

export default defineConfig;
