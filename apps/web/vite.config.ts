import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Dev-only proxy target for the FastAPI service. Override with
// RUNDOWN_API_TARGET=http://127.0.0.1:8141 (or a local contract stub).
const apiTarget = process.env.RUNDOWN_API_TARGET ?? 'http://localhost:8000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Keep Vite's dep cache (and Vitest's, which nests under it) out of
  // node_modules so a linked/read-only install never receives writes.
  cacheDir: '.cache/vite',
  server: {
    port: 3000,
    proxy: {
      '/health': { target: apiTarget, changeOrigin: true },
      '/rundown': { target: apiTarget, changeOrigin: true },
      '/shows': { target: apiTarget, changeOrigin: true },
      '/inbox': { target: apiTarget, changeOrigin: true },
      '/feeds': { target: apiTarget, changeOrigin: true },
      '/preparation': { target: apiTarget, changeOrigin: true },
      '/reviews': { target: apiTarget, changeOrigin: true },
      '/research': { target: apiTarget, changeOrigin: true },
      '/retrieval': { target: apiTarget, changeOrigin: true },
      '/social-links': { target: apiTarget, changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
})
