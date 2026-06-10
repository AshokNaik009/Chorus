import type { LayoutNode } from './models.js';

/** Layout templates. 1/2/4 from the PRD; 3 and 6 added for more sessions. */
export type LayoutTemplate = 1 | 2 | 3 | 4 | 6;

/** Equal-percentage sizes that sum to 100, last bucket absorbing rounding. */
function equalSizes(n: number): number[] {
  const base = Math.floor((100 / n) * 100) / 100;
  const sizes = Array.from({ length: n }, () => base);
  sizes[n - 1] = Math.round((100 - base * (n - 1)) * 100) / 100;
  return sizes;
}

function rowOf(ids: string[]): LayoutNode {
  return {
    type: 'split',
    direction: 'row',
    sizes: equalSizes(ids.length),
    children: ids.map(pane),
  };
}

let idCounter = 0;

/** Generate a process-unique session id without any platform globals. */
export function createSessionId(): string {
  idCounter += 1;
  return `s-${Date.now().toString(36)}-${idCounter}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function pane(sessionId: string): LayoutNode {
  return { type: 'pane', sessionId };
}

/**
 * Build a layout tree for a template. See PRD US-3.1:
 * - 1 pane: a single leaf
 * - 2 panes: a single row split (side by side)
 * - 4 panes: 2x2 nested splits (two stacked rows, each split in two)
 */
export function buildTemplate(
  template: LayoutTemplate,
  ids: string[] = Array.from({ length: template }, () => createSessionId()),
): LayoutNode {
  if (ids.length !== template) {
    throw new Error(`buildTemplate(${template}) needs ${template} ids`);
  }
  switch (template) {
    case 1:
      return pane(ids[0]);
    case 2:
      return rowOf([ids[0], ids[1]]);
    case 3:
      return rowOf([ids[0], ids[1], ids[2]]);
    case 4:
      return {
        type: 'split',
        direction: 'column',
        sizes: [50, 50],
        children: [
          rowOf([ids[0], ids[1]]),
          rowOf([ids[2], ids[3]]),
        ],
      };
    case 6:
      return {
        type: 'split',
        direction: 'column',
        sizes: [50, 50],
        children: [
          rowOf([ids[0], ids[1], ids[2]]),
          rowOf([ids[3], ids[4], ids[5]]),
        ],
      };
  }
}

/**
 * Build a single-row layout of N panes from explicit ids (1 → a lone pane).
 * Used by swarm fan-out, where N is the member count (PRD Epic 10), not a fixed
 * template. Pure.
 */
export function buildRow(ids: string[]): LayoutNode {
  if (ids.length === 0) throw new Error('buildRow needs at least one id');
  return ids.length === 1 ? pane(ids[0]) : rowOf(ids);
}

/**
 * Build a balanced grid for an arbitrary pane count (the simplified "how many
 * terminals?" picker). Up to 3 panes go in one row; 4+ wrap into stacked rows of
 * roughly equal width (e.g. 5 → a row of 3 over a row of 2, 6 → 2×3). Generates
 * fresh ids when none are given. Pure.
 */
export function buildGrid(
  count: number,
  ids: string[] = Array.from({ length: count }, () => createSessionId()),
): LayoutNode {
  if (ids.length === 0) throw new Error('buildGrid needs at least one id');
  if (ids.length === 1) return pane(ids[0]);
  if (ids.length <= 3) return rowOf(ids);
  const cols = Math.ceil(Math.sqrt(ids.length));
  const rows = Math.ceil(ids.length / cols);
  const children: LayoutNode[] = [];
  for (let r = 0; r < rows; r++) {
    const slice = ids.slice(r * cols, r * cols + cols);
    if (slice.length > 0) children.push(buildRow(slice));
  }
  return {
    type: 'split',
    direction: 'column',
    sizes: equalSizes(children.length),
    children,
  };
}

/** Structural validation of an untrusted layout tree (for loading state). */
export function isLayoutNode(value: unknown): value is LayoutNode {
  if (!value || typeof value !== 'object') return false;
  const node = value as Record<string, unknown>;
  if (node.type === 'pane') return typeof node.sessionId === 'string';
  if (node.type === 'split') {
    return (
      (node.direction === 'row' || node.direction === 'column') &&
      Array.isArray(node.sizes) &&
      node.sizes.every((n) => typeof n === 'number') &&
      Array.isArray(node.children) &&
      node.children.length > 0 &&
      node.children.every(isLayoutNode)
    );
  }
  return false;
}

/** All pane session ids, left-to-right / top-to-bottom. */
export function collectSessionIds(node: LayoutNode): string[] {
  if (node.type === 'pane') return [node.sessionId];
  return node.children.flatMap(collectSessionIds);
}

/** Count leaf panes. */
export function countPanes(node: LayoutNode): number {
  return collectSessionIds(node).length;
}

/**
 * Remove a pane by session id, collapsing any split left with a single child
 * and renormalizing sibling sizes. Returns the new tree, or null if the tree
 * becomes empty. Pure — never mutates the input.
 */
export function removePane(
  node: LayoutNode,
  sessionId: string,
): LayoutNode | null {
  if (node.type === 'pane') {
    return node.sessionId === sessionId ? null : node;
  }

  const kept: { child: LayoutNode; size: number }[] = [];
  node.children.forEach((child, i) => {
    const next = removePane(child, sessionId);
    if (next) {
      kept.push({
        child: next,
        size: node.sizes[i] ?? 100 / node.children.length,
      });
    }
  });

  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0].child;

  const total = kept.reduce((sum, k) => sum + k.size, 0) || 1;
  return {
    type: 'split',
    direction: node.direction,
    children: kept.map((k) => k.child),
    sizes: kept.map((k) => (k.size / total) * 100),
  };
}

/**
 * Immutably write a split node's `sizes`, located by a path of child indices
 * from the root (root split = []). Used to reflect sash drags back into the
 * layout tree (US-3.2). No-op if the path does not land on a split.
 */
export function setSizesAtPath(
  node: LayoutNode,
  path: number[],
  sizes: number[],
): LayoutNode {
  if (node.type !== 'split') return node;
  if (path.length === 0) {
    return { ...node, sizes: [...sizes] };
  }
  const [index, ...rest] = path;
  return {
    ...node,
    children: node.children.map((child, i) =>
      i === index ? setSizesAtPath(child, rest, sizes) : child,
    ),
  };
}
