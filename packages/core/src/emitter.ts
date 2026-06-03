import type { Disposable } from './pty.js';

/** Minimal dependency-free typed event emitter. */
export class Emitter<T> {
  private listeners = new Set<(payload: T) => void>();

  on(listener: (payload: T) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  emit(payload: T): void {
    for (const listener of [...this.listeners]) listener(payload);
  }

  clear(): void {
    this.listeners.clear();
  }
}
