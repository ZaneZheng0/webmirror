import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const directory = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@webmirror/capture': resolve(directory, '../../packages/capture/src/index.ts'),
      '@webmirror/shared': resolve(directory, '../../packages/shared/src/index.ts'),
    },
  },
  build: {
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(directory, 'src/background.ts'),
        popup: resolve(directory, 'popup.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
    sourcemap: true,
  },
});
