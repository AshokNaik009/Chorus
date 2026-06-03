import { describe, expect, it } from 'vitest';
import {
  buildTemplate,
  collectSessionIds,
  countPanes,
  removePane,
  setSizesAtPath,
} from './layout';
import type { LayoutNode } from './models';

describe('buildTemplate', () => {
  it('1-pane is a single leaf', () => {
    const node = buildTemplate(1, ['a']);
    expect(node).toEqual({ type: 'pane', sessionId: 'a' });
  });

  it('2-pane is a single row split', () => {
    const node = buildTemplate(2, ['a', 'b']);
    expect(node).toEqual({
      type: 'split',
      direction: 'row',
      sizes: [50, 50],
      children: [
        { type: 'pane', sessionId: 'a' },
        { type: 'pane', sessionId: 'b' },
      ],
    });
  });

  it('4-pane is 2x2 nested splits with 4 leaves', () => {
    const node = buildTemplate(4, ['a', 'b', 'c', 'd']);
    expect(node.type).toBe('split');
    if (node.type !== 'split') throw new Error('unreachable');
    expect(node.direction).toBe('column');
    expect(node.children).toHaveLength(2);
    expect(collectSessionIds(node)).toEqual(['a', 'b', 'c', 'd']);
    expect(countPanes(node)).toBe(4);
  });

  it('3-pane is a row of three equal panes', () => {
    const node = buildTemplate(3, ['a', 'b', 'c']);
    if (node.type !== 'split') throw new Error('expected split');
    expect(node.direction).toBe('row');
    expect(node.children).toHaveLength(3);
    expect(collectSessionIds(node)).toEqual(['a', 'b', 'c']);
    expect(node.sizes.reduce((s, n) => s + n, 0)).toBeCloseTo(100);
  });

  it('6-pane is two rows of three (2x3)', () => {
    const node = buildTemplate(6, ['a', 'b', 'c', 'd', 'e', 'f']);
    if (node.type !== 'split') throw new Error('expected split');
    expect(node.direction).toBe('column');
    expect(node.children).toHaveLength(2);
    expect(countPanes(node)).toBe(6);
    expect(collectSessionIds(node)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('rejects a mismatched id count', () => {
    expect(() => buildTemplate(4, ['a', 'b'])).toThrow();
  });

  it('generates unique ids when none are passed', () => {
    const ids = collectSessionIds(buildTemplate(4));
    expect(new Set(ids).size).toBe(4);
  });
});

describe('removePane', () => {
  it('returns null when the only pane is removed', () => {
    expect(removePane(buildTemplate(1, ['a']), 'a')).toBeNull();
  });

  it('collapses a 2-split to its surviving leaf', () => {
    const node = buildTemplate(2, ['a', 'b']);
    expect(removePane(node, 'a')).toEqual({ type: 'pane', sessionId: 'b' });
  });

  it('collapses an inner split in a 4-grid and renormalizes', () => {
    const node = buildTemplate(4, ['a', 'b', 'c', 'd']);
    const next = removePane(node, 'b');
    expect(next).not.toBeNull();
    expect(collectSessionIds(next!)).toEqual(['a', 'c', 'd']);
    // top row collapsed to just 'a'; outer split keeps two children
    if (next!.type !== 'split') throw new Error('expected split');
    expect(next!.children[0]).toEqual({ type: 'pane', sessionId: 'a' });
    const sum = next!.sizes.reduce((s, n) => s + n, 0);
    expect(sum).toBeCloseTo(100);
  });

  it('does not mutate the input', () => {
    const node = buildTemplate(2, ['a', 'b']);
    const snapshot = JSON.parse(JSON.stringify(node)) as LayoutNode;
    removePane(node, 'a');
    expect(node).toEqual(snapshot);
  });
});

describe('setSizesAtPath', () => {
  it('sets root split sizes', () => {
    const node = buildTemplate(2, ['a', 'b']);
    const next = setSizesAtPath(node, [], [30, 70]);
    if (next.type !== 'split') throw new Error('expected split');
    expect(next.sizes).toEqual([30, 70]);
  });

  it('sets a nested split sizes by path immutably', () => {
    const node = buildTemplate(4, ['a', 'b', 'c', 'd']);
    const next = setSizesAtPath(node, [1], [20, 80]);
    if (next.type !== 'split') throw new Error('expected split');
    const bottomRow = next.children[1];
    if (bottomRow.type !== 'split') throw new Error('expected split');
    expect(bottomRow.sizes).toEqual([20, 80]);
    // original untouched
    if (node.children[1].type !== 'split') throw new Error('expected split');
    expect(node.children[1].sizes).toEqual([50, 50]);
  });

  it('is a no-op when the path does not land on a split', () => {
    const node = buildTemplate(1, ['a']);
    expect(setSizesAtPath(node, [0], [10, 90])).toEqual(node);
  });
});
