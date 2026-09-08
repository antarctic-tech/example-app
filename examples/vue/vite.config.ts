import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  base: './',
  plugins: [vue(), basicSsl()],
  server: {
    host: '127.0.0.1',
    port: 5184,
    cors: true,
    proxy: { '/api': 'http://127.0.0.1:3351' },
  },
});
