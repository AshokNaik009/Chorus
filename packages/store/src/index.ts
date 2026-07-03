/**
 * @app/store — the Node fs shell around @app/core's pure profile format.
 *
 * Hosts that run in Node (the Electron main process, the app-web dev server)
 * use FileTreeStore to persist WorkspaceState as a ~/.chorus file tree. The
 * browser never imports this package.
 */
export * from './file-store.js';
