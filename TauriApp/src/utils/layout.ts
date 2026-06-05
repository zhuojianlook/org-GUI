import type { Edge, Node } from "@xyflow/react";
import { OrgDoc, OrgNode } from "../api/org";
import { findTableBlocks } from "./orgTable";
import { parseOrgDate } from "./time";

/**
 * A STABLE identity for a node that survives buffer-position shifts (edits,
 * deletes, calendar sync inserting headings). The visible node `id` is
 * `n<begin>` — fine within one parse, but it changes the moment text above the
 * heading is added/removed, which makes anything keyed on it (region
 * membership, saved positions) jump to the wrong node after an edit. Prefer the
 * org/gcal id; fall back to the title (good enough for top-level headings, which
 * are what regions/positions key on). Used by region membership + (later) saved
 * positions so they follow the node, not its byte offset.
 */
export function nodeStableKey(n: { orgId?: string | null; title?: string | null }): string {
  return n.orgId ? `id:${n.orgId}` : `t:${n.title ?? ""}`;
}

export const INDENT_X = 30; // horizontal indent per heading level
export const NODE_GAP = 6; // vertical gap between stacked nodes
export const ROOT_GAP = 28; // extra vertical gap between top-level subtrees
const BASE_H = 30; // a one-line node's height
const PLAN_H = 18; // extra height when a node shows a scheduled/deadline line
const BODY_LINE_H = 16; // height per non-blank body line shown on a node
const BLANK_LINE_H = 4; // height for a blank body line
// TableEditor visual budget per data row (input + border + padding) and the
// fixed-cost rows below the table (column-remove row + add/header toolbar).
const TABLE_ROW_H = 24;
const TABLE_COL_REMOVE_ROW_H = 22;
const TABLE_TOOLBAR_H = 32;
const TABLE_MARGIN = 6;

export interface OrgNodeView extends Record<string, unknown> {
  org: OrgNode;
  dated: boolean;
  hasChildren: boolean;
  expanded: boolean;
  childCount: number;
}

export interface LayoutResult {
  nodes: Node[];
  edges: Edge[];
}

function hasOwnDate(n: OrgNode): boolean {
  return !!(
    parseOrgDate(n.scheduled) ||
    parseOrgDate(n.timestamp) ||
    parseOrgDate(n.deadline) ||
    parseOrgDate(n.closed)
  );
}

// A collapsed table renders as a single "▸ Table (rows × cols)" pill instead
// of the full editor; reserve just enough vertical space for that pill so
// folding a table actually shrinks the node.
const TABLE_COLLAPSED_H = 22;

/** Estimated rendered height of the entry body shown inside a node. Treats
 *  org tables specially because the inline TableEditor renders much taller
 *  than 16 px per line — if we left them on the per-line estimate the node
 *  box would underflow and adjacent nodes would overlap. */
function bodyHeight(
  body: string | null,
  nodeId: string,
  tableCollapsed: Set<string>,
): number {
  if (!body) return 0;
  let h = 2; // marginTop of the body block
  const tables = findTableBlocks(body);
  const lines = body.split("\n");
  // Mark every line covered by a table so the per-line accumulator skips them;
  // we account for tables in bulk afterwards.
  const inTable = new Array(lines.length).fill(false);
  for (const t of tables) for (let i = t.startLine; i < t.endLine; i++) inTable[i] = true;
  lines.forEach((line, i) => {
    if (inTable[i]) return;
    h += line.trim() === "" ? BLANK_LINE_H : BODY_LINE_H;
  });
  for (const t of tables) {
    const key = `${nodeId}:${t.startLine}`;
    if (tableCollapsed.has(key)) {
      h += TABLE_MARGIN + TABLE_COLLAPSED_H;
    } else {
      h += TABLE_MARGIN + t.rows.length * TABLE_ROW_H + TABLE_COL_REMOVE_ROW_H + TABLE_TOOLBAR_H;
    }
  }
  return h;
}

/** Estimated rendered height of a node (heading + planning line + body). */
function nodeHeight(n: OrgNode, tableCollapsed: Set<string>): number {
  const plan = n.rawScheduled || n.rawDeadline ? PLAN_H : 0;
  return BASE_H + plan + bodyHeight(n.body, n.id, tableCollapsed);
}

/**
 * Layout: top-level ("root") nodes are placed at a free, user-draggable
 * position (keyed by the root's STABLE key — nodeStableKey — so a saved
 * position follows that heading rather than its buffer ordinal; deleting an
 * earlier root no longer makes the rest inherit each other's positions).
 * Descendants are computed relative to their root — stacked below in document
 * order, indented by depth, with compact variable-height spacing — so children
 * aren't freely movable.
 */
export function buildLayout(
  doc: OrgDoc,
  expanded: Set<string>,
  rootPositions: Record<string, { x: number; y: number }>,
  tableCollapsed: Set<string>,
): LayoutResult {
  const nodes = doc.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.parent) {
      const arr = children.get(n.parent) || [];
      arr.push(n.id);
      children.set(n.parent, arr);
    }
  }

  const rootOfCache = new Map<string, string>();
  const rootOf = (id: string): string => {
    if (rootOfCache.has(id)) return rootOfCache.get(id)!;
    const n = byId.get(id)!;
    const r = n.parent ? rootOf(n.parent) : id;
    rootOfCache.set(id, r);
    return r;
  };

  // Visibility: roots always; a child shows only when its parent is expanded.
  // `expanded` holds STABLE keys (nodeStableKey), not n<begin> ids, so an edit
  // that shifts buffer positions (e.g. adding a TODO keyword) doesn't silently
  // collapse everything below it.
  const visibleIds = new Set<string>();
  const visible: OrgNode[] = [];
  for (const n of nodes) {
    const parent = n.parent ? byId.get(n.parent) : undefined;
    const vis = !n.parent || (visibleIds.has(n.parent) && !!parent && expanded.has(nodeStableKey(parent)));
    if (vis) {
      visibleIds.add(n.id);
      visible.push(n);
    }
  }

  // Total height of each visible root subtree (for default stacking of roots).
  const rootTotalH = new Map<string, number>();
  for (const n of visible) {
    const r = rootOf(n.id);
    rootTotalH.set(r, (rootTotalH.get(r) || 0) + nodeHeight(n, tableCollapsed) + NODE_GAP);
  }
  const defaultAnchorY = new Map<string, number>();
  let runDefaultY = 0;
  for (const n of nodes) {
    if (!n.parent) {
      defaultAnchorY.set(n.id, runDefaultY);
      runDefaultY += (rootTotalH.get(n.id) || nodeHeight(n, tableCollapsed)) + ROOT_GAP;
    }
  }

  const flowNodes: Node[] = [];
  const edges: Edge[] = [];

  // Cumulative y within each root subtree (compact, variable-height).
  let curRoot: string | null = null;
  let runY = 0;
  visible.forEach((n) => {
    const r = rootOf(n.id);
    const anchor = rootPositions[nodeStableKey(byId.get(r)!)] ?? { x: 0, y: defaultAnchorY.get(r) ?? 0 };
    if (r !== curRoot) {
      curRoot = r;
      runY = 0;
    }
    const childCount = children.get(n.id)?.length ?? 0;
    flowNodes.push({
      id: n.id,
      type: "org",
      position: { x: anchor.x + (n.level - 1) * INDENT_X, y: anchor.y + runY },
      data: {
        org: n,
        dated: hasOwnDate(n),
        hasChildren: childCount > 0,
        expanded: expanded.has(nodeStableKey(n)),
        childCount,
      } as OrgNodeView,
      zIndex: 10,
    });
    runY += nodeHeight(n, tableCollapsed) + NODE_GAP;

    if (n.parent && visibleIds.has(n.parent)) {
      edges.push({
        id: `e-${n.parent}-${n.id}`,
        source: n.parent,
        target: n.id,
        type: "tree",
        style: { stroke: "var(--c-border)", strokeWidth: 1.5 },
        zIndex: 5,
      });
    }
  });

  return { nodes: flowNodes, edges };
}
