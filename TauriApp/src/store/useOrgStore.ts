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
  setTimestampRange as apiSetTimestampRange,
  setSpan as apiSetSpan,
  gcalMove as apiGcalMove,
  gcalSync as apiGcalSync,
  incompleteDeps,
  validateScheduleAgainstDeps,
  wouldCreateCycle,
  parseOrg,
  pingEmacs,
  pathExists,
  IN_TAURI,
} from "../api/org";
import {
  DEFAULT_GOOGLE_CLIENT_ID,
  DEFAULT_GOOGLE_CLIENT_SECRET,
  HAS_DEFAULT_GOOGLE_CLIENT,
} from "../config/google";

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

// Per-file state (positions, expanded set, milestones, tag colours) already
// persists per absolute path. The list of OPEN tabs is its own thing: which
// files the user currently has docked in the top-of-window tab strip. We
// store it as a plain array of absolute paths. Switching tabs simply calls
// loadFile(path) again, which re-parses the file but pulls back its
// per-file localStorage state, so each tab feels independent.
const OPEN_TABS_KEY = "org-gui:openTabs";
function loadOpenTabs(): string[] {
  if (!IN_TAURI) return [];
  try {
    const raw = localStorage.getItem(OPEN_TABS_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function saveOpenTabs(tabs: string[]) {
  if (!IN_TAURI) return;
  try {
    localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(tabs));
  } catch {
    /* non-fatal */
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

// ── Google Calendar: id → {summary, colour}, written by GcalPanel after a
// calendar-list fetch. Used to tag + colour imported events BY CALENDAR on the
// timeline, without writing literal org tags (which would pollute the event
// titles pushed back to Google).
const GCAL_CALS_KEY = "org-gui:gcal:calendars";
type GcalCalMap = Record<string, { summary: string; color: string | null }>;
function loadGcalCalMap(): GcalCalMap {
  try {
    const raw = localStorage.getItem(GCAL_CALS_KEY);
    return raw ? (JSON.parse(raw) as GcalCalMap) : {};
  } catch {
    return {};
  }
}
/** Tag each gcal node (by calendar-id) with its calendar name and fold the
 *  calendar's Google colour into the per-file tag colours (user overrides win).
 *  Mutates doc nodes in place; returns the merged tag-colour map. */
function applyGcalCalendarTags(
  doc: OrgDoc,
  tagColors: Record<string, string>,
): Record<string, string> {
  const cals = loadGcalCalMap();
  if (Object.keys(cals).length === 0) return tagColors;
  const merged = { ...tagColors };
  for (const n of doc.nodes) {
    const cal = n.calendarId ? cals[n.calendarId] : undefined;
    if (!cal || !cal.summary) continue;
    // tagsAll ONLY (drives colour/filter) — NOT n.tags. n.tags are the node's
    // own, editable/removable tags; the calendar tag is a derived, locked one
    // and must not leak into the file (or into `setTags` writes).
    if (!n.tagsAll.includes(cal.summary)) n.tagsAll = [...n.tagsAll, cal.summary];
    if (cal.color && !merged[cal.summary]) merged[cal.summary] = cal.color;
  }
  return merged;
}

/** Re-inject Google-calendar tags into a FRESHLY-parsed bridge doc, in place.
 *  Bridge mutators return a raw parse that lacks the frontend-only calendar
 *  tags; without this, ANY edit (set-tags, schedule, todo, …) strips the
 *  calendar colours/auras from every node until the next loadFile — which read
 *  as "removing one tag wiped all tags from all nodes". The calendar COLOURS
 *  already live in state.tagColors (merged at loadFile), so we only need to
 *  restore the tagsAll membership here. Returns the same doc for chaining. */
function reapplyGcalTags<T extends OrgDoc | null | undefined>(doc: T): T {
  if (doc) applyGcalCalendarTags(doc, {});
  return doc;
}

// ── Google Calendar "ghost" moves ─────────────────────────────────────────
// When the user shifts a Google-calendar event on the timeline, we move it
// LOCALLY in the .org file (so there's exactly one entry, no duplicate) but
// remember where Google still has it — a "ghost" of the original. The timeline
// draws that ghost with a connecting line and a "Sync calendar" button; the
// push to Google happens only when the user clicks Sync. Keyed by orgId (the
// org-gcal :ID:, stable across reparses; node `begin` ids are not).
export interface GcalGhost {
  orgId: string;
  calendarId: string;
  title: string;
  startMs: number; // ORIGINAL (Google) start instant
  endMs: number | null; // ORIGINAL end instant (null = a point event)
  hasStartTime: boolean;
  hasEndTime: boolean;
}
const GCAL_GHOST_KEY = (file: string) => `org-gui:gcalghost:${file}`;
function loadGcalGhosts(file: string | null): Record<string, GcalGhost> {
  if (!file) return {};
  try {
    const raw = localStorage.getItem(GCAL_GHOST_KEY(file));
    return raw ? (JSON.parse(raw) as Record<string, GcalGhost>) : {};
  } catch {
    return {};
  }
}
function saveGcalGhosts(file: string | null, g: Record<string, GcalGhost>) {
  if (!file) return;
  try {
    localStorage.setItem(GCAL_GHOST_KEY(file), JSON.stringify(g));
  } catch {
    /* non-fatal */
  }
}
/** Load FILE's ghosts, dropping any whose node no longer exists in DOC (e.g.
 *  the event was deleted, or already reconciled by a real sync). Without this,
 *  a phantom ghost would inflate the "Sync (N)" count forever with nothing the
 *  user can click. Persists the pruned set so the GC is durable. */
function pruneGcalGhosts(file: string | null, doc: OrgDoc): Record<string, GcalGhost> {
  const all = loadGcalGhosts(file);
  const ids = new Set(doc.nodes.map((n) => n.orgId).filter((x): x is string => !!x));
  const kept: Record<string, GcalGhost> = {};
  for (const [orgId, g] of Object.entries(all)) if (ids.has(orgId)) kept[orgId] = g;
  if (Object.keys(kept).length !== Object.keys(all).length) saveGcalGhosts(file, kept);
  return kept;
}

/** Tag names that are DERIVED from a Google calendar (a calendar's summary).
 *  These are auto-applied to imported events and must NOT be user-removable. */
export function gcalCalendarTagSet(): Set<string> {
  const cals = loadGcalCalMap();
  const s = new Set<string>();
  for (const id of Object.keys(cals)) {
    if (cals[id]?.summary) s.add(cals[id].summary);
  }
  return s;
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

// Top-of-window calendar timeline visibility. Persisted globally so the
// user's preference (often hidden when working on a deep edit, or shown
// when planning) sticks across launches. Defaults to ON — the timeline
// is the visual centrepiece for first-time users.
const SHOW_TIMELINE_KEY = "org-gui:showTimeline";
function loadShowTimeline(): boolean {
  try {
    return localStorage.getItem(SHOW_TIMELINE_KEY) !== "false";
  } catch {
    return true;
  }
}
function saveShowTimeline(v: boolean) {
  try {
    localStorage.setItem(SHOW_TIMELINE_KEY, v ? "true" : "false");
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
  showTimeline: boolean; // top-of-window calendar timeline visibility
  /** Currently-selected timeline chip (single click on a chip). Arrow keys
   *  nudge this chip's scheduled or deadline date. Esc clears. */
  timelineSelectedChip: { nodeId: string; isDeadline: boolean } | null;
  /** Google-calendar events moved locally but not yet pushed to Google, keyed
   *  by orgId. The timeline draws a "ghost" at the original position + a Sync
   *  button. `gcalSyncing` is true while a push is in flight. */
  gcalGhosts: Record<string, GcalGhost>;
  gcalSyncing: boolean;
  gcalSyncError: string | null;
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
  // Open files in the top tab strip. The active tab is whichever path
  // equals `file`. Order matches user insertion (most recent open last).
  openTabs: string[];
  // The file the user just clicked but whose parse hasn't completed yet.
  // The TabBar highlights this so the click feels instant, while the
  // graph keeps rendering the previous doc until the new one is ready.
  // Doubles as a stale-load discriminator: a parse result is only applied
  // when its file still equals loadingFile (otherwise the user has moved
  // on and the result is stale).
  loadingFile: string | null;
  scheduleMode: boolean; // drag-node-to-timeline scheduling mode
  // The nodeId of the node currently being dragged from the graph in
  // schedule mode. Null when no drag is in progress. The timeline reads
  // this to know whose schedule to set on drop.
  scheduleDragNodeId: string | null;
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
  /** Restore the previous session on launch: re-populate the tab strip with
   *  every previously-open file that still exists on disk, then load the
   *  last-active one. */
  restoreSession: () => Promise<void>;
  reload: () => Promise<void>;
  refreshDoc: () => Promise<void>;
  toggleCheckbox: (node: OrgNode, index: number) => Promise<void>;
  select: (id: string | null) => void;
  highlightBlockers: (node: OrgNode) => void;
  flashNode: (id: string) => void;
  setPanel: (p: PanelTab) => void;
  setDepMode: (on: boolean) => void;
  setScheduleMode: (on: boolean) => void;
  setScheduleDragNode: (id: string | null) => void;
  /** Close a tab. If it was the active one, switch to the next/previous
   *  remaining tab — or to the empty state when nothing's left. */
  closeTab: (file: string) => Promise<void>;
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
  setShowTimeline: (v: boolean) => void;
  setTimelineSelectedChip: (chip: { nodeId: string; isDeadline: boolean } | null) => void;
  scheduleNode: (node: OrgNode, dateStr: string, kind: "scheduled" | "deadline") => Promise<void>;
  /** Move a Google-calendar event LOCALLY (rewrite its body timestamp in
   *  place — no SCHEDULED line, so org-gcal can still push it and there's no
   *  duplicate) and record a ghost of where Google still has it. `orig` is the
   *  event's pre-move position; only the FIRST move per event records it. */
  moveGcalEvent: (
    node: OrgNode,
    start: string,
    end: string,
    orig: { startMs: number; endMs: number | null; hasStartTime: boolean; hasEndTime: boolean },
  ) => Promise<void>;
  /** Forget a ghost without pushing (the local move stays). */
  clearGcalGhost: (orgId: string) => void;
  /** Push all pending local moves to Google (two-way sync), then clear ghosts. */
  syncGcalNow: () => Promise<void>;
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
  /** Set (or clear) a node's plain active-timestamp span — a duration.
   *  start/end are "YYYY-MM-DD" or "YYYY-MM-DD HH:MM"; both empty removes it. */
  setNodeRange: (node: OrgNode, start: string, end: string) => Promise<void>;
  /** Set a node's span/duration, routed by the bridge to a SCHEDULED
   *  time-range (same-day) or a plain timestamp range (multi-day). */
  setNodeSpan: (node: OrgNode, start: string, end: string) => Promise<void>;
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
  showTimeline: loadShowTimeline(),
  timelineSelectedChip: null,
  gcalGhosts: {},
  gcalSyncing: false,
  gcalSyncError: null,
  multiSelected: new Set<string>(),
  updateChannel: loadUpdateChannel(),
  contextMenu: null,
  dropTargetId: null,
  editBegin: 0,
  panel: null,
  depMode: false,
  openTabs: loadOpenTabs(),
  loadingFile: null,
  scheduleMode: false,
  scheduleDragNodeId: null,
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
    // Insert into the tab list on first load. Re-loading an already-open
    // tab (e.g. tab switch) is a no-op for the list — keeps the order
    // stable.
    const currentTabs = get().openTabs;
    const nextTabs = currentTabs.includes(file) ? currentTabs : [...currentTabs, file];
    if (nextTabs !== currentTabs) saveOpenTabs(nextTabs);
    // Mark the target file as loading WITHOUT changing the active doc/
    // positions/milestones yet. The previous version reset all of that
    // up-front, which meant the graph rendered the old doc against the
    // new file's positions for the duration of the parse — visible as a
    // jumpy / glitchy tab switch. Now we keep the previous tab fully
    // rendered until we have a complete new state to swap to atomically.
    set({
      loading: true,
      error: null,
      openTabs: nextTabs,
      loadingFile: file,
    });
    try {
      const doc = await parseOrg(file);
      // If the user clicked yet another tab while this parse was in
      // flight, the more recent click owns loadingFile — drop this stale
      // result so we don't suddenly swap to an old target.
      if (get().loadingFile !== file) return;
      const saved = loadExpanded(file);
      const expanded = saved ?? autoExpandForDeps(doc);
      if (!saved) saveExpanded(file, expanded);
      // Tag + colour imported Google-Calendar events by their calendar.
      const mergedTagColors = applyGcalCalendarTags(doc, loadTagColors(file));
      // Atomic swap: every piece of per-file state lands in a single
      // set() so React never observes a frame where they disagree.
      set({
        file,
        doc,
        loading: false,
        loadingFile: null,
        emacsOk: true,
        expanded,
        rootPositions: loadPositions(file),
        milestones: loadMilestones(file),
        timelineView: loadTimelineView(file),
        tableCollapsed: loadTableCollapsed(file),
        tagColors: mergedTagColors,
        tagFilter: null,
        multiSelected: new Set<string>(),
        editBegin: 0,
        // Also clear cross-doc transient selections so a node id from
        // tab A doesn't accidentally match an id in tab B.
        selectedId: null,
        highlightDepth: new Map<string, number>(),
        highlightDone: new Set<string>(),
        timelineSelectedChip: null,
        gcalGhosts: pruneGcalGhosts(file, doc),
        // A failed-sync badge belongs to the file it failed on; don't let it
        // ghost onto another file's Sync button.
        gcalSyncError: null,
        gcalSyncing: false,
      });
      rememberLastFile(file);
    } catch (e) {
      if (get().loadingFile === file) {
        set({ error: String(e), loading: false, loadingFile: null });
      }
    }
  },

  restoreSession: async () => {
    // The persisted open-tab list (read into the store at init) plus the
    // single "last active" file. We re-validate each tab against the disk —
    // a file the user moved or deleted since last launch is silently
    // dropped rather than left as a dead tab that errors on click.
    const persisted = get().openTabs;
    const last = lastOpenedFile();
    // Legacy / single-file fallback: older builds (pre-multi-tab) only ever
    // recorded `lastFile`, never `openTabs`. Seed the candidate list from it
    // so upgrading users still get their last file back.
    const candidates = persisted.length > 0 ? persisted : last ? [last] : [];
    if (candidates.length === 0) return;

    const alive: string[] = [];
    for (const f of candidates) {
      try {
        if (await pathExists(f)) alive.push(f);
      } catch {
        // If the existence check itself fails, keep the tab — better to
        // show a tab that errors on click than to silently drop a file
        // that's actually there.
        alive.push(f);
      }
    }
    if (alive.length === 0) {
      // Every remembered file is gone — clear the stale list so we don't
      // keep re-checking dead paths every launch.
      saveOpenTabs([]);
      set({ openTabs: [] });
      return;
    }
    // Persist the pruned list and reflect it immediately so the whole strip
    // is visible before any parse completes.
    saveOpenTabs(alive);
    set({ openTabs: alive });
    // Activate the previous active tab if it survived, else the last one.
    const active = last && alive.includes(last) ? last : alive[alive.length - 1];
    await get().loadFile(active);
    // Cold-start race guard: checkEmacs() and this restore both fire on
    // launch and both spin up the daemon. If the very first parse lost that
    // race and failed (doc still null — on error loadFile leaves `file`
    // unset, so we can't key on it), give the daemon a moment to finish
    // binding and try the active file once more, so the user lands on their
    // file instead of an error panel they'd have to dismiss manually.
    if (!get().doc && get().loadingFile == null) {
      await new Promise((r) => setTimeout(r, 1200));
      if (!get().doc && get().loadingFile == null && get().openTabs.includes(active)) {
        await get().loadFile(active);
      }
    }
  },

  closeTab: async (file: string) => {
    const { openTabs, file: active } = get();
    const idx = openTabs.indexOf(file);
    if (idx === -1) return;
    const remaining = openTabs.filter((p) => p !== file);
    saveOpenTabs(remaining);
    if (file !== active) {
      // Just remove from the strip — active tab is unaffected.
      set({ openTabs: remaining });
      return;
    }
    // Active tab being closed: switch to a neighbour, or empty out if none.
    const fallback = remaining[Math.max(0, idx - 1)] ?? remaining[0];
    if (fallback) {
      set({ openTabs: remaining });
      await get().loadFile(fallback);
    } else {
      // No tabs left → return to empty state.
      set({
        openTabs: [],
        file: null,
        doc: null,
        loading: false,
        loadingFile: null,
        error: null,
        expanded: new Set<string>(),
        rootPositions: {},
        milestones: [],
        tagColors: {},
        tagFilter: null,
        multiSelected: new Set<string>(),
        editBegin: 0,
        selectedId: null,
        highlightDepth: new Map<string, number>(),
        highlightDone: new Set<string>(),
        timelineSelectedChip: null,
      });
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
    const { file, doc, loadingFile } = get();
    // Skip mid-tab-switch: the user has clicked another tab; the active
    // file we'd parse is about to be torn down, and the parse would race
    // with loadFile's atomic swap.
    if (!file || loadingFile) return;
    const target = file;
    try {
      const fresh = await parseOrg(target);
      // The user may have switched tabs while we awaited the parse — only
      // apply the result when we're still on the same file.
      const after = get();
      if (after.file !== target || after.loadingFile) return;
      const a = JSON.stringify(fresh.nodes);
      const b = JSON.stringify(doc?.nodes ?? null);
      if (a !== b) set({ doc: reapplyGcalTags(fresh) });
    } catch {
      /* transient parse error while the buffer is mid-edit — ignore */
    }
  },

  toggleCheckbox: async (node, index) => {
    const { file, doc } = get();
    if (!file || !doc) return;
    try {
      const newDoc = await apiToggleCheckbox(file, node.begin, index);
      set({ doc: reapplyGcalTags(newDoc) });
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
  setScheduleMode: (on) =>
    // Mutually exclusive with depMode — only one "graph interaction mode"
    // can be active at a time, otherwise the cursor / draggable semantics
    // get ambiguous.
    set(
      on
        ? { scheduleMode: true, depMode: false, connectFrom: null, connectHover: null, connectValid: false, panel: null }
        : { scheduleMode: false, scheduleDragNodeId: null },
    ),
  setScheduleDragNode: (id) => set({ scheduleDragNodeId: id }),

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
      set({ doc: reapplyGcalTags(newDoc), saving: false });
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
      set({ doc: reapplyGcalTags(newDoc), saving: false });
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

  setShowTimeline: (v) => {
    saveShowTimeline(v);
    set({ showTimeline: v });
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

  moveGcalEvent: async (node, start, end, orig) => {
    const { file, doc, gcalGhosts } = get();
    if (!file || !doc) return;
    // Record the ghost BEFORE the write, and only once per event so repeated
    // nudges keep pointing at Google's TRUE original position. Events always
    // carry an :ID: (org-gcal stamps it); fall back to nothing if missing.
    if (node.orgId && node.calendarId && !gcalGhosts[node.orgId]) {
      const ghost: GcalGhost = {
        orgId: node.orgId,
        calendarId: node.calendarId,
        title: node.title ?? "(untitled)",
        startMs: orig.startMs,
        endMs: orig.endMs,
        hasStartTime: orig.hasStartTime,
        hasEndTime: orig.hasEndTime,
      };
      const next = { ...gcalGhosts, [node.orgId]: ghost };
      saveGcalGhosts(file, next);
      set({ gcalGhosts: next });
    }
    // Rewrite the event's BODY active timestamp in place (org-gcal's native
    // shape), NOT a SCHEDULED planning line — org-gcal reads the body timestamp
    // when it pushes, and a SCHEDULED line beside the untouched body timestamp
    // would show as a DUPLICATE on the timeline.
    set({ saving: true, error: null });
    try {
      const newDoc = await apiGcalMove(file, node.begin, start, end);
      set({ doc: reapplyGcalTags(newDoc), saving: false });
    } catch (e) {
      set({ error: String(e), saving: false });
    }
  },

  clearGcalGhost: (orgId) => {
    const { file, gcalGhosts } = get();
    if (!gcalGhosts[orgId]) return;
    const next = { ...gcalGhosts };
    delete next[orgId];
    saveGcalGhosts(file, next);
    set({ gcalGhosts: next });
  },

  syncGcalNow: async () => {
    const { file } = get();
    // Read the same saved config the GcalPanel uses so the timeline's Sync
    // button works without opening the panel.
    let cfg: {
      clientId?: string;
      clientSecret?: string;
      account?: string;
      selectedCalendars?: string[];
      file?: string;
      useOwnClient?: boolean;
    } = {};
    try {
      const raw = localStorage.getItem("org-gui:gcal:config");
      if (raw) cfg = JSON.parse(raw);
    } catch {
      /* ignore */
    }
    const usingBuiltIn = HAS_DEFAULT_GOOGLE_CLIENT && !cfg.useOwnClient;
    const clientId = (usingBuiltIn ? DEFAULT_GOOGLE_CLIENT_ID : cfg.clientId ?? "").trim();
    const clientSecret = (usingBuiltIn ? DEFAULT_GOOGLE_CLIENT_SECRET : cfg.clientSecret ?? "").trim();
    const account = (cfg.account ?? "").trim();
    // Push the file the ghosts actually belong to — the ACTIVE file (where the
    // moved events physically live). Using cfg.file here would, when the two
    // diverge, clear the wrong file's ghosts and yank the tab. Normally they're
    // the same file anyway.
    const syncFile = (file ?? cfg.file ?? "").trim();
    const cals = cfg.selectedCalendars?.length ? cfg.selectedCalendars : account ? [account] : [];
    if (!clientId || !clientSecret || !account || !syncFile || cals.length === 0) {
      set({
        gcalSyncError:
          "Google Calendar isn't fully set up — open the 🗓 panel and sign in / pick calendars first.",
      });
      return;
    }
    set({ gcalSyncing: true, gcalSyncError: null });
    try {
      // Force two-way so the local moves actually push to Google.
      await apiGcalSync(clientId, clientSecret, account, cals, syncFile, true);
      // Reconciled with Google → ghosts are resolved. Clear them, then reload
      // the file so the timeline reflects whatever Google returned.
      saveGcalGhosts(syncFile, {});
      set({ gcalGhosts: {}, gcalSyncing: false });
      await get().loadFile(syncFile);
    } catch (e) {
      set({ gcalSyncing: false, gcalSyncError: String(e) });
    }
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
      set({ doc: reapplyGcalTags(newDoc), saving: false });
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
      set({ doc: reapplyGcalTags(newDoc), saving: false });
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
      set({ doc: reapplyGcalTags(newDoc), saving: false });
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
      set({ doc: reapplyGcalTags(newDoc), saving: false });
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
      set({ doc: reapplyGcalTags(newDoc), saving: false });
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
      set({ doc: reapplyGcalTags(newDoc), selectedId: null, saving: false });
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
      set({ doc: reapplyGcalTags(newDoc), selectedId: newSel, saving: false });
    } catch (e) {
      set({ error: String(e), saving: false });
    }
  },

  setNodeRange: async (node, start, end) => {
    const { file, doc, selectedId: prevSel } = get();
    if (!file || !doc) return;
    const idx = doc.nodes.findIndex((n) => n.id === node.id);
    set({ saving: true, error: null });
    try {
      const newDoc = await apiSetTimestampRange(file, node.begin, start, end);
      const tracked = idx >= 0 ? (newDoc.nodes[idx]?.id ?? null) : null;
      const newSel = prevSel === node.id ? tracked : prevSel;
      set({ doc: reapplyGcalTags(newDoc), selectedId: newSel, saving: false });
    } catch (e) {
      set({ error: String(e), saving: false });
    }
  },

  setNodeSpan: async (node, start, end) => {
    const { file, doc, selectedId: prevSel } = get();
    if (!file || !doc) return;
    const idx = doc.nodes.findIndex((n) => n.id === node.id);
    set({ saving: true, error: null });
    try {
      const newDoc = await apiSetSpan(file, node.begin, start, end);
      const tracked = idx >= 0 ? (newDoc.nodes[idx]?.id ?? null) : null;
      const newSel = prevSel === node.id ? tracked : prevSel;
      set({ doc: reapplyGcalTags(newDoc), selectedId: newSel, saving: false });
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
      set({ doc: reapplyGcalTags(newDoc), saving: false });
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
      set({ doc: reapplyGcalTags(newDoc), expanded, saving: false });
    } catch (e) {
      set({ error: String(e), saving: false });
    }
  },

  createFile: async (file, title) => {
    const currentTabs = get().openTabs;
    const nextTabs = currentTabs.includes(file) ? currentTabs : [...currentTabs, file];
    if (nextTabs !== currentTabs) saveOpenTabs(nextTabs);
    set({ loading: true, error: null, file, openTabs: nextTabs });
    try {
      const doc = await apiCreateOrg(file, title);
      // Reset ALL per-file state for the new file, the same way loadFile does —
      // otherwise the previous tab's positions / milestones / tag colours /
      // ghosts bleed onto the new canvas until a reload.
      set({
        doc: reapplyGcalTags(doc),
        loading: false,
        selectedId: null,
        expanded: loadExpanded(file) ?? new Set<string>(),
        rootPositions: loadPositions(file),
        milestones: loadMilestones(file),
        timelineView: loadTimelineView(file),
        tableCollapsed: loadTableCollapsed(file),
        tagColors: applyGcalCalendarTags(doc, loadTagColors(file)),
        tagFilter: null,
        multiSelected: new Set<string>(),
        editBegin: 0,
        highlightDepth: new Map<string, number>(),
        highlightDone: new Set<string>(),
        timelineSelectedChip: null,
        gcalGhosts: pruneGcalGhosts(file, doc),
        gcalSyncError: null,
        gcalSyncing: false,
      });
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
      set({ doc: reapplyGcalTags(newDoc), selectedId: sel, expanded, saving: false });
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
      set({ doc: reapplyGcalTags(newDoc), selectedId: null, saving: false });
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
      set({ doc: reapplyGcalTags(newDoc), saving: false });
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
      set({ doc: reapplyGcalTags(newDoc), saving: false });
    } catch (e) {
      set({ error: String(e), saving: false });
    }
  },
}));
