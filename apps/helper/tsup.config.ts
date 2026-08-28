import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  platform: 'node',
  target: 'node24',
  clean: true,
  splitting: false,
  sourcemap: true,
  noExternal: [/^(?!playwright(?:-core)?$).*/],
  external: ['playwright', 'playwright-core'],
  outExtension: () => ({ js: '.cjs' }),
});
