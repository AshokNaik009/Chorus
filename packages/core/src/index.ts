/**
 * @app/core — framework-agnostic domain layer.
 *
 * Owns the models, the swappable seams (PtyBackend, Persistence), and (from M1)
 * the pure status reducer and SessionManager. Depends on nothing.
 */
export * from './models.js';
export * from './pty.js';
export * from './persistence.js';
