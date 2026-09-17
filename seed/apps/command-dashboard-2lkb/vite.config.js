import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 静态自包含应用：产物 dist/index.html，可被 nginx 直接托管
export default defineConfig({
  plugins: [react()],
  base: './',
});
