import { create } from "zustand";
import {
  Mutator,
  OrgDoc,
  OrgNode,
  addHeading as apiAddHeading,
  addTableChild as apiAddTableChild,
  addTagMany as apiAddTagMany,
  createOrg as apiCreateOrg,
  deleteNode as apiDeleteNode,
  setBody as apiSetBody,
  setSubtree as apiSetSubtree,
  setFile as apiSetFile,
  reorderNode as apiReorderNode,
  refileNode as apiRefileNode,
  startTask as apiStartTask,
  archiveNode as apiArchiveNode,
  toggleCheckbox as apiToggleCheckbox,
  addDependency as apiAddDependency,
  removeDependency as apiRemoveDependency,
  setScheduled as apiSetScheduled,
  setDeadline as apiSetDeadline,
  incompleteDeps,
  validateScheduleAgainstDeps,
  wouldCreateCycle,
  parseOrg,
  pingEmacs,
  IN_TAURI,
} from "../api/org";

// The graph is always the main canvas; this is the right-side pull-out panel
// (null = collapsed, graph full-width). "details" is the same DetailPanel
// inspector that used to be always-visible; making it a tab lets the user
// reclaim the canvas width when not editing field-level metadata.
export type PanelTab = "emacs" | "agenda" | "details" | null;

// Persist the last-opened file so the desktop app can reopen it on startup.
const LAST_FILE_KEY = "org-gui:lastFile";
export function rememberLastFile(file: string) {
  if (!IN_TAURI) return; // browser preview always uses the embedded demo
  try {
    localStorage.setItem(LAST_FILE_KEY, file);
  } catch {
    /* localStorage unavailable — non-fatal */
  }
}
export function lastOpenedFile(): string | null {
  if (!IN_TAURI) return null;
  try {
    return localStorage.getItem(LAST_FILE_KEY);
  } catch {
    return null;
  }
}

// Remember where the user dragged the top-level ("root") nodes, per file, so the
// canvas layout survives reloads, view toggles, and app restarts. Keyed by root
// index (stable across edits as long as roots aren't reordered/removed).
type RootPositions = Record<number, { x: number; y: number }>;
const POS_KEY = (file: string) => `org-gui:pos:${file}`;

function loadPositions(file: string | null): RootPositions {
  if (!file) return {};
  try {
    const raw = localStorage.getItem(POS_KEY(file));
    return raw ? (JSON.parse(raw) as RootPositions) : {};
  } catch {
    return {};
  }
}

function savePositions(file: string | null, positions: RootPositions) {
  if (!file) return;
  try {
    localStorage.setItem(POS_KEY(file), JSON.stringify(positions));
  } catch {
    /* localStorage unavailable — non-fatal */
  }
}

// User-placed milestone dates on the top timeline, persisted per file.
export interface Milestone {
  id: string;
  iso: string; // "YYYY-MM-DD"
  label: string;
  /** Optional CSS color for the pin background. Falls back to the default
   *  violet when undefined (preserves the look of existing milestones). */
  color?: string;
}
const MILE_KEY = (file: string) => `org-gui:milestones:${file}`;

function loadMilestones(file: string | null): Milestone[] {
  if (!file) return [];
  try {
    const raw = localStorage.getItem(MILE_KEY(file));
    return raw ? (JSON.parse(raw) as Milestone[]) : [];
  } catch {
    return [];
  }
}

function saveMilestones(file: string | null, ms: Milestone[]) {
  if (!file) return;
  try {
    localStorage.setItem(MILE_KEY(file), JSON.stringify(ms));
  } catch {
    /* non-fatal */
  }
}

// User's expanded/collapsed set, persisted per file. When absent (first open
// of a file), fall back to autoExpandForDeps so dependency arrows are visible.
const EXPANDED_KEY = (file: string) => `org-gui:expanded:${file}`;

function loadExpanded(file: string | null): Set<string> | null {
  if (!file) return null;
  try {
    const raw = localStorage.getItem(EXPANDED_KEY(file));
    if (!raw) return null;
    const arr = JSON.parse(raw) as string[];
    return new Set(arr);
  } catch {
    return null;
  }
}

function saveExpanded(file: string | null, ids: Set<string>) {
  if (!file) return;
  try {
    localStorage.setItem(EXPANDED_KEY(file), JSON.stringify([...ids]));
  } catch {
    /* non-fatal */
  }
}

// Per-file colour assignments for org tags. Tags with no entry stay untinted.
// Keyed by tag name (no leading/trailing colons).
const TAG_COLORS_KEY = (file: string) => `org-gui:tagcolors:${file}`;

function loadTagColors(file: string | null): Record<string, string> {
  if (!file) return {};
  try {
    const raw = localStorage.getItem(TAG_COLORS_KEY(file));
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveTagColors(file: string | null, c: Record<string, string>) {
  if (!file) return;
  try {
    localStorage.setItem(TAG_COLORS_KEY(file), JSON.stringify(c));
  } catch {
    /* non-fatal */
  }
}

// Per-file set of collapsed table keys (`${nodeId}:${tableStartLine}`).
// A collapsed table renders as a one-line "▸ Table (N × M)" summary instead of
// the full inline editor — useful when a node has a big table that's not the
// focus right now and would otherwise eat a lot of vertical space.
const TABLE_KEY = (file: string) => `org-gui:tablecol:${file}`;

function loadTableCollapsed(file: string | null): Set<string> {
  if (!file) return new Set();
  try {
    const raw = localStorage.getItem(TABLE_KEY(file));
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function saveTableCollapsed(file: string | null, s: Set<string>) {
  if (!file) return;
  try {
    localStorage.setItem(TABLE_KEY(file), JSON.stringify([...s]));
  } catch {
    /* non-fatal */
  }
}

// Milestone-timeline zoom + horizontal pan, persisted per file.
export type ZoomLevel = "fit" | "1w" | "2w" | "1m" | "3m" | "6m" | "1y";
export interface TimelineView {
  zoom: ZoomLevel;
  /** When zoom != "fit", the timestamp at the centre of the visible window. */
  centerMs: number;
}
const ZOOM_KEY = (file: string) => `org-gui:zoom:${file}`;

function loadTimelineView(file: string | null): TimelineView {
  const fallback: TimelineView = { zoom: "fit", centerMs: Date.now() };
  if (!file) return fallback;
  try {
    const raw = localStorage.getItem(ZOOM_KEY(file));
    if (!raw) return fallback;
    const v = JSON.parse(raw) as Partial<TimelineView>;
    if (!v || typeof v !== "object") return fallback;
    return {
      zoom: (v.zoom as ZoomLevel) ?? "fit",
      centerMs: typeof v.centerMs === "number" ? v.centerMs : Date.now(),
    };
  } catch {
    return fallback;
  }
}

function saveTimelineView(file: string | null, v: TimelineView) {
  if (!file) return;
  try {
    localStorage.setItem(ZOOM_KEY(file), JSON.stringify(v));
  } catch {
    /* non-fatal */
  }
}

// Whether to draw the organic metaball aura behind tagged nodes. Persisted
// globally so the user's preference survives reloads. Even when this is OFF,
// the filter view still draws the aura for the *filtered* tag — otherwise
// the filter loses its visual punch.
const TAG_AURA_KEY = "org-gui:tagAuraEnabled";

export function loadTagAuraEnabled(): boolean {
  try {
    return localStorage.getItem(TAG_AURA_KEY) !== "false";
  } catch {
    return true;
  }
}

function saveTagAuraEnabled(v: boolean) {
  try {
    localStorage.setItem(TAG_AURA_KEY, v ? "true" : "false");
  } catch {
    /* non-fatal */
  }
}

// Update channel — which manifest URL the "Check for updates" button reads from.
// Persisted globally (not per-file) so users opt in once.
export type UpdateChannel = "stable" | "experimental";
const CHANNEL_KEY = "org-gui:updateChannel";

export function loadUpdateChannel(): UpdateChannel {
  try {
    return localStorage.getItem(CHANNEL_KEY) === "experimental" ? "experimental" : "stable";
  } catch {
    return "stable";
  }
}

function saveUpdateChannel(c: UpdateChannel) {
  try {
    localStorage.setItem(CHANNEL_KEY, c);
  } catch {
    /* non-fatal */
  }
}

/**
 * Initial `expanded` set so every node that participates in a dependency (as a
 * prerequisite or a dependent) is visible: we expand the ancestor chains of all
 * such nodes. Dependency arrows only draw between visible nodes, so this makes
 * the dependency map show up on load instead of being hidden inside collapsed
 * subtrees.
 */
function autoExpandForDeps(doc: OrgDoc): Set<string> {
  const byId = new Map(doc.nodes.map((n) => [n.id, n] as const));
  const byOrgId = new Map<string, OrgNode>();
  for (const n of doc.nodes) if (n.orgId) byOrgId.set(n.orgId, n);

  const participating = new Set<string>();
  for (const n of doc.nodes) {
    const deps = n.dependsOn ?? [];
    if (deps.length === 0) continue;
    participating.add(n.id);
    for (const pid of deps) {
      const p = byOrgId.get(pid);
      if (p) participating.add(p.id);
    }
  }

  const expanded = new Set<string>();
  for (const id of participating) {
    let cur = byId.get(id);
    cur = cur?.parent ? byId.get(cur.parent) : undefined;
    while (cur) {
      expanded.add(cur.id);
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
  }
  return expanded;
}

/** Right-click context menu, anchored at the cursor. */
export interface ContextMenuState {
  x: number;
  y: number;
  nodeId: string;
}

interface OrgState {
  doc: OrgDoc | null;
  file: string | null;
  selectedId: string | null;
  /**
   * Nodes to emphasise (e.g. the transitive blockers of a clicked Blocked pill),
   * keyed by id with value = depth in the dependency chain (1 = direct
   * prerequisite, 2 = prereq-of-prereq, …). The OrgNode renders a gold ring
   * whose intensity falls with depth.
   */
  highlightDepth: Map<string, number>;
  /**
   * Prerequisites in that same chain that are already DONE. Rendered with a
   * green ring instead of gold so the user can see which parts of the
   * dependency tree are already satisfied at a glance. Walks stop at done
   * nodes — past dependencies of an already-done node aren't blockers.
   */
  highlightDone: Set<string>;
  /** Transient "flash" ring on a single node (used by timeline-double-click focus). */
  flashId: string | null;
  expanded: Set<string>;
  rootPositions: Record<number, { x: number; y: number }>;
  milestones: Milestone[];
  timelineView: TimelineView; // milestone-band zoom + pan
  tableCollapsed: Set<string>; // keys `${nodeId}:${startLine}` → folded tables
  tagColors: Record<string, string>; // tag name → CSS colour (per file)
  tagFilter: string | null; // when set, only nodes carrying this tag stay sharp
  tagAuraEnabled: boolean; // global toggle for the metaball halo overlay
  /** Currently-selected timeline chip (single click on a chip). Arrow keys
   *  nudge this chip's scheduled or deadline date. Esc clears. */
  timelineSelectedChip: { nodeId: string; isDeadline: boolean } | null;
  /** Multi-selection set for bulk operations (e.g. tag-many). Holds node ids.
   *  Separate from selectedId so the Details panel and ordinary single-select
   *  workflow don't interfere with bulk gestures. */
  multiSelected: Set<string>;
  updateChannel: UpdateChannel;
  contextMenu: ContextMenuState | null;
  dropTargetId: string | null;
  editBegin: number; // subtree the Emacs sidebar narrows to (0 = whole file)
  panel: PanelTab; // right-side pull-out panel
  depMode: boolean; // dependency-drawing mode in the graph
  // Live state while dragging a dependency link in dep mode (for node indicators)
  connectFrom: string | null; // node id the drag started on
  connectHover: string | null; // node id currently under the cursor
  connectValid: boolean; // whether dropping on connectHover would be a valid link
  loading: boolean;
  saving: boolean;
  error: string | null;
  emacsOk: boolean | null;

  checkEmacs: () => Promise<void>;
  loadFile: (file: string) => Promise<void>;
  reload: () => Promise<void>;
  refreshDoc: () => Promise<void>;
  toggleCheckbox: (node: OrgNode, index: number) => Promise<void>;
  select: (id: string | null) => void;
  highlightBlockers: (node: OrgNode) => void;
  flashNode: (id: string) => void;
  setPanel: (p: PanelTab) => void;
  setDepMode: (on: boolean) => void;
  setConnectDrag: (from: string | null, hover: string | null, valid: boolean) => void;
  addDependency: (fromNode: OrgNode, toNode: OrgNode) => Promise<void>;
  removeDependency: (fromNode: OrgNode, toNode: OrgNode) => Promise<void>;
  editInEmacs: (node: OrgNode) => void;
  toggleExpand: (id: string) => void;
  setRootPosition: (index: number, x: number, y: number) => void;
  addMilestone: (iso: string, label?: string) => string;
  updateMilestone: (id: string, patch: Partial<Pick<Milestone, "iso" | "label" | "color">>) => void;
  removeMilestone: (id: string) => void;
  toggleTableCollapsed: (nodeId: string, startLine: number) => void;
  setTagColor: (tag: string, color: string | null) => void;
  setTagFilter: (tag: string | null) => void;
  setTagAuraEnabled: (v: boolean) => void;
  setTimelineSelectedChip: (chip: { nodeId: string; isDeadline: boolean } | null) => void;
  scheduleNode: (node: OrgNode, dateStr: string, kind: "scheduled" | "deadline") => Promise<void>;
  toggleMultiSelected: (id: string) => void;
  clearMultiSelected: () => void;
  applyTagToSelection: (tag: string) => Promise<void>;
  applyTagToNode: (node: OrgNode, tag: string) => Promise<void>;
  setTimelineView: (v: Partial<TimelineView>) => void;
  setUpdateChannel: (c: UpdateChannel) => void;
  openContextMenu: (x: number, y: number, nodeId: string) => void;
  closeContextMenu: () => void;
  setDropTarget: (id: string | null) => void;
  reorder: (node: OrgNode, delta: number) => Promise<void>;
  refile: (node: OrgNode, targetBegin: number) => Promise<void>;
  start: (node: OrgNode) => Promise<void>;
  archive: (node: OrgNode) => Promise<void>;
  edit: (apiFn: Mutator, node: OrgNode, value: string) => Promise<void>;
  setBody: (node: OrgNode, body: string) => Promise<void>;
  addTableChild: (parentNode: OrgNode | null) => Promise<void>;
  clearError: () => void;
  createFile: (file: string, title: string) => Promise<void>;
  addHeading: (parentBegin: number, title: string) => Promise<void>;
  removeNode: (node: OrgNode) => Promise<void>;
  saveSubtree: (begin: number, text: string) => Promise<void>;
  saveFile: (text: string) => Promise<void>;
}

export const useOrgStore = create<OrgState>((set, get) => ({
  doc: null,
  file: null,
  selectedId: null,
  highlightDepth: new Map<string, number>(),
  highlightDone: new Set<string>(),
  flashId: null,
  expanded: new Set<string>(),
  rootPositions: {},
  milestones: [],
  timelineView: { zoom: "fit", centerMs: Date.now() },
  tableCollapsed: new Set<string>(),
  tagColors: {},
  tagFilter: null,
  tagAuraEnabled: loadTagAuraEnabled(),
  timelineSelectedChip: null,
  multiSelected: new Set<string>(),
  updateChannel: loadUpdateChannel(),
  contextMenu: null,
  dropTargetId: null,
  editBegin: 0,
  panel: null,
  depMode: false,
  connectFrom: null,
  connectHover: null,
  connectValid: false,
  loading: false,
  saving: false,
  error: null,
  emacsOk: null,

  checkEmacs: async () => {
    try {
      await pingEmacs();
      set({ emacsOk: true });
    } catch (e) {
      set({ emacsOk: false, error: String(e) });
    }
  },

  loadFile: async (file: string) => {
    set({
      loading: true,
      error: null,
      file,
      expanded: new Set<string>(),
      rootPositions: loadPositions(file),
      milestones: loadMilestones(file),
      timelineView: loadTimelineView(file),
      tableCollapsed: loadTableCollapsed(file),
      tagColors: loadTagColors(file),
      tagFilter: null,
      multiSelected: new Set<string>(),
      editBegin: 0,
    });
    try {
      const doc = await parseOrg(file);
      // Prefer the user's persisted expand/collapse choices for this file;
      // fall back to autoExpandForDeps on first open (so dep arrows are visible).
      const saved = loadExpanded(file);
      const expanded = saved ?? autoExpandForDeps(doc);
      if (!saved) saveExpanded(file, expanded);
      set({ doc, loading: false, emacsOk: true, expanded });
      rememberLastFile(file);
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  reload: async () => {
    const f = get().file;
    if (f) await get().loadFile(f);
  },

  // Soft refresh: re-parse the file and update the doc WITHOUT touching layout
  // state (expanded set, root positions, selection). Used to keep the graph in
  // sync with live edits made in the embedded Emacs editor. No-ops the update
  // when nothing changed so we don't churn the graph while the user types.
  refreshDoc: async () => {
    const { file, doc } = get();
    if (!file) return;
    try {
      const fresh = await parseOrg(file);
      const a = JSON.stringify(fresh.nodes);
      const b = JSON.stringify(doc?.nodes ?? null);
      if (a !== b) set({ doc: fresh });
    } catch {
      /* transient parse error while the buffer is mid-edit — ignore */
    }
  },

  toggleCheckbox: async (node, index) => {
    const { file, doc } = get();
    if (!file || !doc) return;
    try {
      const newDoc = await apiToggleCheckbox(file, node.begin, index);
      set({ doc: newDoc });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  select: (id) =>
    set((s) => ({
      selectedId: id,
      highlightDepth: new Map(),
      highlightDone: new Set(),
      // The Details drawer has nothing to render with no selection; auto-close
      // it so the user doesn't end up staring at an empty pulled-out panel.
      panel: id === null && s.panel === "details" ? null : s.panel,
    })),

  // Clicking a "Blocked" node: emphasise the *transitive* chain of prerequisites
  // still blocking it (gold, dimmed by depth), plus the prerequisites already
  // marked DONE (green) so the user can see at a glance which parts of the
  // chain are already satisfied. The walk stops at done nodes — past
  // dependencies of an already-done node aren't blocking anything anymore.
  highlightBlockers: (node) => {
    const { doc, expanded } = get();
    if (!doc) return;
    const byId = new Map(doc.nodes.map((n) => [n.id, n] as const));
    const byOrgId = new Map<string, OrgNode>();
    for (const n of doc.nodes) if (n.orgId) byOrgId.set(n.orgId, n);

    const depth = new Map<string, number>(); // gold: still blocking
    const done = new Set<string>(); // green: already satisfied
    const queue: Array<{ node: OrgNode; d: number }> = [{ node, d: 0 }];
    while (queue.length) {
      const { node: cur, d } = queue.shift()!;
      for (const pid of cur.dependsOn ?? []) {
        const p = byOrgId.get(pid);
        if (!p) continue;
        if (p.done) {
          // Already satisfied: tint green, don't recurse — its own prereqs
          // are also irrelevant to the still-blocking question.
          done.add(p.id);
          continue;
        }
        if (depth.has(p.id)) continue; // BFS — first visit is shortest
        depth.set(p.id, d + 1);
        queue.push({ node: p, d: d + 1 });
      }
    }
    if (depth.size === 0 && done.size === 0) return;

    // Expand ancestor chains so every highlighted node is actually rendered.
    const exp = new Set(expanded);
    const expandAncestors = (id: string) => {
      let cur: OrgNode | undefined = byId.get(id);
      cur = cur?.parent ? byId.get(cur.parent) : undefined;
      while (cur) {
        exp.add(cur.id);
        cur = cur.parent ? byId.get(cur.parent) : undefined;
      }
    };
    for (const id of depth.keys()) expandAncestors(id);
    for (const id of done) expandAncestors(id);

    set({ selectedId: node.id, highlightDepth: depth, highlightDone: done, expanded: exp });
  },

  setPanel: (p) => {
    const prev = get().panel;
    set({ panel: p });
    // Re-read the file when leaving the Emacs editor (to pick up edits) or when
    // opening the Agenda (to show the latest scheduled items).
    const needsReload = (prev === "emacs" && p !== "emacs") || p === "agenda";
    if (needsReload && get().file) get().reload();
  },

  // Dependency mode is a graph overlay; entering it collapses the pull-out so
  // the graph is full-width for drawing.
  setDepMode: (on) =>
    set(on ? { depMode: true, panel: null } : { depMode: false, connectFrom: null, connectHover: null, connectValid: false }),

  setConnectDrag: (from, hover, valid) => set({ connectFrom: from, connectHover: hover, connectValid: valid }),

  addDependency: async (fromNode, toNode) => {
    const { file, doc } = get();
    if (!file || !doc || fromNode.id === toNode.id) return;
    // Refuse a link that would create a dependency cycle (A→B→C→A).
    if (wouldCreateCycle(fromNode, toNode, doc)) {
      set({ error: "Can't link — that would create a dependency cycle." });
      return;
    }
    set({ saving: true, error: null });
    try {
      const newDoc = await apiAddDependency(file, fromNode.begin, toNode.begin);
      set({ doc: newDoc, saving: false });
    } catch (e) {
      set({ error: String(e), saving: false });
    }
  },

  removeDependency: async (fromNode, toNode) => {
    const { file, doc } = get();
    if (!file || !doc) return;
    set({ saving: true, error: null });
    try {
      const newDoc = await apiRemoveDependency(file, fromNode.begin, toNode.begin);
      set({ doc: newDoc, saving: false });
    } catch (e) {
      set({ error: String(e), saving: false });
    }
  },

  editInEmacs: (node) => set({ selectedId: node.id, editBegin: node.begin, panel: "emacs" }),

  toggleExpand: (id) =>
    set((s) => {
      const e = new Set(s.expanded);
      if (e.has(id)) e.delete(id);
      else e.add(id);
      saveExpanded(s.file, e);
      return { expanded: e };
    }),

  flashNode: (id) => {
    set({ flashId: id });
    // Self-clear after the CSS pulse finishes so repeated flashes restart cleanly.
    window.setTimeout(() => {
      const cur = get().flashId;
      if (cur === id) set({ flashId: null });
    }, 1600);
  },

  toggleTableCollapsed: (nodeId, startLine) =>
    set((s) => {
      const key = `${nodeId}:${startLine}`;
      const next = new Set(s.tableCollapsed);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveTableCollapsed(s.file, next);
      return { tableCollapsed: next };
    }),

  setTagColor: (tag, color) =>
    set((s) => {
      const next = { ...s.tagColors };
      if (color) next[tag] = color;
      else delete next[tag];
      saveTagColors(s.file, next);
      return { tagColors: next };
    }),

  setTagFilter: (tag) => set({ tagFilter: tag }),

  setTagAuraEnabled: (v) => {
    saveTagAuraEnabled(v);
    set({ tagAuraEnabled: v });
  },

  setTimelineSelectedChip: (chip) => set({ timelineSelectedChip: chip }),

  /**
   * Commit a scheduled or deadline date for NODE, but only after
   * cross-checking against the dependency graph. If a prerequisite would
   * end up later than its dependent (or vice versa), set the store's
   * error field (surfacing a toast) and skip the bridge call.
   */
  scheduleNode: async (node, dateStr, kind) => {
    const { doc } = get();
    if (!doc) return;
    // Validation only applies to "scheduled" dates; deadlines aren't
    // required by org-mode's dependency semantics (you can have a
    // deadline later than a prerequisite — it's still your problem to
    // finish on time, but it's not an ordering violation).
    if (kind === "scheduled") {
      const err = validateScheduleAgainstDeps(node.id, dateStr, doc);
      if (err) {
        set({ error: err });
        return;
      }
    }
    await get().edit(kind === "scheduled" ? apiSetScheduled : apiSetDeadline, node, dateStr);
  },

  toggleMultiSelected: (id) =>
    set((s) => {
      const next = new Set(s.multiSelected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { multiSelected: next };
    }),

  clearMultiSelected: () => set({ multiSelected: new Set() }),

  applyTagToSelection: async (tag) => {
    const { file, doc, multiSelected } = get();
    const t = tag.trim();
    if (!file || !doc || !t || multiSelected.size === 0) return;
    const begins = doc.nodes.filter((n) => multiSelected.has(n.id)).map((n) => n.begin);
    if (begins.length === 0) return;
    set({ saving: true, error: null });
    try {
      const newDoc = await apiAddTagMany(file, begins, t);
      set({ doc: newDoc, saving: false });
    } catch (e) {
      set({ error: String(e), saving: false });
    }
  },

  applyTagToNode: async (node, tag) => {
    const { file, doc } = get();
    const t = tag.trim();
    if (!file || !doc || !t) return;
    set({ saving: true, error: null });
    try {
      const newDoc = await apiAddTagMany(file, [node.begin], t);
      set({ doc: newDoc, saving: false });
    } catch (e) {
      set({ error: String(e), saving: false });
    }
  },

  setTimelineView: (v) =>
    set((s) => {
      const next = { ...s.timelineView, ...v };
      saveTimelineView(s.file, next);
      return { timelineView: next };
    }),

  setUpdateChannel: (c) => {
    saveUpdateChannel(c);
    set({ updateChannel: c });
  },

  openContextMenu: (x, y, nodeId) => set({ contextMenu: { x, y, nodeId } }),
  closeContextMenu: () => set({ contextMenu: null }),

  setRootPosition: (index, x, y) =>
    set((s) => {
      const rootPositions = { ...s.rootPositions, [index]: { x, y } };
      savePositions(s.file, rootPositions);
      return { rootPositions };
    }),

  addMilestone: (iso, label = "Milestone") => {
    const id = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    set((s) => {
      const milestones = [...s.milestones, { id, iso, label }];
      saveMilestones(s.file, milestones);
      return { milestones };
    });
    return id;
  },

  updateMilestone: (id, patch) =>
    set((s) => {
      const milestones = s.milestones.map((m) => (m.id === id ? { ...m, ...patch } : m));
      saveMilestones(s.file, milestones);
      return { milestones };
    }),

  removeMilestone: (id) =>
    set((s) => {
      const milestones = s.milestones.filter((m) => m.id !== id);
      saveMilestones(s.file, milestones);
      return { milestones };
    }),

  setDropTarget: (id) => set((s) => (s.dropTargetId === id ? s : { dropTargetId: id })),

  reorder: async (node, delta) => {
    const { file, doc } = get();
    if (!file || !doc || delta === 0) return;
    set({ saving: true, error: null });
    try {
      const newDoc = await apiReorderNode(file, node.begin, delta);
      set({ doc: newDoc, saving: false });
    } catch (e) {
      set({ error: String(e), saving: false });
    }
  },

  refile: async (node, targetBegin) => {
    const { file, doc } = get();
    if (!file || !doc) return;
    set({ saving: true, error: null });
    try {
      const newDoc = await apiRefileNode(file, node.begin, targetBegin);
      set({ doc: newDoc, saving: false });
    } catch (e) {
      set({ error: String(e), saving: false });
    }
  },

  start: async (node) => {
    const { file, doc } = get();
    if (!file || !doc) return;
    // Block: can't start a task whose prerequisites aren't done yet.
    const blockers = incompleteDeps(node, doc);
    if (blockers.length) {
      const names = blockers.map((b) => b.title ?? "untitled").join(", ");
      set({ error: `Can't start — finish prerequisite(s) first: ${names}` });
      return;
    }
    set({ saving: true, error: null });
    try {
      const newDoc = await apiStartTask(file, node.begin);
      set({ doc: newDoc, saving: false });
    } catch (e) {
      set({ error: String(e), saving: false });
    }
  },

  archive: async (node) => {
    const { file, doc } = get();
    if (!file || !doc) return;
    set({ saving: true, error: null });
    try {
      const newDoc = await apiArchiveNode(file, node.begin);
      set({ doc: newDoc, selectedId: null, saving: false });
    } catch (e) {
      set({ error: String(e), saving: false });
    }
  },

  edit: async (apiFn, node, value) => {
    const { file, doc, selectedId: prevSel } = get();
    if (!file || !doc) return;
    // Document index is stable across field edits (they never reorder
    // headings), so we use it to keep the SAME node selected afterwards
    // when it was already the selection. Otherwise we leave the selection
    // alone: clicking a state pill or checkbox on a non-selected node
    // shouldn't yank the DetailPanel onto that node.
    const idx = doc.nodes.findIndex((n) => n.id === node.id);
    set({ saving: true, error: null });
    try {
      const newDoc = await apiFn(file, node.begin, value);
      const tracked = idx >= 0 ? (newDoc.nodes[idx]?.id ?? null) : null;
      const newSel = prevSel === node.id ? tracked : prevSel;
      set({ doc: newDoc, selectedId: newSel, saving: false });
    } catch (e) {
      set({ error: String(e), saving: false });
    }
  },

  clearError: () => set({ error: null }),

  setBody: async (node, body) => {
    const { file, doc } = get();
    if (!file || !doc) return;
    set({ saving: true, error: null });
    try {
      const newDoc = await apiSetBody(file, node.begin, body);
      set({ doc: newDoc, saving: false });
    } catch (e) {
      set({ error: String(e), saving: false });
    }
  },

  addTableChild: async (parentNode) => {
    const { file, doc } = get();
    if (!file || !doc) return;
    const parentBegin = parentNode ? parentNode.begin : 0;
    set({ saving: true, error: null });
    try {
      const newDoc = await apiAddTableChild(file, parentBegin);
      // Expand the parent (if any) so the new "Table" child is visible.
      let expanded = get().expanded;
      if (parentNode) {
        expanded = new Set(expanded);
        expanded.add(parentNode.id);
        saveExpanded(file, expanded);
      }
      set({ doc: newDoc, expanded, saving: false });
    } catch (e) {
      set({ error: String(e), saving: false });
    }
  },

  createFile: async (file, title) => {
    set({ loading: true, error: null, file });
    try {
      const doc = await apiCreateOrg(file, title);
      set({ doc, loading: false, selectedId: null });
      rememberLastFile(file);
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  addHeading: async (parentBegin, title) => {
    const { file, doc } = get();
    if (!file || !doc) return;
    set({ saving: true, error: null });
    try {
      const newDoc = await apiAddHeading(file, parentBegin, title);
      // Best-effort: select the just-added heading (last one with this title).
      // It appears inside its parent's text block automatically.
      const placeholder = title || "New heading";
      const matches = newDoc.nodes.filter((n) => n.title === placeholder);
      const child = matches.length ? matches[matches.length - 1] : null;
      const sel = child ? child.id : null;
      // Expand the parent so the new child node is visible.
      const expanded = new Set(get().expanded);
      if (child?.parent) expanded.add(child.parent);
      set({ doc: newDoc, selectedId: sel, expanded, saving: false });
      // Pan the React Flow viewport to the new node and flash it. Top-level
      // headings get appended after the last root and would otherwise drop
      // off-screen — the user had to hunt for them; this surfaces them.
      if (sel) {
        // Defer one tick so the layout has been rebuilt with the new node
        // before TimelineGraph's focus listener queries rf.getNode(sel).
        requestAnimationFrame(() => {
          window.dispatchEvent(
            new CustomEvent("orggui:focusNode", { detail: { id: sel } }),
          );
        });
      }
    } catch (e) {
      set({ error: String(e), saving: false });
    }
  },

  removeNode: async (node) => {
    const { file, doc } = get();
    if (!file || !doc) return;
    set({ saving: true, error: null });
    try {
      const newDoc = await apiDeleteNode(file, node.begin);
      set({ doc: newDoc, selectedId: null, saving: false });
    } catch (e) {
      set({ error: String(e), saving: false });
    }
  },

  saveSubtree: async (begin, text) => {
    const { file, doc } = get();
    if (!file || !doc) return;
    set({ saving: true, error: null });
    try {
      const newDoc = await apiSetSubtree(file, begin, text);
      set({ doc: newDoc, saving: false });
    } catch (e) {
      set({ error: String(e), saving: false });
    }
  },

  saveFile: async (text) => {
    const { file, doc } = get();
    if (!file || !doc) return;
    set({ saving: true, error: null });
    try {
      const newDoc = await apiSetFile(file, text);
      set({ doc: newDoc, saving: false });
    } catch (e) {
      set({ error: String(e), saving: false });
    }
  },
}));
