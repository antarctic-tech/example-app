import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  base: './',
  plugins: [react(), basicSsl()],
  server: {
    host: '127.0.0.1',
    port: 5185,
    cors: true,
    proxy: { '/api': 'http://127.0.0.1:3351' },
  },
});
