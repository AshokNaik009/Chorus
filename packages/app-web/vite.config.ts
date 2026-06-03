import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const WS_PORT = Number(process.env.PTY_WS_PORT ?? 3001);

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
  },
  define: {
    __PTY_WS_URL__: JSON.stringify(`ws://localhost:${WS_PORT}`),
  },
});
