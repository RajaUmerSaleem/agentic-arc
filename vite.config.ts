import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'process.env.FALLBACK_AI_API_KEY': JSON.stringify(env.FALLBACK_AI_API_KEY),
      'process.env.FALLBACK_AI_BASE_URL': JSON.stringify(env.FALLBACK_AI_BASE_URL),
      'process.env.FALLBACK_AI_MODEL': JSON.stringify(env.FALLBACK_AI_MODEL),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    publicDir: 'public',
    build: {
      rollupOptions: {
        input: {
          main: './index.html',
        },
      },
    },
    server: {
      port: parseInt(process.env.PORT || '3000', 10),
      hmr: process.env.DISABLE_HMR !== 'true' ? {
        port: parseInt(process.env.HMR_PORT || '24678', 10),
        clientPort: parseInt(process.env.HMR_CLIENT_PORT || '24678', 10),
      } : false,
    },
  };
});
