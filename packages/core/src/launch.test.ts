import { describe, expect, it } from 'vitest';
import { shellLaunchArgs } from './launch';

describe('shellLaunchArgs', () => {
  it('plain interactive shell -> no args (unix)', () => {
    expect(shellLaunchArgs(undefined, false)).toEqual([]);
  });

  it('unix command -> login + interactive + -c', () => {
    expect(shellLaunchArgs('claude', false)).toEqual([
      '-l',
      '-i',
      '-c',
      'claude',
    ]);
  });

  it('windows command -> pwsh -NoLogo -Command', () => {
    expect(shellLaunchArgs('claude', true)).toEqual([
      '-NoLogo',
      '-Command',
      'claude',
    ]);
  });

  it('windows plain shell -> no args', () => {
    expect(shellLaunchArgs(undefined, true)).toEqual([]);
  });
});
