import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发模式代理：与生产 nginx.conf 保持相同的同源路径约定。
// 生产环境所有外部请求均由 nginx 反向代理（见 nginx.conf），
// 浏览器 JS 一律请求同源 /api/ 路径，不直连外部域名。
// 说明：本地 dev 下 /api/ontology 无鉴权头注入（鉴权仅在部署侧 nginx 配置），
// 本体请求会以显式错误返回，应用按诚实降级策略处理。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api/wind': {
        target: 'https://api.open-meteo.com',
        changeOrigin: true,
        secure: false,
        rewrite: (p) => p.replace(/^\/api\/wind/, ''),
      },
      '/api/ontology': {
        target: 'http://ceshi.projects.bingosoft.net:8081',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/ontology/, ''),
      },
    },
  },
});
