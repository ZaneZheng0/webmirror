import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const directory = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@webmirror/capture': resolve(directory, 'packages/capture/src/index.ts'),
      '@webmirror/mirror': resolve(directory, 'packages/mirror/src/index.ts'),
      '@webmirror/shared': resolve(directory, 'packages/shared/src/index.ts'),
      '@webmirror/validation': resolve(directory, 'packages/validation/src/index.ts'),
    },
  },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
    },
    include: [
      'apps/**/*.test.ts',
      'packages/**/*.test.ts',
      'fixtures/**/*.test.ts',
      'scripts/**/*.test.mjs',
    ],
    passWithNoTests: false,
  },
});
