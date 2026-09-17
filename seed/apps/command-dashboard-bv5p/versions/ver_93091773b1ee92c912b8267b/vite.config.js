import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 本地开发代理与生产 nginx.conf 同构（/api/noaa → NOAA CO-OPS，/api/jcg → JCG /TIDE/pred2）。
// 仅影响 npm run dev；vite build 完全离线，不依赖任何外部网络。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api/noaa': {
        target: 'https://api.tidesandcurrents.noaa.gov',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/noaa/, ''),
      },
      '/api/jcg': {
        target: 'https://www1.kaiho.mlit.go.jp',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/jcg/, '/TIDE/pred2'),
      },
    },
  },
});
