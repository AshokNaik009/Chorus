import { describe, expect, it } from 'vitest';
import { buildClaudeLaunch, shellLaunchArgs, withClaudeHooks } from './launch';

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

describe('buildClaudeLaunch session identity', () => {
  it('pins a NEW conversation with --session-id', () => {
    expect(buildClaudeLaunch({ sessionId: 'uuid-1' })).toBe(
      "claude --session-id 'uuid-1'",
    );
  });

  it('--resume keeps the saved id and wins over sessionId', () => {
    expect(
      buildClaudeLaunch({ resumeSessionId: 'old', sessionId: 'ignored' }),
    ).toBe("claude --resume 'old'");
  });

  it('forkSession adds --fork-session to a resume (live-collision import)', () => {
    expect(buildClaudeLaunch({ resumeSessionId: 'old', forkSession: true })).toBe(
      "claude --resume 'old' --fork-session",
    );
  });

  it('forkSession without resume is a no-op', () => {
    expect(buildClaudeLaunch({ forkSession: true })).toBe('claude');
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
