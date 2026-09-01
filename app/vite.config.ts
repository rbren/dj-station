/// <reference types="vitest/config" />
import { cpus } from 'node:os';
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
      '@tauri-apps/api': fileURLToPath(new URL('./node_modules/@tauri-apps/api', import.meta.url)),
    },
  },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: 'es2022' },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.tsx', 'tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    globals: true,
    // The Grid performance suite renders fifty-row arrangements over and
    // over, which pins every core on a small box. Suites that drive REAL
    // timers — the clip transport's audio polling above all — then miss
    // the ticks they are waiting on and fail for want of a timeslice
    // rather than for any fault in the code. So it does not run beside
    // them: `npm test` takes the main suite in parallel and then this
    // one on its own. Run directly, `vitest run` still includes it.
    poolOptions: { forks: { maxForks: Math.max(1, cpus().length - 1) } },
  },
});
