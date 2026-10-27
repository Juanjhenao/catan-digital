import { defineConfig } from 'vite';

export default defineConfig({
  // Rutas relativas: el mismo build sirve desde la raiz (servidor de red local)
  // y desde una subcarpeta (GitHub Pages, /catan-digital/).
  base: './',
  server: { port: 5173, open: true },
  build: { target: 'es2022', outDir: 'dist' },
});
