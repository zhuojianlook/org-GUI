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

/** Group items by section, preserving first-seen section order. */
export function groupBySection(
  items: SchedItem[],
): { id: string; title: string; items: SchedItem[] }[] {
  const order: string[] = [];
  const map = new Map<string, { id: string; title: string; items: SchedItem[] }>();
  for (const it of items) {
    let g = map.get(it.sectionId);
    if (!g) {
      g = { id: it.sectionId, title: it.sectionTitle, items: [] };
      map.set(it.sectionId, g);
      order.push(it.sectionId);
    }
    g.items.push(it);
  }
  return order.map((id) => map.get(id)!);
}
