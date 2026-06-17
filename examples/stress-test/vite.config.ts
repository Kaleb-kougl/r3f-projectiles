import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@k9kbdev/r3f-projectiles/patterns': resolve(__dirname, '../../src/patterns/index.ts'),
      '@k9kbdev/r3f-projectiles': resolve(__dirname, '../../src/index.ts'),
    },
  },
});
