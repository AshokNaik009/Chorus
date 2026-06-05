import { Allotment } from 'allotment';
import 'allotment/dist/style.css';
import type { LayoutNode } from '@app/core';
import type { ReactNode } from 'react';

export interface LayoutViewProps {
  node: LayoutNode;
  /** Render a leaf pane for a session id. */
  renderPane: (sessionId: string) => ReactNode;
  /** Called when a split's sashes are dragged. `path` locates the split. */
  onSizes: (path: number[], sizes: number[]) => void;
  path?: number[];
}

function childKey(child: LayoutNode, index: number, path: number[]): string {
  return child.type === 'pane'
    ? `pane:${child.sessionId}`
    : `split:${[...path, index].join('.')}`;
}

/**
 * Renders a LayoutNode tree as nested allotment splits (VS Code-style sashes).
 * Arbitrary nesting supports the layout templates and future 6/8/16 grids.
 * See PRD US-3.1 / US-3.2.
 */
export function LayoutView({
  node,
  renderPane,
  onSizes,
  path = [],
}: LayoutViewProps) {
  if (node.type === 'pane') {
    return <>{renderPane(node.sessionId)}</>;
  }

  // Key the Allotment by its structure (direction + child identities), NOT its
  // sizes. Allotment cannot reconcile a changed pane count in place — switching
  // layout templates (e.g. 1×2 → 1×3) makes it loop in componentDidUpdate
  // ("Maximum update depth exceeded"). A structure key remounts it cleanly on a
  // template change, while sash drags (same structure) keep the same key and
  // don't remount.
  const structureKey = `${node.direction}|${node.children
    .map((child, i) => childKey(child, i, path))
    .join(',')}`;

  return (
    <Allotment
      key={structureKey}
      vertical={node.direction === 'column'}
      defaultSizes={node.sizes}
      onChange={(sizes) => onSizes(path, sizes)}
    >
      {node.children.map((child, i) => (
        <Allotment.Pane key={childKey(child, i, path)}>
          <LayoutView
            node={child}
            renderPane={renderPane}
            onSizes={onSizes}
            path={[...path, i]}
          />
        </Allotment.Pane>
      ))}
    </Allotment>
  );
}
