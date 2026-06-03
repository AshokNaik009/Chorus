import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * electron-vite build for the three Electron targets. Entry points are
 * auto-detected at the conventional paths (src/main, src/preload, src/renderer).
 *
 * node-pty (and electron) stay external — native/runtime modules must not be
 * bundled — but the workspace source package @app/core IS bundled (its entry
 * points at TS source, which Node can't require). The renderer bundles
 * @app/ui + @app/core like the web harness.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@app/core'] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@app/core'] })],
  },
  renderer: {
    plugins: [react()],
  },
});
