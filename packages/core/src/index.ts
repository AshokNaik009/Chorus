/**
 * @app/core — framework-agnostic domain layer.
 *
 * Owns the models, the swappable seams (PtyBackend, Persistence), the pure
 * status reducer, and the SessionManager. Depends on nothing.
 */
export * from './models.js';
export * from './pty.js';
export * from './persistence.js';
export * from './status.js';
export * from './layout.js';
export * from './emitter.js';
export * from './session-manager.js';
