import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const ontologyHeaders = Object.fromEntries(
  Object.entries({
    Authorization: process.env.ONTOLOGY_AUTH_TOKEN ? `Bearer ${process.env.ONTOLOGY_AUTH_TOKEN}` : undefined,
    Spaceid: process.env.ONTOLOGY_SPACE_ID,
    scopeType: process.env.ONTOLOGY_SCOPE_TYPE || 'Space',
    'Content-Type': 'application/json',
  }).filter(([, value]) => value)
);

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/ontology': {
        target: 'http://ceshi.projects.bingosoft.net:8081',
        changeOrigin: true,
        headers: ontologyHeaders,
        rewrite: (path) => path.replace(/^\/api\/ontology/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
