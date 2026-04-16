/**
 * Tile layout tree for the `/tiles` route.
 *
 * Invariants:
 *   - Root is null, a TerminalNode, or a horizontal SplitNode (columns).
 *   - Each horizontal-split child is either a TerminalNode or a vertical SplitNode.
 *   - Vertical splits contain only TerminalNode children (flat top/bottom stack).
 *
 * This gives at most two levels of nesting: columns at the root, optional
 * vertical stacks within a column. It matches wiz-term's behavior and
 * prevents horizontal-in-vertical nesting.
 */

export type SplitDirection = "horizontal" | "vertical";

export interface TerminalNode {
  type: "terminal";
  id: string;
  sessionId: string;
}

export interface SplitNode {
  type: "split";
  id: string;
  direction: SplitDirection;
  children: TileNode[];
  sizes: number[]; // percentages summing to 100
}

export type TileNode = TerminalNode | SplitNode;

export interface TileLayout {
  root: TileNode | null;
  version: number;
}

const LAYOUT_VERSION = 1;

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}

function equalShares(n: number): number[] {
  const share = 100 / n;
  return Array.from({ length: n }, () => share);
}

function terminal(sessionId: string): TerminalNode {
  return { type: "terminal", id: newId(), sessionId };
}

function clone(node: TileNode): TileNode {
  if (node.type === "terminal") return { ...node };
  return {
    ...node,
    children: node.children.map(clone),
    sizes: [...node.sizes],
  };
}

export function createEmptyLayout(): TileLayout {
  return { root: null, version: LAYOUT_VERSION };
}

export function createLayoutWithTerminal(sessionId: string): TileLayout {
  return { root: terminal(sessionId), version: LAYOUT_VERSION };
}

// ── Search helpers ───────────────────────────────────────────────────────────

export function findNodeById(layout: TileLayout, nodeId: string): TileNode | null {
  function walk(node: TileNode): TileNode | null {
    if (node.id === nodeId) return node;
    if (node.type === "split") {
      for (const c of node.children) {
        const hit = walk(c);
        if (hit) return hit;
      }
    }
    return null;
  }
  return layout.root ? walk(layout.root) : null;
}

export function findNodeBySessionId(layout: TileLayout, sessionId: string): TerminalNode | null {
  function walk(node: TileNode): TerminalNode | null {
    if (node.type === "terminal" && node.sessionId === sessionId) return node;
    if (node.type === "split") {
      for (const c of node.children) {
        const hit = walk(c);
        if (hit) return hit;
      }
    }
    return null;
  }
  return layout.root ? walk(layout.root) : null;
}

export function getAllSessionIds(layout: TileLayout): string[] {
  const ids: string[] = [];
  function walk(node: TileNode) {
    if (node.type === "terminal") ids.push(node.sessionId);
    else node.children.forEach(walk);
  }
  if (layout.root) walk(layout.root);
  return ids;
}

export function getFirstTerminal(layout: TileLayout): TerminalNode | null {
  function walk(node: TileNode): TerminalNode | null {
    if (node.type === "terminal") return node;
    for (const c of node.children) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  }
  return layout.root ? walk(layout.root) : null;
}

/** Returns the id of the top-level column containing nodeId, or null. */
export function findColumnOf(layout: TileLayout, nodeId: string): string | null {
  if (!layout.root) return null;
  if (layout.root.type === "terminal") {
    return layout.root.id === nodeId ? layout.root.id : null;
  }
  // root is horizontal split
  for (const col of layout.root.children) {
    if (col.id === nodeId) return col.id;
    if (col.type === "split") {
      if (col.children.some((c) => c.id === nodeId)) return col.id;
    }
  }
  return null;
}

// ── Mutations ────────────────────────────────────────────────────────────────

/** Prepend a new terminal as the leftmost full-height column. */
export function insertAtStart(layout: TileLayout, sessionId: string): TileLayout {
  const leaf = terminal(sessionId);

  if (!layout.root) {
    return { root: leaf, version: layout.version };
  }

  // Single-terminal root → wrap in horizontal split with new one at front.
  if (layout.root.type === "terminal") {
    return {
      root: {
        type: "split",
        id: newId(),
        direction: "horizontal",
        children: [leaf, clone(layout.root)],
        sizes: equalShares(2),
      },
      version: layout.version,
    };
  }

  // Root is a horizontal split — prepend to children.
  const next: SplitNode = {
    ...layout.root,
    children: [leaf, ...layout.root.children.map(clone)],
    sizes: equalShares(layout.root.children.length + 1),
  };
  return { root: next, version: layout.version };
}

/** Append a new terminal as the rightmost full-height column. */
export function insertAtEnd(layout: TileLayout, sessionId: string): TileLayout {
  const leaf = terminal(sessionId);

  if (!layout.root) {
    return { root: leaf, version: layout.version };
  }

  if (layout.root.type === "terminal") {
    return {
      root: {
        type: "split",
        id: newId(),
        direction: "horizontal",
        children: [clone(layout.root), leaf],
        sizes: equalShares(2),
      },
      version: layout.version,
    };
  }

  const next: SplitNode = {
    ...layout.root,
    children: [...layout.root.children.map(clone), leaf],
    sizes: equalShares(layout.root.children.length + 1),
  };
  return { root: next, version: layout.version };
}

/** Insert a new column immediately after the column containing targetNodeId. */
export function insertAfterColumn(
  layout: TileLayout,
  targetNodeId: string,
  sessionId: string,
): TileLayout {
  if (!layout.root) return createLayoutWithTerminal(sessionId);
  const leaf = terminal(sessionId);

  if (layout.root.type === "terminal") {
    // Only column — wrap in horizontal split with new one on the right.
    if (layout.root.id !== targetNodeId) return layout;
    return {
      root: {
        type: "split",
        id: newId(),
        direction: "horizontal",
        children: [clone(layout.root), leaf],
        sizes: equalShares(2),
      },
      version: layout.version,
    };
  }

  const columnIndex = indexOfColumnContaining(layout.root, targetNodeId);
  if (columnIndex < 0) return layout;

  const next: SplitNode = {
    ...layout.root,
    children: layout.root.children
      .map(clone)
      .flatMap((c, i) => (i === columnIndex ? [c, leaf] : [c])),
    sizes: equalShares(layout.root.children.length + 1),
  };
  return { root: next, version: layout.version };
}

function indexOfColumnContaining(root: SplitNode, nodeId: string): number {
  for (let i = 0; i < root.children.length; i++) {
    const c = root.children[i];
    if (c.id === nodeId) return i;
    if (c.type === "split" && c.children.some((cc) => cc.id === nodeId)) return i;
  }
  return -1;
}

/** Insert a new column immediately before the column containing targetNodeId. */
export function insertBeforeColumn(
  layout: TileLayout,
  targetNodeId: string,
  sessionId: string,
): TileLayout {
  if (!layout.root) return createLayoutWithTerminal(sessionId);
  const leaf = terminal(sessionId);

  if (layout.root.type === "terminal") {
    if (layout.root.id !== targetNodeId) return layout;
    return {
      root: {
        type: "split",
        id: newId(),
        direction: "horizontal",
        children: [leaf, clone(layout.root)],
        sizes: equalShares(2),
      },
      version: layout.version,
    };
  }

  const columnIndex = indexOfColumnContaining(layout.root, targetNodeId);
  if (columnIndex < 0) return layout;

  const next: SplitNode = {
    ...layout.root,
    children: layout.root.children
      .map(clone)
      .flatMap((c, i) => (i === columnIndex ? [leaf, c] : [c])),
    sizes: equalShares(layout.root.children.length + 1),
  };
  return { root: next, version: layout.version };
}

/** Insert a new terminal at the top of the column containing targetNodeId.
 *  Promotes a lone-terminal column to a vertical stack as needed. */
export function insertAtColumnTop(
  layout: TileLayout,
  targetNodeId: string,
  sessionId: string,
): TileLayout {
  return insertIntoColumn(layout, targetNodeId, sessionId, "top");
}

/** Insert a new terminal at the bottom of the column containing targetNodeId. */
export function insertAtColumnBottom(
  layout: TileLayout,
  targetNodeId: string,
  sessionId: string,
): TileLayout {
  return insertIntoColumn(layout, targetNodeId, sessionId, "bottom");
}

function insertIntoColumn(
  layout: TileLayout,
  targetNodeId: string,
  sessionId: string,
  edge: "top" | "bottom",
): TileLayout {
  if (!layout.root) return createLayoutWithTerminal(sessionId);
  const leaf = terminal(sessionId);

  function wrapTerminalCol(col: TerminalNode): SplitNode {
    const kids = edge === "top" ? [leaf, clone(col)] : [clone(col), leaf];
    return {
      type: "split",
      id: newId(),
      direction: "vertical",
      children: kids,
      sizes: equalShares(2),
    };
  }

  function extendVerticalCol(col: SplitNode): SplitNode {
    const kids = col.children.map(clone);
    if (edge === "top") kids.unshift(leaf);
    else kids.push(leaf);
    return { ...col, children: kids, sizes: equalShares(kids.length) };
  }

  // Root is a lone terminal — either matches the target or we no-op.
  if (layout.root.type === "terminal") {
    if (layout.root.id !== targetNodeId) return layout;
    return { root: wrapTerminalCol(layout.root), version: layout.version };
  }

  // Root is a vertical split (single-column layout with a stack).
  if (layout.root.direction === "vertical") {
    if (indexOfColumnContaining(layout.root, targetNodeId) < 0 && layout.root.id !== targetNodeId) {
      return layout;
    }
    return { root: extendVerticalCol(layout.root), version: layout.version };
  }

  // Root is horizontal split — rewrite the matching column.
  const root = layout.root;
  const columnIndex = indexOfColumnContaining(root, targetNodeId);
  if (columnIndex < 0) return layout;
  const children = root.children.map((col, i): TileNode => {
    if (i !== columnIndex) return clone(col);
    if (col.type === "terminal") return wrapTerminalCol(col);
    if (col.type === "split" && col.direction === "vertical") return extendVerticalCol(col);
    return clone(col);
  });
  return { root: { ...root, children, sizes: [...root.sizes] }, version: layout.version };
}

export type DropZone = "left" | "right" | "top" | "bottom";

/**
 * Move a pane (terminal leaf) to a drop zone relative to a target node.
 * The source is removed from its current location (collapsing splits that
 * end up with one child), then reinserted:
 *   - left/right: as a new column before/after the target's column
 *   - top/bottom: as a new pane at the top/bottom of the target's column stack
 *
 * No-ops on self-drops and other invalid combinations.
 */
export function movePane(
  layout: TileLayout,
  sourcePaneId: string,
  targetNodeId: string,
  zone: DropZone,
): TileLayout {
  const source = findNodeById(layout, sourcePaneId);
  if (!source || source.type !== "terminal") return layout;
  if (sourcePaneId === targetNodeId) return layout;

  const sessionId = source.sessionId;
  const sourceColumnId = findColumnOf(layout, sourcePaneId);
  const targetColumnId = findColumnOf(layout, targetNodeId);
  if (!sourceColumnId || !targetColumnId) return layout;

  const afterRemove = removeNode(layout, sourcePaneId);
  if (!afterRemove.root) {
    // Source was the only pane. Re-insert into the (empty) layout.
    return createLayoutWithTerminal(sessionId);
  }

  // The target may have been nested inside a split that collapsed when the
  // source was removed (same-column top/bottom reorder). Resolve again.
  let targetAnchor = findNodeById(afterRemove, targetNodeId);
  if (!targetAnchor) {
    targetAnchor = findNodeById(afterRemove, targetColumnId);
  }
  if (!targetAnchor) return layout;

  switch (zone) {
    case "left":
      return insertBeforeColumn(afterRemove, targetAnchor.id, sessionId);
    case "right":
      return insertAfterColumn(afterRemove, targetAnchor.id, sessionId);
    case "top":
      return insertAtColumnTop(afterRemove, targetAnchor.id, sessionId);
    case "bottom":
      return insertAtColumnBottom(afterRemove, targetAnchor.id, sessionId);
  }
}

/**
 * Stack a new terminal below the target leaf (within its column).
 * - If target is a lone terminal, promote to a vertical split.
 * - If target is already inside a vertical split, insert as a sibling after it
 *   (flat stack — never nests horizontal inside vertical).
 * - If the target is a split node itself, rejects (returns unchanged).
 */
export function splitLeafVertical(
  layout: TileLayout,
  targetNodeId: string,
  sessionId: string,
): TileLayout {
  const target = layout.root ? findNodeById(layout, targetNodeId) : null;
  if (!target || target.type !== "terminal") return layout;

  const leaf = terminal(sessionId);

  // Root is a lone terminal → promote to vertical split.
  if (layout.root!.type === "terminal") {
    return {
      root: {
        type: "split",
        id: newId(),
        direction: "vertical",
        children: [clone(layout.root!), leaf],
        sizes: equalShares(2),
      },
      version: layout.version,
    };
  }

  const root = layout.root! as SplitNode;

  // Root is a vertical split (single-column layout). Insert sibling directly.
  if (root.direction === "vertical") {
    const idx = root.children.findIndex((c) => c.id === targetNodeId);
    if (idx < 0) return layout;
    const kids = root.children.map(clone);
    kids.splice(idx + 1, 0, leaf);
    return {
      root: { ...root, children: kids, sizes: equalShares(kids.length) },
      version: layout.version,
    };
  }

  // Root is horizontal split — rewrite the column holding target.
  const children = root.children.map((col): TileNode => {
    if (col.id === targetNodeId && col.type === "terminal") {
      return {
        type: "split",
        id: newId(),
        direction: "vertical",
        children: [clone(col), leaf],
        sizes: equalShares(2),
      };
    }
    if (col.type === "split" && col.direction === "vertical") {
      const idx = col.children.findIndex((c) => c.id === targetNodeId);
      if (idx >= 0) {
        const nextKids = [...col.children.map(clone)];
        nextKids.splice(idx + 1, 0, leaf);
        return {
          ...col,
          children: nextKids,
          sizes: equalShares(nextKids.length),
        };
      }
    }
    return clone(col);
  });

  return {
    root: { ...root, children, sizes: [...root.sizes] },
    version: layout.version,
  };
}

/** Remove a node; collapse single-child splits. */
export function removeNode(layout: TileLayout, nodeId: string): TileLayout {
  if (!layout.root) return layout;
  if (layout.root.id === nodeId) return createEmptyLayout();

  function walk(node: TileNode): TileNode | null {
    if (node.type === "terminal") return node;
    const kids: TileNode[] = [];
    for (const c of node.children) {
      if (c.id === nodeId) continue;
      const kept = walk(c);
      if (kept) kids.push(kept);
    }
    if (kids.length === 0) return null;
    if (kids.length === 1) return kids[0];
    return {
      ...node,
      children: kids,
      sizes: equalShares(kids.length),
    };
  }

  const next = walk(layout.root);
  return { root: next, version: layout.version };
}

export function removeSession(layout: TileLayout, sessionId: string): TileLayout {
  const node = findNodeBySessionId(layout, sessionId);
  return node ? removeNode(layout, node.id) : layout;
}

/**
 * Move a root-level column before or after another root-level column.
 * No-op if:
 *   - the layout has no horizontal root split (nothing to reorder),
 *   - source and target resolve to the same column,
 *   - either id isn't a current root-level column.
 */
export function moveColumn(
  layout: TileLayout,
  sourceColumnId: string,
  targetColumnId: string,
  position: "before" | "after",
): TileLayout {
  if (!layout.root || layout.root.type !== "split" || layout.root.direction !== "horizontal") {
    return layout;
  }
  if (sourceColumnId === targetColumnId) return layout;

  const root = layout.root;
  const srcIdx = root.children.findIndex((c) => c.id === sourceColumnId);
  const tgtIdx = root.children.findIndex((c) => c.id === targetColumnId);
  if (srcIdx < 0 || tgtIdx < 0) return layout;

  const children = root.children.map(clone);
  const [moved] = children.splice(srcIdx, 1);

  // After removal, the target index shifts if it was past the source.
  const tgtAfterRemove = tgtIdx > srcIdx ? tgtIdx - 1 : tgtIdx;
  const insertAt = position === "before" ? tgtAfterRemove : tgtAfterRemove + 1;
  children.splice(insertAt, 0, moved);

  return {
    root: { ...root, children, sizes: equalShares(children.length) },
    version: layout.version,
  };
}

export function resizeSplit(layout: TileLayout, splitId: string, sizes: number[]): TileLayout {
  if (!layout.root) return layout;

  function walk(node: TileNode): TileNode {
    if (node.type === "terminal") return node;
    if (node.id === splitId) return { ...node, sizes: [...sizes] };
    return { ...node, children: node.children.map(walk) };
  }

  return { root: walk(layout.root), version: layout.version };
}

// ── Reconciliation with server-side session list ─────────────────────────────

/**
 * Remove any sessions from the layout that no longer exist on the server,
 * then prepend any sessions present in `liveSessionIds` that aren't in the
 * layout yet (newest-first — caller decides order).
 */
export function reconcile(
  layout: TileLayout,
  liveSessionIds: string[],
  newSessionIdsToPrepend: string[],
): TileLayout {
  let next = layout;

  // Drop stale sessions.
  const liveSet = new Set(liveSessionIds);
  for (const sid of getAllSessionIds(next)) {
    if (!liveSet.has(sid)) {
      next = removeSession(next, sid);
    }
  }

  // Prepend new sessions (in reverse so earliest-new ends up rightmost of new).
  for (const sid of [...newSessionIdsToPrepend].reverse()) {
    if (!findNodeBySessionId(next, sid)) {
      next = insertAtStart(next, sid);
    }
  }

  return next;
}

// ── Serialization ────────────────────────────────────────────────────────────

export function serializeLayout(layout: TileLayout): string {
  return JSON.stringify(layout);
}

export function deserializeLayout(json: string): TileLayout | null {
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed?.version !== "number") return null;
    if (parsed.root !== null && !isValidNode(parsed.root)) return null;
    return parsed as TileLayout;
  } catch {
    return null;
  }
}

function isValidNode(node: unknown): node is TileNode {
  if (!node || typeof node !== "object") return false;
  const n = node as { type?: unknown };
  if (n.type === "terminal") {
    const t = node as TerminalNode;
    return typeof t.id === "string" && typeof t.sessionId === "string";
  }
  if (n.type === "split") {
    const s = node as SplitNode;
    return (
      typeof s.id === "string" &&
      (s.direction === "horizontal" || s.direction === "vertical") &&
      Array.isArray(s.children) &&
      Array.isArray(s.sizes) &&
      s.children.length === s.sizes.length &&
      s.children.every(isValidNode)
    );
  }
  return false;
}
