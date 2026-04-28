import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: '.',
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api':    { target: 'http://127.0.0.1:7777', changeOrigin: true },
      '/events': { target: 'http://127.0.0.1:7777', changeOrigin: true, ws: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
