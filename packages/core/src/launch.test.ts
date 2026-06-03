import { describe, expect, it } from 'vitest';
import { shellLaunchArgs, withClaudeHooks } from './launch';

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

describe('withClaudeHooks', () => {
  it('injects --settings for a claude command', () => {
    expect(withClaudeHooks('claude', '/tmp/h.json')).toBe(
      "claude --settings '/tmp/h.json'",
    );
  });

  it('preserves extra claude args', () => {
    expect(withClaudeHooks('claude --resume', '/tmp/h.json')).toBe(
      "claude --settings '/tmp/h.json' --resume",
    );
  });

  it('leaves non-claude commands and empty commands alone', () => {
    expect(withClaudeHooks('bash', '/tmp/h.json')).toBe('bash');
    expect(withClaudeHooks(undefined, '/tmp/h.json')).toBeUndefined();
    expect(withClaudeHooks('claudette', '/tmp/h.json')).toBe('claudette');
  });
});
