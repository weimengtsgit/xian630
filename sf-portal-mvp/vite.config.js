import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3001,
    proxy: {
      // 本地开发默认走同源 /api，避免 Chrome/扩展直接拦截 8787 端口请求。
      '/api': 'http://127.0.0.1:8787',
    },
  }
})
