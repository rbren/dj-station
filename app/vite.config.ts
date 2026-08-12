/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The camera extension's ui-src lives outside the app root, so
      // node-module resolution walking up from it misses app/node_modules.
      '@mediapipe/tasks-vision': fileURLToPath(
        new URL('./node_modules/@mediapipe/tasks-vision', import.meta.url),
      ),
      '@tauri-apps/api': fileURLToPath(
        new URL('./node_modules/@tauri-apps/api', import.meta.url),
      ),
    },
  },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: 'es2022' },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.tsx', 'tests/**/*.test.ts'],
    globals: true,
  },
});
