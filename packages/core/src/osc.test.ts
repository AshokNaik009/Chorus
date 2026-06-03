import { describe, expect, it } from 'vitest';
import {
  OscStatusScanner,
  buildClaudeHookSettings,
  formatStatusOsc,
  parseStatusPayload,
} from './osc';

const ESC = '\x1b';
const BEL = '\x07';

describe('parseStatusPayload', () => {
  it('parses valid payloads', () => {
    expect(parseStatusPayload('pane;status;waiting')).toBe('waiting');
    expect(parseStatusPayload('pane;status;idle')).toBe('idle');
    expect(parseStatusPayload('pane;status;running')).toBe('running');
  });

  it('rejects foreign namespaces / keys / values', () => {
    expect(parseStatusPayload('other;status;idle')).toBeNull();
    expect(parseStatusPayload('pane;mode;idle')).toBeNull();
    expect(parseStatusPayload('pane;status;bogus')).toBeNull();
    expect(parseStatusPayload('pane;status')).toBeNull();
  });
});

describe('formatStatusOsc round-trips through the scanner', () => {
  it('emits a sequence the scanner reads back', () => {
    const scanner = new OscStatusScanner();
    const { output, statuses } = scanner.push(formatStatusOsc('waiting'));
    expect(statuses).toEqual(['waiting']);
    expect(output).toBe('');
  });
});

describe('OscStatusScanner', () => {
  it('strips a complete sequence and surfaces the status', () => {
    const s = new OscStatusScanner();
    const r = s.push(`hello${ESC}]777;pane;status;idle${BEL}world`);
    expect(r.statuses).toEqual(['idle']);
    expect(r.output).toBe('helloworld');
  });

  it('accepts the ST terminator (ESC backslash)', () => {
    const s = new OscStatusScanner();
    const r = s.push(`${ESC}]777;pane;status;running${ESC}\\done`);
    expect(r.statuses).toEqual(['running']);
    expect(r.output).toBe('done');
  });

  it('passes other OSC sequences through untouched', () => {
    const s = new OscStatusScanner();
    const title = `${ESC}]0;my title${BEL}`;
    const r = s.push(`${title}plain`);
    expect(r.statuses).toEqual([]);
    expect(r.output).toBe(`${title}plain`);
  });

  it('passes CSI sequences through untouched', () => {
    const s = new OscStatusScanner();
    const r = s.push(`${ESC}[2J${ESC}[1;1Hhi`);
    expect(r.statuses).toEqual([]);
    expect(r.output).toBe(`${ESC}[2J${ESC}[1;1Hhi`);
  });

  it('reassembles a sequence split across chunks', () => {
    const s = new OscStatusScanner();
    const full = `before${ESC}]777;pane;status;waiting${BEL}after`;
    // split right in the middle of the payload
    const cut = full.indexOf('status');
    const a = s.push(full.slice(0, cut));
    const b = s.push(full.slice(cut));
    expect(a.statuses).toEqual([]);
    expect(b.statuses).toEqual(['waiting']);
    expect(a.output + b.output).toBe('beforeafter');
  });

  it('handles a split right at the ESC byte', () => {
    const s = new OscStatusScanner();
    const a = s.push(`x${ESC}`);
    const b = s.push(`]777;pane;status;idle${BEL}y`);
    expect(a.output).toBe('x'); // ESC held back as a potential start
    expect(b.statuses).toEqual(['idle']);
    expect(a.output + b.output).toBe('xy');
  });

  it('handles multiple sequences and a trailing partial in one chunk', () => {
    const s = new OscStatusScanner();
    const r1 = s.push(
      `${ESC}]777;pane;status;running${BEL}mid${ESC}]777;pane;status;waiting${BEL}tail${ESC}]777;pane`,
    );
    expect(r1.statuses).toEqual(['running', 'waiting']);
    expect(r1.output).toBe('midtail');
    const r2 = s.push(`;status;idle${BEL}end`);
    expect(r2.statuses).toEqual(['idle']);
    expect(r2.output).toBe('end');
  });
});

describe('buildClaudeHookSettings', () => {
  it('defines Notification (waiting) and Stop (idle) hooks to /dev/tty', () => {
    const s = buildClaudeHookSettings();
    const notif = s.hooks.Notification[0].hooks[0];
    const stop = s.hooks.Stop[0].hooks[0];
    expect(notif.type).toBe('command');
    expect(notif.command).toContain('pane;status;waiting');
    expect(notif.command).toContain('/dev/tty');
    expect(stop.command).toContain('pane;status;idle');
  });
});
