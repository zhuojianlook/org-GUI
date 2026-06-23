// Shared derivation that turns the parsed org doc into dated "schedule items"
// the Calendar and Timeline (Gantt) views render. Kept out of the components so
// both views agree on dates/times/sections/colours, and reuses the SAME date
// helpers the timeline band uses (so positioning matches across views).

import type { OrgDoc, OrgNode } from "../api/org";
import { parseOrgDate, startOfDay, timeOfDayFromIso } from "./time";
import { nodeTagColors } from "./tagColor";

export type SchedKind = "scheduled" | "deadline" | "timestamp";

export interface SchedItem {
  node: OrgNode;
  nodeId: string;
  title: string;
  /** start-of-day epoch ms of the start date */
  dayMs: number;
  /** start-of-day epoch ms of the end date (== dayMs for a single day) */
  endDayMs: number;
  /** "HH:MM" or null when the item is all-day */
  timeOfDay: string | null;
  timeOfDayEnd: string | null;
  allDay: boolean;
  multiDay: boolean;
  kind: SchedKind;
  done: boolean;
  /** base colour (a #hex) for the entry's fill/accent */
  color: string;
  todo: string | null;
  priority: string | null;
  /** the top-level ancestor heading — the swimlane "section" */
  sectionId: string;
  sectionTitle: string;
}

/** Default accent per date source, used when the node carries no coloured tag. */
const KIND_COLOR: Record<SchedKind, string> = {
  scheduled: "#5a7fa8", // accent blue
  deadline: "#ff6c6b", // red
  timestamp: "#5fb3a1", // teal
};

/** The node's primary date source for a single bar/block: SCHEDULED, else a
 *  plain TIMESTAMP, else DEADLINE. */
function primarySource(
  n: OrgNode,
): { raw: string; rawEnd: string | null; kind: SchedKind } | null {
  if (n.scheduled) return { raw: n.scheduled, rawEnd: n.scheduledEnd, kind: "scheduled" };
  if (n.timestamp) return { raw: n.timestamp, rawEnd: n.timestampEnd, kind: "timestamp" };
  if (n.deadline) return { raw: n.deadline, rawEnd: n.deadlineEnd, kind: "deadline" };
  return null;
}

/** Map every node id → its top-level ancestor ({id, title}) — the section. */
function buildSectionMap(doc: OrgDoc): Map<string, { id: string; title: string }> {
  const byId = new Map<string, OrgNode>();
  for (const n of doc.nodes) byId.set(n.id, n);
  const out = new Map<string, { id: string; title: string }>();
  for (const n of doc.nodes) {
    let cur: OrgNode = n;
    const seen = new Set<string>();
    while (cur.parent && !seen.has(cur.id)) {
      seen.add(cur.id);
      const p = byId.get(cur.parent);
      if (!p) break;
      cur = p;
    }
    out.set(n.id, { id: cur.id, title: cur.title ?? "(untitled)" });
  }
  return out;
}

/** Build the dated items for the views. Skips DONE tasks unless asked, and any
 *  node without a parseable date. */
export function buildSchedItems(
  doc: OrgDoc | null,
  tagColors: Record<string, string>,
  opts?: { includeDone?: boolean },
): SchedItem[] {
  if (!doc) return [];
  const sections = buildSectionMap(doc);
  const items: SchedItem[] = [];
  for (const n of doc.nodes) {
    if (n.done && !opts?.includeDone) continue;
    const src = primarySource(n);
    if (!src) continue;
    const start = parseOrgDate(src.raw);
    if (!start) continue;
    const endD = src.rawEnd ? parseOrgDate(src.rawEnd) : null;
    const dayMs = startOfDay(start).getTime();
    const endDayMs = endD ? startOfDay(endD).getTime() : dayMs;
    const tagCols = nodeTagColors(n.tagsAll, tagColors);
    const color = tagCols[0] ?? n.deadlineColor ?? KIND_COLOR[src.kind];
    const sec = sections.get(n.id) ?? { id: n.id, title: n.title ?? "(untitled)" };
    const timeOfDay = timeOfDayFromIso(src.raw);
    items.push({
      node: n,
      nodeId: n.id,
      title: n.title ?? "(untitled)",
      dayMs,
      endDayMs: Math.max(endDayMs, dayMs),
      timeOfDay,
      timeOfDayEnd: src.rawEnd ? timeOfDayFromIso(src.rawEnd) : null,
      allDay: !timeOfDay,
      multiDay: endDayMs > dayMs,
      kind: src.kind,
      done: n.done,
      color,
      todo: n.todo,
      priority: n.priority,
      sectionId: sec.id,
      sectionTitle: sec.title,
    });
  }
  return items;
}

/** A node in the hierarchical timeline tree. Mirrors the org outline: a GROUP
 *  row is an ancestor that contains scheduled descendants (rendered as a faint
 *  roll-up bar spanning rollupStart..rollupEnd, collapsible); a LEAF row is a
 *  scheduled task (occurrences = its bars — more than one when same-title
 *  siblings, e.g. a recurring "Lab Meeting", collapse into a single row). */
export interface TreeRow {
  key: string;
  node: OrgNode; // representative heading (the group node, or a leaf's node)
  title: string;
  isGroup: boolean;
  occurrences: SchedItem[]; // solid bars for a leaf row (empty for a group)
  rollupStart: number; // for groups: min start over scheduled descendants
  rollupEnd: number; // for groups: max end over scheduled descendants
  color: string;
  children: TreeRow[];
}

/** Build the hierarchical timeline tree: every scheduled node plus the ancestor
 *  chain needed to place it, mirroring the org nesting. Ancestors with no date
 *  but scheduled descendants become collapsible groups with a roll-up span;
 *  scheduled leaves become bars; same-title leaf siblings merge into one row. */
export function buildScheduleTree(doc: OrgDoc | null, tagColors: Record<string, string>): TreeRow[] {
  if (!doc) return [];
  const items = buildSchedItems(doc, tagColors);
  if (items.length === 0) return [];
  const itemByNode = new Map<string, SchedItem>();
  for (const it of items) itemByNode.set(it.nodeId, it);

  const childrenOf = new Map<string, OrgNode[]>();
  const roots: OrgNode[] = [];
  for (const n of doc.nodes) {
    if (n.parent) {
      const arr = childrenOf.get(n.parent);
      if (arr) arr.push(n);
      else childrenOf.set(n.parent, [n]);
    } else {
      roots.push(n);
    }
  }

  const relMemo = new Map<string, boolean>();
  const isRelevant = (n: OrgNode): boolean => {
    const cached = relMemo.get(n.id);
    if (cached !== undefined) return cached;
    let rel = itemByNode.has(n.id);
    if (!rel) {
      for (const c of childrenOf.get(n.id) ?? []) {
        if (isRelevant(c)) {
          rel = true;
          break;
        }
      }
    }
    relMemo.set(n.id, rel);
    return rel;
  };

  const spanOf = (n: OrgNode): { lo: number; hi: number } | null => {
    let lo = Infinity;
    let hi = -Infinity;
    const own = itemByNode.get(n.id);
    if (own) {
      lo = own.dayMs;
      hi = own.endDayMs;
    }
    for (const c of childrenOf.get(n.id) ?? []) {
      const s = spanOf(c);
      if (s) {
        lo = Math.min(lo, s.lo);
        hi = Math.max(hi, s.hi);
      }
    }
    return lo === Infinity ? null : { lo, hi };
  };

  const buildRows = (nodes: OrgNode[]): TreeRow[] => {
    const out: TreeRow[] = [];
    const recurIndex = new Map<string, number>(); // title → out index, to merge sibling leaves
    for (const n of nodes) {
      if (!isRelevant(n)) continue;
      const relChildren = (childrenOf.get(n.id) ?? []).filter(isRelevant);
      if (relChildren.length === 0) {
        // Relevant leaf ⇒ scheduled.
        const item = itemByNode.get(n.id);
        if (!item) continue;
        const t = n.title ?? "";
        const existing = recurIndex.get(t);
        if (existing !== undefined) {
          const r = out[existing];
          r.occurrences.push(item);
          r.rollupStart = Math.min(r.rollupStart, item.dayMs);
          r.rollupEnd = Math.max(r.rollupEnd, item.endDayMs);
        } else {
          recurIndex.set(t, out.length);
          out.push({
            key: `task:${item.nodeId}`,
            node: n,
            title: item.title,
            isGroup: false,
            occurrences: [item],
            rollupStart: item.dayMs,
            rollupEnd: item.endDayMs,
            color: item.color,
            children: [],
          });
        }
      } else {
        const span = spanOf(n);
        out.push({
          key: `grp:${n.id}`,
          node: n,
          title: n.title ?? "(untitled)",
          isGroup: true,
          occurrences: [],
          rollupStart: span ? span.lo : 0,
          rollupEnd: span ? span.hi : 0,
          color: nodeTagColors(n.tagsAll, tagColors)[0] ?? "#8e8e93",
          children: buildRows(childrenOf.get(n.id) ?? []),
        });
      }
    }
    return out;
  };

  return buildRows(roots);
}
