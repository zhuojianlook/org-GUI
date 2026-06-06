import { invoke } from "@tauri-apps/api/core";
import { DEMO_DOC } from "./demoData";
import { parseOrgDate, todayStr } from "../utils/time";

/** True when running inside the Tauri webview (vs a plain browser preview). */
export const IN_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface OrgNode {
  id: string;
  begin: number;
  level: number;
  parent: string | null;
  title: string | null;
  todo: string | null;
  done: boolean;
  priority: string | null;
  tags: string[];
  tagsAll: string[];
  scheduled: string | null;
  deadline: string | null;
  closed: string | null;
  timestamp: string | null;
  /** End of a duration/range, when the corresponding timestamp carries one
   *  (e.g. SCHEDULED `<… 10:00-11:30>` or a multi-day TIMESTAMP `<a>--<b>`).
   *  Null for single-point timestamps. Drives the timeline's duration bars. */
  scheduledEnd: string | null;
  deadlineEnd: string | null;
  timestampEnd: string | null;
  rawScheduled: string | null;
  rawDeadline: string | null;
  rawClosed: string | null;
  raw: string | null;
  category: string | null;
  orgId: string | null;
  /** org-gcal :entry-id: — stable identity used to relocate a calendar event
   *  for delete/unsync even if its buffer position drifted. Null for non-gcal. */
  entryId: string | null;
  dependsOn: string[]; // org IDs of prerequisite nodes (this node depends on them)
  /** Optional CSS color from :DEADLINE_COLOR: property, overriding the default red. */
  deadlineColor: string | null;
  /** Google Calendar id (org-gcal :calendar-id: property) for imported events.
   *  Drives the per-calendar colour tag on the timeline. Null for non-gcal nodes. */
  calendarId: string | null;
  body: string | null;
}

export interface OrgDoc {
  file: string;
  title: string | null;
  todoKeywords: string[];
  doneKeywords: string[];
  nodes: OrgNode[];
}

export interface EmacsPing {
  ok: boolean;
  bridge: string;
  org: string;
  emacs: string;
}

export interface CheckboxItem {
  index: number; // 0-based position among the entry's checkbox items
  state: " " | "X" | "-"; // unchecked, checked, partial
  text: string;
  indent: number;
}

/**
 * Extract the checkbox list items (`- [ ] foo`) from a node's body, in document
 * order. Used both to render checkboxes on graph nodes and to count them for
 * statistics cookies in browser demo mode.
 */
/**
 * Prerequisites of NODE (its DEPENDS_ON targets) that are not yet done.
 * A non-empty result means the node is "blocked" — it shouldn't be started
 * until these are completed.
 */
export function incompleteDeps(node: OrgNode, doc: OrgDoc | null): OrgNode[] {
  const deps = node.dependsOn ?? [];
  if (!doc || deps.length === 0) return [];
  const byOrgId = new Map<string, OrgNode>();
  for (const n of doc.nodes) if (n.orgId) byOrgId.set(n.orgId, n);
  const out: OrgNode[] = [];
  for (const id of deps) {
    const p = byOrgId.get(id);
    if (p && !p.done) out.push(p);
  }
  return out;
}

/**
 * Validate a proposed scheduled date for NODE against the dependency graph:
 *   (a) each of node's prerequisites must be scheduled ≤ the new date
 *   (b) every node depending on `node` must be scheduled ≥ the new date
 * Returns an actionable error string on violation, or null when the move is
 * compatible with the dependency ordering.
 */
export function validateScheduleAgainstDeps(
  nodeId: string,
  newScheduled: string | null,
  doc: OrgDoc | null,
): string | null {
  if (!doc || !newScheduled) return null;
  const node = doc.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const newDate = parseOrgDate(newScheduled);
  if (!newDate) return null;
  const newMs = new Date(newDate.getFullYear(), newDate.getMonth(), newDate.getDate()).getTime();

  const byOrgId = new Map<string, OrgNode>();
  for (const n of doc.nodes) if (n.orgId) byOrgId.set(n.orgId, n);

  const startOfDayMs = (s: string | null): number | null => {
    if (!s) return null;
    const d = parseOrgDate(s);
    if (!d) return null;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };

  // (a) every prerequisite of node must be scheduled no LATER than newMs.
  for (const prereqOrgId of node.dependsOn ?? []) {
    const prereq = byOrgId.get(prereqOrgId);
    if (!prereq) continue;
    const pMs = startOfDayMs(prereq.scheduled);
    if (pMs !== null && pMs > newMs) {
      return `Can't schedule "${node.title ?? "(untitled)"}" earlier than its prerequisite "${
        prereq.title ?? "(untitled)"
      }" (scheduled ${(prereq.scheduled ?? "").slice(0, 10)}). Reschedule the prerequisite first.`;
    }
  }

  // (b) every node depending on `node` must be scheduled no EARLIER than newMs.
  if (node.orgId) {
    for (const other of doc.nodes) {
      if (!(other.dependsOn ?? []).includes(node.orgId)) continue;
      const oMs = startOfDayMs(other.scheduled);
      if (oMs !== null && oMs < newMs) {
        return `Can't schedule "${node.title ?? "(untitled)"}" later than its dependent "${
          other.title ?? "(untitled)"
        }" (scheduled ${(other.scheduled ?? "").slice(0, 10)}). Reschedule the dependent first.`;
      }
    }
  }
  return null;
}

/**
 * Would adding "toNode depends on fromNode" create a dependency cycle?
 * That happens when fromNode already (transitively) depends on toNode — then the
 * new edge closes a loop (A→B→C→A). Walks fromNode's DEPENDS_ON closure looking
 * for toNode.
 */
export function wouldCreateCycle(fromNode: OrgNode, toNode: OrgNode, doc: OrgDoc | null): boolean {
  if (!doc || !toNode.orgId) return false; // nothing can depend on an id-less node
  const byOrgId = new Map<string, OrgNode>();
  for (const n of doc.nodes) if (n.orgId) byOrgId.set(n.orgId, n);
  const target = toNode.orgId;
  const seen = new Set<string>();
  const stack = [...(fromNode.dependsOn ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = byOrgId.get(id);
    if (n) for (const d of n.dependsOn ?? []) stack.push(d);
  }
  return false;
}

export function parseCheckboxes(body: string | null): CheckboxItem[] {
  if (!body) return [];
  const out: CheckboxItem[] = [];
  let index = 0;
  for (const line of body.split("\n")) {
    const m = line.match(/^(\s*)[-+*]\s+\[([ xX-])\]\s?(.*)$/);
    if (m) {
      const c = m[2].toUpperCase();
      out.push({
        index: index++,
        indent: m[1].length,
        state: c === "X" ? "X" : c === "-" ? "-" : " ",
        text: m[3],
      });
    }
  }
  return out;
}

/**
 * Call an `org-gui-*` bridge function in the running Emacs and parse its
 * JSON result. Bridge-level errors come back as `{ error }` and are rethrown.
 */
export async function orgCall<T = unknown>(
  func: string,
  args: string[] = [],
  timeoutSecs?: number,
): Promise<T> {
  const raw = await invoke<string>("org_call", { func, args, timeoutSecs });
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Bridge returned invalid JSON: ${raw.slice(0, 200)}`);
  }
  if (data && typeof data === "object" && "error" in data) {
    throw new Error(String((data as { error: unknown }).error));
  }
  return data as T;
}

export const pingEmacs = () =>
  IN_TAURI
    ? orgCall<EmacsPing>("org-gui-ping")
    : Promise.resolve<EmacsPing>({ ok: true, bridge: "demo", org: "—", emacs: "browser preview" });

/** Does an absolute path still exist on disk? Used by session restore to
 *  drop tabs whose .org file was moved/deleted. Always true in the browser
 *  preview (no real filesystem). */
export const pathExists = (path: string): Promise<boolean> =>
  IN_TAURI ? invoke<boolean>("path_exists", { path }) : Promise.resolve(true);

export const parseOrg = (file: string) =>
  IN_TAURI
    ? orgCall<OrgDoc>("org-gui-parse", [file])
    : Promise.resolve(structuredClone(ensureMock()));

/** A bridge mutator: edits the heading at `begin`, saves, returns fresh doc. */
export type Mutator = (file: string, begin: number, value: string) => Promise<OrgDoc>;

const mutator =
  (func: string): Mutator =>
  (file, begin, value) =>
    IN_TAURI
      ? orgCall<OrgDoc>(func, [file, String(begin), value])
      : Promise.resolve(mockMutate(func, begin, value));

// ── Browser demo mode: an in-memory doc so the preview is fully interactive
// without Tauri or Emacs. No-ops in the real app (IN_TAURI gates it off).
let mockDoc: OrgDoc | null = null;
function ensureMock(): OrgDoc {
  if (!mockDoc) {
    mockDoc = structuredClone(DEMO_DOC);
    // The demo snapshot predates the dependsOn field; normalize so the browser
    // demo can attach dependencies.
    for (const n of mockDoc.nodes) if (!Array.isArray(n.dependsOn)) n.dependsOn = [];
  }
  return mockDoc;
}

let mockOrgId = 1;
function ensureMockOrgId(n: OrgNode): string {
  if (!n.orgId) n.orgId = `demo-id-${n.begin}-${mockOrgId++}`;
  return n.orgId;
}

function mockAddDependency(fromBegin: number, toBegin: number): OrgDoc {
  const doc = ensureMock();
  const from = doc.nodes.find((n) => n.begin === fromBegin);
  const to = doc.nodes.find((n) => n.begin === toBegin);
  if (from && to && from !== to) {
    const fid = ensureMockOrgId(from);
    if (!Array.isArray(to.dependsOn)) to.dependsOn = [];
    if (!to.dependsOn.includes(fid)) to.dependsOn.push(fid);
    recompute(doc);
  }
  return structuredClone(doc);
}

function mockRemoveDependency(fromBegin: number, toBegin: number): OrgDoc {
  const doc = ensureMock();
  const from = doc.nodes.find((n) => n.begin === fromBegin);
  const to = doc.nodes.find((n) => n.begin === toBegin);
  if (from?.orgId && Array.isArray(to?.dependsOn)) {
    to!.dependsOn = to!.dependsOn.filter((id) => id !== from.orgId);
    recompute(doc);
  }
  return structuredClone(doc);
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function orgStamp(iso: string): string {
  const d = parseOrgDate(iso);
  if (!d) return `<${iso}>`;
  const base = `${iso.slice(0, 10)} ${DOW[d.getDay()]}`;
  return iso.includes("T") ? `<${base} ${iso.slice(11, 16)}>` : `<${base}>`;
}

// A statistics cookie embedded in a heading: [/] [%] [n/m] [n%]. Non-global so
// .test()/.match() stay stateless across calls.
const COOKIE_RE = /\[(?:\d*%|\d*\/\d*)\]/;

/**
 * Recompute a `[/]`/`[%]` cookie in heading TEXT from its direct task children
 * (browser demo only; the real app gets this from Emacs). Org counts only
 * direct children that carry a todo keyword; percentage rounds done/total.
 */
function updateCookieText(node: OrgNode, kids: OrgNode[], doc: OrgDoc): string {
  const text = node.title ?? "";
  const m = text.match(COOKIE_RE);
  if (!m) return text;
  // Org counts checkboxes when the entry has a checkbox list, otherwise it
  // counts the entry's direct TODO children.
  const boxes = parseCheckboxes(node.body);
  let total: number;
  let done: number;
  if (boxes.length) {
    total = boxes.length;
    done = boxes.filter((b) => b.state === "X").length;
  } else {
    const tasks = kids.filter((k) => !!k.todo && doc.todoKeywords.includes(k.todo));
    total = tasks.length;
    done = tasks.filter((k) => !!k.todo && doc.doneKeywords.includes(k.todo)).length;
  }
  const repl = m[0].includes("%")
    ? `[${total ? Math.round((100 * done) / total) : 0}%]`
    : `[${done}/${total}]`;
  return text.slice(0, m.index!) + repl + text.slice(m.index! + m[0].length);
}

function recompute(doc: OrgDoc) {
  const byId = new Map(doc.nodes.map((n) => [n.id, n] as const));
  // Direct-children index, for statistics cookies.
  const kids = new Map<string, OrgNode[]>();
  for (const n of doc.nodes) {
    if (n.parent) {
      const arr = kids.get(n.parent) ?? [];
      arr.push(n);
      kids.set(n.parent, arr);
    }
  }
  // Pass 1: done state + inherited tags (parents precede children in doc order).
  for (const n of doc.nodes) {
    n.done = !!n.todo && doc.doneKeywords.includes(n.todo);
    const acc: string[] = [];
    let cur: OrgNode | undefined = n;
    const chain: OrgNode[] = [];
    while (cur) {
      chain.unshift(cur);
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
    for (const c of chain) for (const t of c.tags) if (!acc.includes(t)) acc.push(t);
    n.tagsAll = acc;
  }
  // Pass 2: refresh any cookie from children (needs every child's done state
  // from pass 1), then rebuild the raw heading line + timestamps so the node
  // display tracks edits in browser demo mode.
  for (const n of doc.nodes) {
    if (n.title) n.title = updateCookieText(n, kids.get(n.id) ?? [], doc);
    let line = "*".repeat(n.level);
    if (n.todo) line += ` ${n.todo}`;
    if (n.priority) line += ` [#${n.priority}]`;
    line += ` ${n.title ?? ""}`;
    if (n.tags.length) line += ` :${n.tags.join(":")}:`;
    n.raw = line;
    n.rawScheduled = n.scheduled ? orgStamp(n.scheduled) : null;
    n.rawDeadline = n.deadline ? orgStamp(n.deadline) : null;
  }
}

/** Parse a raw org heading line back into fields (browser mock only). */
function parseRawHeadline(line: string, todoKeywords: string[]) {
  const m = line.match(/^(\*+)\s+/);
  const level = m ? m[1].length : 1;
  let rest = m ? line.slice(m[0].length) : line.replace(/^[* \t]+/, "");
  let tags: string[] = [];
  const tm = rest.match(/\s+:([^\s]+):\s*$/);
  if (tm) {
    tags = tm[1].split(":").filter(Boolean);
    rest = rest.slice(0, tm.index!);
  }
  let todo: string | null = null;
  const tw = rest.match(/^(\S+)(\s+)/);
  if (tw && todoKeywords.includes(tw[1])) {
    todo = tw[1];
    rest = rest.slice(tw[0].length);
  }
  let priority: string | null = null;
  const pm = rest.match(/^\[#([A-Za-z0-9])\]\s*/);
  if (pm) {
    priority = pm[1];
    rest = rest.slice(pm[0].length);
  }
  return { level, todo, priority, title: rest.trim(), tags };
}

function mockStart(begin: number): OrgDoc {
  const doc = ensureMock();
  const n = doc.nodes.find((x) => x.begin === begin);
  if (n) {
    n.todo = "STRT";
    n.scheduled = todayStr();
    recompute(doc);
  }
  return structuredClone(doc);
}

function mockMutate(func: string, begin: number, value: string): OrgDoc {
  const doc = ensureMock();
  const n = doc.nodes.find((x) => x.begin === begin);
  if (n) {
    switch (func) {
      case "org-gui-set-todo": n.todo = value || null; break;
      case "org-gui-set-title": n.title = value; break;
      case "org-gui-set-scheduled": n.scheduled = value || null; break;
      case "org-gui-set-deadline": n.deadline = value || null; break;
      case "org-gui-set-priority": n.priority = value || null; break;
      case "org-gui-set-tags": n.tags = value.split(/[ :]+/).filter(Boolean); break;
      case "org-gui-set-deadline-color": n.deadlineColor = value || null; break;
      case "org-gui-set-raw": {
        const p = parseRawHeadline(value, doc.todoKeywords);
        n.level = p.level;
        n.todo = p.todo;
        n.priority = p.priority;
        n.title = p.title;
        n.tags = p.tags;
        break;
      }
    }
    recompute(doc);
  }
  return structuredClone(doc);
}

let mockBegin = 100000;
function emptyNode(begin: number, level: number, parent: string | null, title: string): OrgNode {
  return {
    id: `n${begin}`, begin, level, parent, title,
    todo: null, done: false, priority: null, tags: [], tagsAll: [],
    scheduled: null, deadline: null, closed: null, timestamp: null,
    scheduledEnd: null, deadlineEnd: null, timestampEnd: null,
    rawScheduled: null, rawDeadline: null, rawClosed: null,
    raw: `${"*".repeat(level)} ${title}`,
    category: "Demo", orgId: null, entryId: null, dependsOn: [], deadlineColor: null,
    calendarId: null, body: null,
  };
}

function mockCreate(title: string): OrgDoc {
  mockDoc = {
    file: "untitled.org",
    title: title || "Untitled",
    todoKeywords: DEMO_DOC.todoKeywords,
    doneKeywords: DEMO_DOC.doneKeywords,
    nodes: [],
  };
  return structuredClone(mockDoc);
}

function mockAdd(parentBegin: number, title: string): OrgDoc {
  const doc = ensureMock();
  const begin = ++mockBegin;
  let level = 1;
  let parent: string | null = null;
  let insertIdx = doc.nodes.length;
  let asTodo = false;
  if (parentBegin > 0) {
    const p = doc.nodes.find((n) => n.begin === parentBegin);
    if (p) {
      level = p.level + 1;
      parent = p.id;
      // Mirror the bridge: under a parent that tracks progress with a cookie,
      // a new child is a TODO so it's actually counted.
      asTodo = !!(p.title && COOKIE_RE.test(p.title));
      const pIdx = doc.nodes.indexOf(p);
      let j = pIdx + 1;
      while (j < doc.nodes.length && doc.nodes[j].level > p.level) j++;
      insertIdx = j;
    }
  }
  const node = emptyNode(begin, level, parent, title || "New heading");
  if (asTodo) node.todo = "TODO";
  doc.nodes.splice(insertIdx, 0, node);
  recompute(doc);
  return structuredClone(doc);
}

function mockSetBody(begin: number, body: string): OrgDoc {
  const doc = ensureMock();
  const n = doc.nodes.find((x) => x.begin === begin);
  if (n) {
    n.body = body || null;
    recompute(doc);
  }
  return structuredClone(doc);
}

function mockAddTagMany(begins: number[], tag: string): OrgDoc {
  const doc = ensureMock();
  const t = tag.trim();
  if (!t) return structuredClone(doc);
  for (const b of begins) {
    const n = doc.nodes.find((x) => x.begin === b);
    if (n && !n.tags.includes(t)) n.tags = [...n.tags, t];
  }
  recompute(doc);
  return structuredClone(doc);
}

function mockAddTableChild(parentBegin: number): OrgDoc {
  const doc = mockAdd(parentBegin, "Table");
  // The just-added child is the last one whose title === "Table"; give it a starter table body.
  const matches = doc.nodes.filter((n) => n.title === "Table");
  const created = matches[matches.length - 1];
  if (created) {
    created.body = "| Col 1 | Col 2 | Col 3 |\n|-------+-------+-------|\n|       |       |       |\n|       |       |       |";
    recompute(doc);
  }
  return structuredClone(doc);
}

function mockToggleCheckbox(begin: number, index: number): OrgDoc {
  const doc = ensureMock();
  const n = doc.nodes.find((x) => x.begin === begin);
  if (n && n.body) {
    const lines = n.body.split("\n");
    let i = 0;
    for (let li = 0; li < lines.length; li++) {
      const m = lines[li].match(/^(\s*[-+*]\s+\[)([ xX-])(\].*)$/);
      if (m) {
        if (i === index) {
          const next = m[2].toUpperCase() === "X" ? " " : "X";
          lines[li] = m[1] + next + m[3];
          break;
        }
        i++;
      }
    }
    n.body = lines.join("\n");
    recompute(doc);
  }
  return structuredClone(doc);
}

function mockDelete(begin: number): OrgDoc {
  const doc = ensureMock();
  const idx = doc.nodes.findIndex((n) => n.begin === begin);
  if (idx >= 0) {
    const [s, e] = subtreeRange(doc, idx);
    doc.nodes.splice(s, e - s);
    recompute(doc);
  }
  return structuredClone(doc);
}

function subtreeRange(doc: OrgDoc, idx: number): [number, number] {
  const lvl = doc.nodes[idx].level;
  let end = idx + 1;
  while (end < doc.nodes.length && doc.nodes[end].level > lvl) end++;
  return [idx, end];
}

function isoFromStamp(s: string): string | null {
  const m = s.match(/(\d{4}-\d{2}-\d{2})(?:[^0-9]+(\d{2}:\d{2}))?/);
  if (!m) return null;
  return m[2] ? `${m[1]}T${m[2]}` : m[1];
}

function mockGetSubtree(begin: number): { text: string } {
  const doc = ensureMock();
  const idx = doc.nodes.findIndex((n) => n.begin === begin);
  if (idx < 0) return { text: "" };
  const [s, e] = subtreeRange(doc, idx);
  const out: string[] = [];
  for (let i = s; i < e; i++) {
    const n = doc.nodes[i];
    out.push(n.raw ?? `${"*".repeat(n.level)} ${n.title ?? ""}`);
    const plan: string[] = [];
    if (n.rawScheduled) plan.push(`SCHEDULED: ${n.rawScheduled}`);
    if (n.rawDeadline) plan.push(`DEADLINE: ${n.rawDeadline}`);
    if (n.rawClosed) plan.push(`CLOSED: ${n.rawClosed}`);
    if (plan.length) out.push(plan.join(" "));
    if (n.body) out.push(n.body);
  }
  return { text: out.join("\n") + "\n" };
}

// Parse org text into nodes (browser demo only; the real app uses Emacs).
function parseOrgNodes(lines: string[], todoKeywords: string[], parentOfRoot: string | null): OrgNode[] {
  const out: OrgNode[] = [];
  const stack: { level: number; id: string }[] = [];
  let cur: OrgNode | null = null;
  let bodyLines: string[] = [];
  const flush = () => {
    if (!cur) return;
    const body = bodyLines
      .filter((l) => !/^\s*(SCHEDULED|DEADLINE|CLOSED):/.test(l) && !/^\s*:[A-Za-z0-9_]+:/.test(l))
      .join("\n")
      .trim();
    cur.body = body || null;
    bodyLines = [];
  };
  for (const line of lines) {
    if (/^\*+\s/.test(line)) {
      flush();
      const p = parseRawHeadline(line, todoKeywords);
      while (stack.length && stack[stack.length - 1].level >= p.level) stack.pop();
      const parent = stack.length ? stack[stack.length - 1].id : parentOfRoot;
      const node = emptyNode(++mockBegin, p.level, parent, p.title);
      node.todo = p.todo;
      node.priority = p.priority;
      node.tags = p.tags;
      out.push(node);
      cur = node;
      stack.push({ level: p.level, id: node.id });
    } else if (cur) {
      const sm = line.match(/SCHEDULED:\s*<([^>]+)>/);
      if (sm) cur.scheduled = isoFromStamp(sm[1]);
      const dm = line.match(/DEADLINE:\s*<([^>]+)>/);
      if (dm) cur.deadline = isoFromStamp(dm[1]);
      bodyLines.push(line);
    }
  }
  flush();
  return out;
}

function mockSetSubtree(begin: number, text: string): OrgDoc {
  const doc = ensureMock();
  const idx = doc.nodes.findIndex((n) => n.begin === begin);
  if (idx < 0) return structuredClone(doc);
  const [s, e] = subtreeRange(doc, idx);
  const newNodes = parseOrgNodes(text.replace(/\s+$/, "").split("\n"), doc.todoKeywords, doc.nodes[idx].parent);
  doc.nodes.splice(s, e - s, ...newNodes);
  recompute(doc);
  return structuredClone(doc);
}

function mockGetFile(): { text: string } {
  const doc = ensureMock();
  const out: string[] = [];
  if (doc.title) out.push(`#+TITLE: ${doc.title}`, "");
  for (const n of doc.nodes) {
    out.push(n.raw ?? `${"*".repeat(n.level)} ${n.title ?? ""}`);
    const plan: string[] = [];
    if (n.rawScheduled) plan.push(`SCHEDULED: ${n.rawScheduled}`);
    if (n.rawDeadline) plan.push(`DEADLINE: ${n.rawDeadline}`);
    if (n.rawClosed) plan.push(`CLOSED: ${n.rawClosed}`);
    if (plan.length) out.push(plan.join(" "));
    if (n.body) out.push(n.body);
  }
  return { text: out.join("\n") + "\n" };
}

function mockSetFile(text: string): OrgDoc {
  const doc = ensureMock();
  const lines = text.replace(/\s+$/, "").split("\n");
  const titleLine = lines.find((l) => /^#\+TITLE:/i.test(l));
  if (titleLine) doc.title = titleLine.replace(/^#\+TITLE:\s*/i, "").trim();
  doc.nodes = parseOrgNodes(lines, doc.todoKeywords, null);
  recompute(doc);
  return structuredClone(doc);
}

function mockReorder(begin: number, delta: number): OrgDoc {
  const dir = delta > 0 ? "org-gui-move-down" : "org-gui-move-up";
  for (let i = 0; i < Math.abs(delta); i++) mockStruct(dir, begin);
  return structuredClone(ensureMock());
}

function mockRefile(begin: number, targetBegin: number): OrgDoc {
  const doc = ensureMock();
  const idx = doc.nodes.findIndex((n) => n.begin === begin);
  const tIdx = doc.nodes.findIndex((n) => n.begin === targetBegin);
  if (idx < 0 || tIdx < 0) return structuredClone(doc);
  const [s, e] = subtreeRange(doc, idx);
  const moved = doc.nodes.slice(s, e);
  const target = doc.nodes[tIdx];
  const levelDelta = target.level + 1 - moved[0].level;
  moved.forEach((n) => (n.level += levelDelta));
  moved[0].parent = target.id;
  doc.nodes.splice(s, e - s); // remove moved block
  // Re-find target (indices shifted) and insert moved at the end of its subtree.
  const tIdx2 = doc.nodes.findIndex((n) => n.begin === targetBegin);
  const [, te] = subtreeRange(doc, tIdx2);
  doc.nodes.splice(te, 0, ...moved);
  recompute(doc);
  return structuredClone(doc);
}

// Approximate move/promote for browser demo mode (Emacs does it exactly).
function mockStruct(func: string, begin: number): OrgDoc {
  const doc = ensureMock();
  const idx = doc.nodes.findIndex((n) => n.begin === begin);
  if (idx < 0) return structuredClone(doc);
  const n = doc.nodes[idx];
  const [s, e] = subtreeRange(doc, idx);
  if (func === "org-gui-move-up") {
    let p = -1;
    for (let j = idx - 1; j >= 0; j--) {
      if (doc.nodes[j].level < n.level) break;
      if (doc.nodes[j].level === n.level && doc.nodes[j].parent === n.parent) {
        p = j;
        break;
      }
    }
    if (p >= 0) {
      const moving = doc.nodes.splice(s, e - s);
      doc.nodes.splice(p, 0, ...moving);
    }
  } else if (func === "org-gui-move-down") {
    if (e < doc.nodes.length && doc.nodes[e].level === n.level && doc.nodes[e].parent === n.parent) {
      const [, ne] = subtreeRange(doc, e);
      const next = doc.nodes.splice(e, ne - e);
      doc.nodes.splice(s, 0, ...next);
    }
  } else if (func === "org-gui-promote") {
    for (let i = s; i < e; i++) doc.nodes[i].level = Math.max(1, doc.nodes[i].level - 1);
  } else if (func === "org-gui-demote") {
    for (let i = s; i < e; i++) doc.nodes[i].level += 1;
  }
  recompute(doc);
  return structuredClone(doc);
}

export const setTodo = mutator("org-gui-set-todo");
export const setTitle = mutator("org-gui-set-title");
export const setScheduled = mutator("org-gui-set-scheduled");
export const setDeadline = mutator("org-gui-set-deadline");
export const setPriority = mutator("org-gui-set-priority");
export const setTags = mutator("org-gui-set-tags");
export const setRaw = mutator("org-gui-set-raw");
export const setDeadlineColor = mutator("org-gui-set-deadline-color");

/** Start a task: set STRT + schedule today (one round-trip). */
export const startTask = (file: string, begin: number) =>
  IN_TAURI
    ? orgCall<OrgDoc>("org-gui-start", [file, String(begin)])
    : Promise.resolve(mockStart(begin));

/** Set the entry's plain active-timestamp span (a date/time range, i.e. a
 *  duration). START + END are "YYYY-MM-DD" or "YYYY-MM-DD HH:MM"; pass both
 *  empty to remove the span. */
export const setTimestampRange = (
  file: string,
  begin: number,
  start: string,
  end: string,
): Promise<OrgDoc> =>
  IN_TAURI
    ? orgCall<OrgDoc>("org-gui-set-timestamp-range", [file, String(begin), start, end])
    : Promise.resolve(structuredClone(ensureMock()));

/** Set a node's SPAN (duration), routing to the right org representation:
 *  same-day → a SCHEDULED time-range (the scheduled task's own block),
 *  multi-day → a plain timestamp range. START/END are "YYYY-MM-DD" or
 *  "YYYY-MM-DD HH:MM"; empty START clears the span. */
export const setSpan = (
  file: string,
  begin: number,
  start: string,
  end: string,
): Promise<OrgDoc> =>
  IN_TAURI
    ? orgCall<OrgDoc>("org-gui-set-span", [file, String(begin), start, end])
    : Promise.resolve(structuredClone(ensureMock()));

/** Move a Google-calendar event by rewriting its BODY active timestamp in
 *  place, in org-gcal's native shape (same-day timed → <DATE HH:MM-HH:MM>,
 *  multi-day → <START>--<END>). No SCHEDULED line is written, so there's no
 *  duplicate and org-gcal can push the change on the next two-way sync. */
export const gcalMove = (
  file: string,
  begin: number,
  start: string,
  end: string,
): Promise<OrgDoc> =>
  IN_TAURI
    ? orgCall<OrgDoc>("org-gui-gcal-move", [file, String(begin), start, end])
    : Promise.resolve(structuredClone(ensureMock()));

// ── Google Calendar (org-gcal) ──────────────────────────────────────────
export interface GcalStatus {
  available: boolean; // org-gcal installed + loadable
  configured: boolean; // client id/secret present in the daemon
  authorized: boolean; // an OAuth token has been stored
}

/** Install org-gcal + deps into the app-private ~/.org-gui/elpa (1–2 min). */
export const gcalInstall = (): Promise<string> =>
  IN_TAURI ? invoke<string>("gcal_install") : Promise.reject(new Error("Desktop only"));

/** Current org-gcal availability/config/authorization state. */
export const gcalStatus = (): Promise<GcalStatus> =>
  IN_TAURI
    ? orgCall<GcalStatus>("org-gui-gcal-status")
    : Promise.resolve({ available: false, configured: false, authorized: false });

/** One of the signed-in account's Google calendars (from calendarList). */
export interface GcalCalendar {
  id: string;
  summary: string;
  primary: boolean;
  color: string | null; // Google's backgroundColor, used for the per-calendar tag
  accessRole: string | null; // owner | writer | reader | freeBusyReader
}

/** List the signed-in ACCOUNT's calendars (needs a stored token). */
export const gcalCalendars = (
  clientId: string,
  clientSecret: string,
  account: string,
): Promise<GcalCalendar[]> =>
  IN_TAURI
    ? orgCall<GcalCalendar[]>(
        "org-gui-gcal-calendars",
        [clientId, clientSecret, account],
        60,
      )
    : Promise.resolve([]);

/** Sync the selected calendars into FILE. ACCOUNT is the signed-in email;
 *  CALENDARIDS the calendars to sync; TWOWAY pushes Emacs edits back to Google
 *  (org-gcal-sync) vs one-way fetch. First call opens OAuth consent → long
 *  timeout. Returns the freshly-parsed file doc. */
export const gcalSync = (
  clientId: string,
  clientSecret: string,
  account: string,
  calendarIds: string[],
  file: string,
  twoWay: boolean,
): Promise<OrgDoc> =>
  IN_TAURI
    ? orgCall<OrgDoc>(
        "org-gui-gcal-sync",
        [clientId, clientSecret, account, calendarIds.join(","), file, twoWay ? "t" : "nil"],
        300, // browser consent + push + fetch across multiple calendars
      )
    : Promise.reject(new Error("Desktop only"));

/** READ-ONLY peek at Google: list events in the sync window for the given
 *  calendars WITHOUT writing the org file. Each event id is "<eventId>/<calId>"
 *  to match org-gcal's entry-id, so the caller can diff against what's already
 *  imported. Used by the background "new events" check. */
export interface GcalPeekResult {
  events: { id: string; summary: string }[];
}
export const gcalPeek = (
  clientId: string,
  clientSecret: string,
  account: string,
  calendarIds: string[],
): Promise<GcalPeekResult> =>
  IN_TAURI
    ? orgCall<GcalPeekResult>(
        "org-gui-gcal-peek",
        [clientId, clientSecret, account, calendarIds.join(",")],
        40,
      )
    : Promise.resolve({ events: [] });

/** Create a NEW Google Calendar event from the task at BEGIN (assigns it to
 *  CALENDARID, moves its time into the org-gcal drawer, inserts on Google and
 *  stamps the entry). The task becomes a synced calendar event. */
export const gcalCreate = (
  clientId: string,
  clientSecret: string,
  account: string,
  calendarId: string,
  file: string,
  begin: number,
): Promise<OrgDoc> =>
  IN_TAURI
    ? orgCall<OrgDoc>(
        "org-gui-gcal-create",
        [file, String(begin), clientId, clientSecret, account, calendarId],
        120,
      )
    : Promise.reject(new Error("Desktop only"));

/** Remove the calendar event at BEGIN from Google and detach the org entry
 *  (deletes on Google, strips the org-gcal linking properties; keeps the task
 *  + time). Returns the doc. */
export const gcalUnsync = (
  clientId: string,
  clientSecret: string,
  account: string,
  file: string,
  begin: number,
  title = "",
): Promise<OrgDoc> =>
  IN_TAURI
    ? orgCall<OrgDoc>(
        "org-gui-gcal-unsync",
        [file, String(begin), clientId, clientSecret, account, title],
        60,
      )
    : Promise.reject(new Error("Desktop only"));

/** Delete a calendar-linked subtree located by its org-gcal ENTRYID (not buffer
 *  position, so a stale position can't hit a neighbour). DELETEONGOOGLE also
 *  removes the Google event. Returns the reparsed doc. */
export const gcalDelete = (
  entryId: string,
  clientId: string,
  clientSecret: string,
  account: string,
  file: string,
  deleteOnGoogle: boolean,
): Promise<OrgDoc> =>
  IN_TAURI
    ? orgCall<OrgDoc>(
        "org-gui-gcal-delete",
        [file, entryId, clientId, clientSecret, account, deleteOnGoogle ? "t" : "nil"],
        60,
      )
    : Promise.reject(new Error("Desktop only"));

/** Move the calendar event at BEGIN to a DIFFERENT Google calendar (events.move;
 *  one event = one calendar). Returns the doc. */
export const gcalSwitch = (
  clientId: string,
  clientSecret: string,
  account: string,
  newCalendarId: string,
  file: string,
  begin: number,
): Promise<OrgDoc> =>
  IN_TAURI
    ? orgCall<OrgDoc>(
        "org-gui-gcal-switch",
        [file, String(begin), clientId, clientSecret, account, newCalendarId],
        60,
      )
    : Promise.reject(new Error("Desktop only"));

/** Push specific moved events to Google by their org-gcal entry-id, via
 *  org-gcal-post-at-point (deterministic — org-gcal-sync's export skips
 *  gcal-managed events). ENTRYIDS are the move-ghost ids. Returns the doc. */
export const gcalPush = (
  clientId: string,
  clientSecret: string,
  account: string,
  entryIds: string[],
  file: string,
): Promise<OrgDoc> =>
  IN_TAURI
    ? orgCall<OrgDoc>(
        "org-gui-gcal-push",
        [file, clientId, clientSecret, account, entryIds.join(",")],
        300, // a PATCH per moved event
      )
    : Promise.reject(new Error("Desktop only"));

export const archiveNode = (file: string, begin: number) =>
  IN_TAURI
    ? orgCall<OrgDoc>("org-gui-archive", [file, String(begin)])
    : Promise.resolve(mockDelete(begin)); // mock: just drop it from view

// Structural ops take only (file, begin); they're Mutator-shaped (value ignored)
// so they can be passed to the store's `edit` action.
const structOp =
  (func: string): Mutator =>
  (file, begin) =>
    IN_TAURI
      ? orgCall<OrgDoc>(func, [file, String(begin)])
      : Promise.resolve(mockStruct(func, begin));

export const moveUp = structOp("org-gui-move-up");
export const moveDown = structOp("org-gui-move-down");
export const promote = structOp("org-gui-promote");
export const demote = structOp("org-gui-demote");

export const getSubtree = (file: string, begin: number) =>
  IN_TAURI
    ? orgCall<{ text: string }>("org-gui-get-subtree", [file, String(begin)])
    : Promise.resolve(mockGetSubtree(begin));

export const setSubtree = (file: string, begin: number, text: string) =>
  IN_TAURI
    ? orgCall<OrgDoc>("org-gui-set-subtree", [file, String(begin), text])
    : Promise.resolve(mockSetSubtree(begin, text));

export const reorderNode = (file: string, begin: number, delta: number) =>
  IN_TAURI
    ? orgCall<OrgDoc>("org-gui-reorder", [file, String(begin), String(delta)])
    : Promise.resolve(mockReorder(begin, delta));

export const refileNode = (
  file: string,
  begin: number,
  targetBegin: number,
  srcTitle = "",
  tgtTitle = "",
) =>
  IN_TAURI
    ? orgCall<OrgDoc>("org-gui-refile", [
        file,
        String(begin),
        String(targetBegin),
        srcTitle,
        tgtTitle,
      ])
    : Promise.resolve(mockRefile(begin, targetBegin));

export const getFile = (file: string) =>
  IN_TAURI
    ? orgCall<{ text: string }>("org-gui-get-file", [file])
    : Promise.resolve(mockGetFile());

export const setFile = (file: string, text: string) =>
  IN_TAURI
    ? orgCall<OrgDoc>("org-gui-set-file", [file, text])
    : Promise.resolve(mockSetFile(text));

export const createOrg = (file: string, title: string) =>
  IN_TAURI
    ? orgCall<OrgDoc>("org-gui-create", [file, title])
    : Promise.resolve(mockCreate(title));

export const addHeading = (file: string, parentBegin: number, title: string) =>
  IN_TAURI
    ? orgCall<OrgDoc>("org-gui-add-heading", [file, String(parentBegin), title])
    : Promise.resolve(mockAdd(parentBegin, title));

export const deleteNode = (file: string, begin: number, title = "") =>
  IN_TAURI
    ? orgCall<OrgDoc>("org-gui-delete", [file, String(begin), title])
    : Promise.resolve(mockDelete(begin));

/** Toggle the INDEX-th checkbox in a node's body, refresh its cookie, save. */
export const toggleCheckbox = (file: string, begin: number, index: number) =>
  IN_TAURI
    ? orgCall<OrgDoc>("org-gui-toggle-checkbox", [file, String(begin), String(index)])
    : Promise.resolve(mockToggleCheckbox(begin, index));

/** Replace just the body of a node (between metadata and next heading). */
export const setBody = (file: string, begin: number, body: string) =>
  IN_TAURI
    ? orgCall<OrgDoc>("org-gui-set-body", [file, String(begin), body])
    : Promise.resolve(mockSetBody(begin, body));

/** Create a child heading "Table" under PARENT with a 3-col starter table. */
export const addTableChild = (file: string, parentBegin: number) =>
  IN_TAURI
    ? orgCall<OrgDoc>("org-gui-add-table-child", [file, String(parentBegin)])
    : Promise.resolve(mockAddTableChild(parentBegin));

/** Add TAG to every heading whose buffer position is in BEGINS. One round-trip. */
export const addTagMany = (file: string, begins: number[], tag: string) =>
  IN_TAURI
    ? orgCall<OrgDoc>("org-gui-add-tag-many", [file, begins.join(","), tag])
    : Promise.resolve(mockAddTagMany(begins, tag));

/** Add a dependency edge: TO depends on FROM (arrow points FROM → TO). */
export const addDependency = (file: string, fromBegin: number, toBegin: number) =>
  IN_TAURI
    ? orgCall<OrgDoc>("org-gui-add-dependency", [file, String(fromBegin), String(toBegin)])
    : Promise.resolve(mockAddDependency(fromBegin, toBegin));

/** Remove the dependency edge FROM → TO. */
export const removeDependency = (file: string, fromBegin: number, toBegin: number) =>
  IN_TAURI
    ? orgCall<OrgDoc>("org-gui-remove-dependency", [file, String(fromBegin), String(toBegin)])
    : Promise.resolve(mockRemoveDependency(fromBegin, toBegin));
