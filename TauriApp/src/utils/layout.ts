import type { Edge, Node } from "@xyflow/react";
import { OrgDoc, OrgNode } from "../api/org";
import { parseOrgDate } from "./time";

export const INDENT_X = 30; // horizontal indent per heading level
export const NODE_GAP = 6; // vertical gap between stacked nodes
export const ROOT_GAP = 28; // extra vertical gap between top-level subtrees
const BASE_H = 30; // a one-line node's height
const PLAN_H = 18; // extra height when a node shows a scheduled/deadline line
const BODY_LINE_H = 16; // height per non-blank body line shown on a node
const BLANK_LINE_H = 4; // height for a blank body line

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

/** Estimated rendered height of the entry body shown inside a node. */
function bodyHeight(body: string | null): number {
  if (!body) return 0;
  let h = 2; // marginTop of the body block
  for (const line of body.split("\n")) h += line.trim() === "" ? BLANK_LINE_H : BODY_LINE_H;
  return h;
}

/** Estimated rendered height of a node (heading + planning line + body). */
function nodeHeight(n: OrgNode): number {
  const plan = n.rawScheduled || n.rawDeadline ? PLAN_H : 0;
  return BASE_H + plan + bodyHeight(n.body);
}

/**
 * Layout: top-level ("root") nodes are placed at a free, user-draggable
 * position (keyed by stable root index). Descendants are computed relative to
 * their root — stacked below in document order, indented by depth, with
 * compact variable-height spacing — so children aren't freely movable.
 */
export function buildLayout(
  doc: OrgDoc,
  expanded: Set<string>,
  rootPositions: Record<number, { x: number; y: number }>,
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

  const rootIndex = new Map<string, number>();
  let ri = 0;
  for (const n of nodes) if (!n.parent) rootIndex.set(n.id, ri++);

  // Visibility: roots always; a child shows only when its parent is expanded.
  const visibleIds = new Set<string>();
  const visible: OrgNode[] = [];
  for (const n of nodes) {
    const vis = !n.parent || (visibleIds.has(n.parent) && expanded.has(n.parent));
    if (vis) {
      visibleIds.add(n.id);
      visible.push(n);
    }
  }

  // Total height of each visible root subtree (for default stacking of roots).
  const rootTotalH = new Map<string, number>();
  for (const n of visible) {
    const r = rootOf(n.id);
    rootTotalH.set(r, (rootTotalH.get(r) || 0) + nodeHeight(n) + NODE_GAP);
  }
  const defaultAnchorY = new Map<string, number>();
  let runDefaultY = 0;
  for (const n of nodes) {
    if (!n.parent) {
      defaultAnchorY.set(n.id, runDefaultY);
      runDefaultY += (rootTotalH.get(n.id) || nodeHeight(n)) + ROOT_GAP;
    }
  }

  const flowNodes: Node[] = [];
  const edges: Edge[] = [];

  // Cumulative y within each root subtree (compact, variable-height).
  let curRoot: string | null = null;
  let runY = 0;
  visible.forEach((n) => {
    const r = rootOf(n.id);
    const rIdx = rootIndex.get(r)!;
    const anchor = rootPositions[rIdx] ?? { x: 0, y: defaultAnchorY.get(r) ?? 0 };
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
        expanded: expanded.has(n.id),
        childCount,
      } as OrgNodeView,
      zIndex: 10,
    });
    runY += nodeHeight(n) + NODE_GAP;

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
