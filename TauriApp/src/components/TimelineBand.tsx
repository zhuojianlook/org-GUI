import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useOrgStore, type ZoomLevel } from "../store/useOrgStore";
import type { OrgNode } from "../api/org";
import { parseOrgDate, startOfDay } from "../utils/time";

// A horizontal calendar band across the top of the canvas. Shows zoom-level
// controls (1W / 2W / 1M / 3M / 6M / 1Y / Fit), a month axis with adaptive day
// labels at narrow zooms, a "today" marker, task-date ticks (double-click a
// tick to focus that node in the graph), and user-placed milestone pins
// (double-click empty band to add; drag to move; double-click flag to rename;
// ✕ to remove). Drag the band itself to pan through time at any non-Fit zoom.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MILESTONE_COLOR = "#c678dd"; // violet — default when a milestone has no explicit color
const MS_DAY = 86_400_000;

// Native OS color picker via a transient hidden <input type="color">. Used by
// the milestone ⚑ click handler so users can recolor a pin without us shipping
// our own picker UI. The element is removed after a change or after 60 s.
function pickColor(initial: string, onPick: (color: string) => void) {
  const inp = document.createElement("input");
  inp.type = "color";
  inp.value = initial;
  inp.style.position = "fixed";
  inp.style.opacity = "0";
  inp.style.pointerEvents = "none";
  document.body.appendChild(inp);
  const cleanup = () => {
    inp.remove();
  };
  inp.addEventListener("change", () => {
    onPick(inp.value);
    cleanup();
  });
  setTimeout(cleanup, 60_000);
  inp.click();
}

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Minutes-since-midnight for a "HH:MM" string (0 when null/invalid). */
function minOfTime(t: string | null): number {
  if (!t) return 0;
  const [h, m] = t.split(":").map((s) => parseInt(s, 10));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

/** "HH:MM" from an absolute epoch-ms instant (local time). */
function hhmmOf(ms: number): string {
  const dt = new Date(ms);
  return `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
}

/** Format an absolute instant as an org-span endpoint string for setSpan:
 *  "YYYY-MM-DD" (date-only) or "YYYY-MM-DD HH:MM" when `withTime`. */
function fmtSpanStr(ms: number, withTime: boolean): string {
  const dt = new Date(ms);
  const date = isoOf(dt);
  return withTime ? `${date} ${hhmmOf(ms)}` : date;
}

// Doom-style neutral grey used when a chip's node has no coloured tag —
// matches `font-lock-comment-face` from doom-one so it sits naturally
// against the canvas.
const DOOM_GREY = "#5b6268";

function hexToRgba(hex: string, alpha: number): string {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`;
}

/** Background for a timeline task chip. Pure tag colour when the node
 *  carries exactly one coloured tag; an equal-stripe linear-gradient when
 *  it carries multiple; Doom grey when no tag is coloured. Always wrapped
 *  with `alpha` so the chip feels softer against the band. */
function chipBackground(
  tagsAll: string[],
  tagColors: Record<string, string>,
  alpha: number,
): string {
  const colours: string[] = [];
  for (const t of tagsAll) {
    const c = tagColors[t];
    if (c) colours.push(c);
  }
  if (colours.length === 0) return hexToRgba(DOOM_GREY, alpha);
  if (colours.length === 1) return hexToRgba(colours[0], alpha);
  const stops = colours
    .map((c, i) => {
      const start = (i / colours.length) * 100;
      const end = ((i + 1) / colours.length) * 100;
      const rgba = hexToRgba(c, alpha);
      return `${rgba} ${start}%, ${rgba} ${end}%`;
    })
    .join(", ");
  return `linear-gradient(90deg, ${stops})`;
}

/** Extract the "HH:MM" component from an ISO timestamp, or null when the
 *  value is date-only (no T separator). */
function timeOfDayFromIso(iso: string | null | undefined): string | null {
  if (!iso || !iso.includes("T")) return null;
  return iso.slice(11, 16);
}

/** True when a "HH:MM" time falls outside the working-hours window. Used by
 *  the chip renderer to dim clamped chips so a 22:00 task pinned at the
 *  bottom edge reads visibly different from a 19:30 chip in the same spot. */
function isOutsideWorkHours(timeOfDay: string | null): boolean {
  if (!timeOfDay) return false;
  const [h, m] = timeOfDay.split(":").map((s) => parseInt(s, 10));
  const min = (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  return min < WORK_START_MIN || min >= WORK_END_MIN;
}

// Vertical zone in the band where task chips live; y in this zone maps
// linearly to time of day. In 24h mode the window is 00:00→23:59; in
// working-hours mode (💼 toggle) the window narrows to WORK_START_MIN→
// WORK_END_MIN so the part of the day the user actually schedules things
// in gets more vertical space. The top padding clears the zoom toolbar;
// the bottom padding clears the month labels and milestone pins.
const TIME_TOP_PX = 56;
const TIME_BOTTOM_OFFSET = 32;
const WORK_START_MIN = 8 * 60; // 08:00
const WORK_END_MIN = 20 * 60; // 20:00 — typical "work day" envelope
// Vertical density of the time axis. The band's TIME content is this tall
// (taller than the visible band), so the band scrolls vertically and each
// event gets real room. 24h or the 12h working-hours window.
const PX_PER_HOUR = 40;
function timeContentHeight(workMode: boolean): number {
  return TIME_TOP_PX + (workMode ? 12 : 24) * PX_PER_HOUR + TIME_BOTTOM_OFFSET;
}

/** Map a "HH:MM" string to a vertical pixel position inside the band's chip
 *  zone. When `workMode` is on, the [WORK_START_MIN..WORK_END_MIN] window
 *  is stretched to fill the whole zone and out-of-hours times clamp to the
 *  top/bottom edges so a 22:00 task still appears (pinned at the bottom)
 *  but the daytime range gets all the spacing. */
function yForTimeOfDay(
  timeOfDay: string | null,
  bandHeight: number,
  workMode: boolean,
): number {
  const usable = Math.max(40, bandHeight - TIME_TOP_PX - TIME_BOTTOM_OFFSET);
  if (!timeOfDay) return TIME_TOP_PX + usable / 2; // unscheduled time → mid-band
  const [h, m] = timeOfDay.split(":").map((s) => parseInt(s, 10));
  const min = (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  if (workMode) {
    const winStart = WORK_START_MIN;
    const winEnd = WORK_END_MIN;
    const winSpan = winEnd - winStart;
    const clamped = Math.max(winStart, Math.min(winEnd, min));
    return TIME_TOP_PX + ((clamped - winStart) / winSpan) * usable;
  }
  return TIME_TOP_PX + (min / 1440) * usable;
}

/** Inverse of yForTimeOfDay — convert a clientY (relative to railRef) into a
 *  "HH:MM" string snapped to the nearest 15-minute mark. In `workMode` the
 *  inverse stays inside the working-hour window so dragging a chip can't
 *  reschedule it to e.g. 03:00 while you're zoomed to the work day. */
function timeAtRailY(
  yRel: number,
  bandHeight: number,
  workMode: boolean,
): string {
  const usable = Math.max(40, bandHeight - TIME_TOP_PX - TIME_BOTTOM_OFFSET);
  const frac = Math.max(0, Math.min(1, (yRel - TIME_TOP_PX) / usable));
  if (workMode) {
    const winStart = WORK_START_MIN;
    const winEnd = WORK_END_MIN;
    const winSpan = winEnd - winStart;
    const raw = winStart + frac * winSpan;
    const mins = Math.round(raw / 15) * 15;
    const clamped = Math.min(winEnd - 15, Math.max(winStart, mins));
    const h = Math.floor(clamped / 60);
    const m = clamped % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  const mins = Math.round((frac * 1440) / 15) * 15;
  const clamped = Math.min(1425, mins); // 23:45 cap so we don't emit 24:00
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const ZOOMS: { id: ZoomLevel; label: string; days: number | null }[] = [
  { id: "fit", label: "Fit", days: null },
  { id: "1w", label: "1W", days: 7 },
  { id: "2w", label: "2W", days: 14 },
  { id: "1m", label: "1M", days: 30 },
  { id: "3m", label: "3M", days: 90 },
  { id: "6m", label: "6M", days: 180 },
  { id: "1y", label: "1Y", days: 365 },
];

function daysForZoom(z: ZoomLevel): number | null {
  return ZOOMS.find((x) => x.id === z)?.days ?? null;
}

/** Default Fit window — wraps all relevant dates with breathing room. Padding
 *  is week-aligned (Mondays) so the day gridlines start on clean boundaries.
 *  Kept TIGHT on purpose: the old version padded a whole month before and two
 *  after (≥90 days minimum), which halved px-per-day at Fit and squeezed every
 *  entry into an unreadable smear. */
function autoFitRange(dates: number[]): [number, number] {
  const today = startOfDay(new Date()).getTime();
  const all = dates.length ? [...dates, today] : [today];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const mondayOnOrBefore = (ms: number) => {
    const d = new Date(ms);
    const dow = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
    return startOfDay(new Date(ms - dow * MS_DAY)).getTime();
  };
  const start = mondayOnOrBefore(min - 3 * MS_DAY);
  let end = mondayOnOrBefore(max + 10 * MS_DAY) + 7 * MS_DAY;
  if (end - start < 42 * MS_DAY) end = start + 42 * MS_DAY;
  return [start, end];
}

function monthStarts(startMs: number, endMs: number): Date[] {
  const out: Date[] = [];
  let d = new Date(startMs);
  d = new Date(d.getFullYear(), d.getMonth(), 1);
  while (d.getTime() <= endMs) {
    out.push(new Date(d));
    d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  }
  return out;
}

function dayStarts(startMs: number, endMs: number): Date[] {
  const out: Date[] = [];
  let d = new Date(startMs);
  d = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  while (d.getTime() <= endMs) {
    out.push(new Date(d));
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  }
  return out;
}

export default function TimelineBand() {
  const doc = useOrgStore((s) => s.doc);
  const milestones = useOrgStore((s) => s.milestones);
  const addMilestone = useOrgStore((s) => s.addMilestone);
  const updateMilestone = useOrgStore((s) => s.updateMilestone);
  const removeMilestone = useOrgStore((s) => s.removeMilestone);
  const timelineView = useOrgStore((s) => s.timelineView);
  const setTimelineView = useOrgStore((s) => s.setTimelineView);
  const scheduleNode = useOrgStore((s) => s.scheduleNode);
  const setNodeSpan = useOrgStore((s) => s.setNodeSpan);
  const moveGcalEvent = useOrgStore((s) => s.moveGcalEvent);
  const gcalGhosts = useOrgStore((s) => s.gcalGhosts);
  const gcalSyncing = useOrgStore((s) => s.gcalSyncing);
  const gcalSyncError = useOrgStore((s) => s.gcalSyncError);
  const syncGcalNow = useOrgStore((s) => s.syncGcalNow);
  const clearGcalGhost = useOrgStore((s) => s.clearGcalGhost);
  const timelineSelectedChip = useOrgStore((s) => s.timelineSelectedChip);
  const setTimelineSelectedChip = useOrgStore((s) => s.setTimelineSelectedChip);
  const tagColors = useOrgStore((s) => s.tagColors);
  const scheduleMode = useOrgStore((s) => s.scheduleMode);
  const setScheduleMode = useOrgStore((s) => s.setScheduleMode);
  const scheduleDragNodeId = useOrgStore((s) => s.scheduleDragNodeId);
  const setScheduleDragNode = useOrgStore((s) => s.setScheduleDragNode);

  const railRef = useRef<HTMLDivElement>(null);
  // Measured inner width of the scrollable rail, in state so width-dependent
  // layout (pxPerDay, chip clustering, ghost x-positions) is correct from the
  // first paint and re-flows whenever the band is resized.
  //
  // Without this, those values read `railRef.current.getBoundingClientRect()`
  // during render — but the ref is null on the very first render, so they fell
  // back to 0 / 800 and never recovered (attaching a ref doesn't re-render and
  // the memoised pxPerDay only recomputes when `span` changes). The symptom was
  // chips rendering wrong on startup until the user toggled a zoom level. A
  // ResizeObserver fixes both the first-paint case and the new resizable
  // timeline divider / window-resize cases.
  const [railWidth, setRailWidth] = useState(0);
  useLayoutEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const measure = () => setRailWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const dragId = useRef<string | null>(null);
  const panRef = useRef<{ startX: number; startCenterMs: number } | null>(null);
  // Live mirror of laneMode (declared much further down, next to pxPerDay) for
  // effect-registered handlers whose closures would otherwise go stale.
  const laneModeRef = useRef(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // User-controllable visibility of the day-cell gridlines. ON by default so
  // the timeline reads as a calendar from the very first render.
  const [showDayTicks, setShowDayTicks] = useState(true);
  // Working-hours Y-axis zoom: when true, the chip zone stretches
  // [WORK_START_MIN..WORK_END_MIN] to fill the band so the day-time range
  // gets all the vertical space. Persisted to localStorage so the preference
  // sticks across reloads of the app.
  const [workHoursMode, setWorkHoursMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem("org-gui:workHours") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("org-gui:workHours", workHoursMode ? "1" : "0");
    } catch {}
  }, [workHoursMode]);
  // (The scroll-to-working-day effect lives further down, after laneMode is
  // declared — its dependency array must not read consts before declaration.)
  // Live wall-clock tick used by the TODAY marker so the vertical line
  // advances through the day (and its label reads HH:MM:SS). One-second
  // cadence is fine — the marker only moves a fraction of a pixel per
  // second at typical zooms, but the seconds counter feels alive.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  // Which stack-chip is currently expanded (its bucket key) and where on
  // screen to anchor the popover. Null = no popover open.
  const [stackPopover, setStackPopover] = useState<
    { key: string; x: number; y: number } | null
  >(null);
  const [showLegend, setShowLegend] = useState(false);
  // Live preview of a task chip being dragged — shows a ghost at the cursor
  // with the proposed date + time so the user can see where they're aiming
  // before they release.
  const [chipGhost, setChipGhost] = useState<{
    nodeId: string;
    deadline: boolean;
    title: string;
    color: string;
    x: number;
    y: number;
    iso: string;
    time: string;
  } | null>(null);

  // A duration BAR (span) is selected by clicking it. Distinct from
  // timelineSelectedChip (which targets point chips and whose arrow-key nudge
  // rewrites SCHEDULED to a single point — that would destroy a span). Only
  // one of the two selections is ever non-null at a time.
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  // Optimistic ABSOLUTE preview for span shifts/resizes (mirrors the point
  // chip's pendingNudge): full start/end instants so the bar sits exactly
  // where the user put it across the bridge round-trip, with no oscillation.
  const [spanPreview, setSpanPreview] = useState<{
    nodeId: string;
    startMs: number; // absolute instant of the span start
    endMs: number; // absolute instant of the span end
    hasStartTime: boolean;
    hasEndTime: boolean;
  } | null>(null);
  const spanPreviewRef = useRef<typeof spanPreview>(null);
  useEffect(() => {
    spanPreviewRef.current = spanPreview;
  }, [spanPreview]);

  // Live preview while dragging the "set duration" handle off a single-time
  // point chip to turn it into a range. startMs is the chip's fixed start; endMs
  // follows the cursor.
  const [stretch, setStretch] = useState<{ nodeId: string; startMs: number; endMs: number } | null>(
    null,
  );

  // All node-date ticks (scheduled / deadline). We carry the node id so a
  // double-click on a tick can focus that node in the graph, and the
  // per-deadline color override (`:DEADLINE_COLOR:`) so the band stays in
  // visual sync with the node's badge.
  const nodeDates = useMemo(() => {
    const out: {
      ms: number;
      deadline: boolean;
      nodeId: string;
      title: string;
      color: string; // legacy fallback used by drag-ghost; chips read background via chipBackground()
      tagsAll: string[]; // for chip-background computation (tag → colour map)
      timeOfDay: string | null;
      iso: string;
      // Duration end (from an org timestamp range). msEnd is the start-of-day
      // of the end date (for multi-day spans); timeOfDayEnd is the end time
      // (for same-day time blocks). Both null when the timestamp is a single
      // point — those render as the usual chips, not bars.
      msEnd: number | null;
      timeOfDayEnd: string | null;
      // Which org field this came from — drives how a duration-bar move is
      // written back (SCHEDULED time-range vs plain timestamp range).
      kind: "scheduled" | "deadline" | "timestamp";
    }[] = [];
    for (const n of doc?.nodes ?? []) {
      if (n.done) continue;
      const tags = n.tagsAll ?? [];
      const s = parseOrgDate(n.scheduled);
      if (s) {
        const e = parseOrgDate(n.scheduledEnd);
        out.push({
          ms: startOfDay(s).getTime(),
          deadline: false,
          nodeId: n.id,
          title: n.title ?? "(untitled)",
          color: "#51afef",
          tagsAll: tags,
          timeOfDay: timeOfDayFromIso(n.scheduled),
          iso: n.scheduled ?? "",
          msEnd: e ? startOfDay(e).getTime() : null,
          timeOfDayEnd: timeOfDayFromIso(n.scheduledEnd),
          kind: "scheduled",
        });
      }
      const d = parseOrgDate(n.deadline);
      if (d) {
        const e = parseOrgDate(n.deadlineEnd);
        out.push({
          ms: startOfDay(d).getTime(),
          deadline: true,
          nodeId: n.id,
          title: n.title ?? "(untitled)",
          color: n.deadlineColor || "#ff6c6b",
          tagsAll: tags,
          timeOfDay: timeOfDayFromIso(n.deadline),
          iso: n.deadline ?? "",
          msEnd: e ? startOfDay(e).getTime() : null,
          timeOfDayEnd: timeOfDayFromIso(n.deadlineEnd),
          kind: "deadline",
        });
      }
      // Plain active TIMESTAMP, but ONLY when it carries a duration (a range).
      // Multi-day events (<a>--<b>) live here because org's SCHEDULED keeps
      // only the start of a `--` range. Plain SINGLE-point timestamps are
      // normally skipped so date-only notes don't flood the band — EXCEPT for
      // Google Calendar events, whose canonical time lives in the :org-gcal:
      // drawer as a plain timestamp (no SCHEDULED line). A task just added to
      // the calendar, or an imported all-day / single-point event, must still
      // appear; without this it would vanish from the timeline the moment it
      // was added to Google even though it exists on the calendar.
      const tsEnd = parseOrgDate(n.timestampEnd);
      const ts = parseOrgDate(n.timestamp);
      const alreadyPlotted = !!parseOrgDate(n.scheduled) || !!parseOrgDate(n.deadline);
      if (ts && (tsEnd || (n.calendarId && !alreadyPlotted))) {
        out.push({
          ms: startOfDay(ts).getTime(),
          deadline: false,
          nodeId: n.id,
          title: n.title ?? "(untitled)",
          color: "#5fb3a1",
          tagsAll: tags,
          timeOfDay: timeOfDayFromIso(n.timestamp),
          iso: n.timestamp ?? "",
          msEnd: tsEnd ? startOfDay(tsEnd).getTime() : null,
          timeOfDayEnd: timeOfDayFromIso(n.timestampEnd),
          kind: "timestamp",
        });
      }
    }
    return out;
  }, [doc]);

  // A nodeDate carries a real duration when it spans multiple days OR has an
  // end time-of-day later than its start on the same day. These render as
  // bars; everything else renders as the usual point chips.
  const hasDuration = (d: (typeof nodeDates)[number]): boolean => {
    if (d.msEnd != null && d.msEnd > d.ms) return true;
    if (d.timeOfDayEnd && d.timeOfDay && d.timeOfDayEnd > d.timeOfDay) return true;
    return false;
  };

  // The node's CURRENT body-timestamp position (start/end instants), used as
  // the "original" Google position when first moving a calendar event (the doc
  // hasn't been rewritten yet at commit time, so this is where Google has it).
  const gcalOrigOf = (
    node: OrgNode,
  ): { startMs: number; endMs: number | null; hasStartTime: boolean; hasEndTime: boolean } | null => {
    const ts = parseOrgDate(node.timestamp);
    if (!ts) return null;
    const te = parseOrgDate(node.timestampEnd);
    const sTime = timeOfDayFromIso(node.timestamp);
    const eTime = timeOfDayFromIso(node.timestampEnd);
    return {
      startMs: startOfDay(ts).getTime() + (sTime ? minOfTime(sTime) * 60000 : 0),
      endMs: te ? startOfDay(te).getTime() + (eTime ? minOfTime(eTime) * 60000 : 0) : null,
      hasStartTime: !!sTime,
      hasEndTime: !!eTime,
    };
  };

  /** Commit a span move: calendar events rewrite their body timestamp in place
   *  (no SCHEDULED, no duplicate) and drop a ghost at the original Google
   *  position; ordinary nodes use the normal span writer. */
  const commitSpanMove = (node: OrgNode, sStr: string, eStr: string): Promise<void> => {
    if (node.calendarId) {
      const orig = gcalOrigOf(node);
      if (orig) return Promise.resolve(moveGcalEvent(node, sStr, eStr, orig));
    }
    return Promise.resolve(setNodeSpan(node, sStr, eStr));
  };

  // Original position of a POINT chip (scheduled/deadline/single timestamp),
  // for the move-ghost when first shifting a calendar event shown as a chip
  // (e.g. an event added from a scheduled task keeps its time in SCHEDULED).
  const gcalOrigPoint = (
    node: OrgNode,
    isDeadline: boolean,
  ): { startMs: number; endMs: number | null; hasStartTime: boolean; hasEndTime: boolean } | null => {
    const iso = isDeadline ? node.deadline : node.scheduled ?? node.timestamp;
    const d = parseOrgDate(iso);
    if (!d) return null;
    const t = timeOfDayFromIso(iso);
    return {
      startMs: startOfDay(d).getTime() + (t ? minOfTime(t) * 60000 : 0),
      endMs: null,
      hasStartTime: !!t,
      hasEndTime: false,
    };
  };

  /** Commit a POINT-chip move (arrow nudge / drag). A calendar event rewrites
   *  its own time (SCHEDULED or :org-gcal: drawer — wherever org-gcal reads it)
   *  and drops a move-ghost, so an added calendar task behaves exactly like a
   *  fetched one. Ordinary tasks use the normal scheduler. */
  const commitPointMove = (
    node: OrgNode,
    iso: string,
    kind: "scheduled" | "deadline",
  ): Promise<void> => {
    if (node.calendarId) {
      const orig = gcalOrigPoint(node, kind === "deadline");
      if (orig) return Promise.resolve(moveGcalEvent(node, iso, "", orig));
    }
    return Promise.resolve(scheduleNode(node, iso, kind));
  };

  /** Drag the "set duration" handle below a single-time point chip downward to
   *  give the task an END time — turning it into a range/bar. Commits through
   *  commitSpanMove, so a calendar event also records a ghost + shows Sync. */
  const onPointStretch = (e: React.PointerEvent, d: (typeof nodeDates)[number]) => {
    e.stopPropagation();
    e.preventDefault();
    if (!d.timeOfDay) return; // need a start time to extend from
    setSelectedSpanId(null);
    const startMs = d.ms + minOfTime(d.timeOfDay) * 60000;
    const dayStart = startOfDay(new Date(startMs)).getTime();
    const MIN = 15 * 60000;
    let endMs = startMs + 60 * 60000; // default 1h until the cursor moves
    const move = (ev: PointerEvent) => {
      const r = railRef.current?.getBoundingClientRect();
      if (!r) return;
      const mins = minOfTime(timeAtRailY(contentY(ev.clientY), timeContentH, workHoursMode));
      endMs = Math.max(dayStart + mins * 60000, startMs + MIN);
      setStretch({ nodeId: d.nodeId, startMs, endMs });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const node = docRef.current?.nodes.find((n) => n.id === d.nodeId);
      setStretch(null);
      if (!node) return;
      void commitSpanMove(node, fmtSpanStr(startMs, true), fmtSpanStr(endMs, true));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Live mirrors so the span arrow-key effect / resize drag can read the
  // latest doc + computed spans without re-subscribing on every doc change
  // (the effect is keyed on selectedSpanId only).
  const docRef = useRef(doc);
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);
  const nodeDatesRef = useRef(nodeDates);
  useEffect(() => {
    nodeDatesRef.current = nodeDates;
  }, [nodeDates]);

  // Visible window: either "Fit" (auto-range over all dates) or a fixed-span
  // window centered on timelineView.centerMs.
  const [startMs, endMs] = useMemo(() => {
    const days = daysForZoom(timelineView.zoom);
    if (days === null) {
      const ms: number[] = [...nodeDates.map((d) => d.ms)];
      for (const m of milestones) {
        const p = parseOrgDate(m.iso);
        if (p) ms.push(startOfDay(p).getTime());
      }
      return autoFitRange(ms);
    }
    const half = (days * MS_DAY) / 2;
    return [timelineView.centerMs - half, timelineView.centerMs + half];
  }, [nodeDates, milestones, timelineView]);

  const span = Math.max(1, endMs - startMs);
  const pct = (ms: number) => ((ms - startMs) / span) * 100;
  const todayMs = startOfDay(new Date()).getTime();

  const dateAtClientX = (clientX: number): Date => {
    const r = railRef.current!.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return startOfDay(new Date(startMs + p * span));
  };

  // ── ALL-DAY STRIP ─────────────────────────────────────────────────────────
  // Date-only entries (no time-of-day — most DEADLINEs, plain scheduled dates,
  // and all-day multi-day events) have no meaningful position on the band's
  // time-of-day Y axis. They used to be dumped at an arbitrary mid-band Y —
  // which sits below the visible fold at default scroll, so they were both
  // invisible by default AND a single-pixel pile-up when scrolled to. Instead
  // they now live in a compact strip pinned to the top of the band (an overlay,
  // so it stays put while the time zone scrolls): single dates as small labelled
  // pills (overlapping pills merge into a ×N badge that opens the stack
  // popover), multi-day all-day events as thin lane-packed span bars.
  const stripLayout = useMemo(() => {
    type ND = (typeof nodeDates)[number];
    const railW = railWidth || 800;
    const xOf = (ms: number) => ((ms - startMs) / span) * railW;
    const singles: { d: ND; xPx: number; wPx: number }[] = [];
    const spans: { d: ND; xPx: number; wPx: number }[] = [];
    for (const d of nodeDates) {
      const isMultiDay = d.msEnd != null && d.msEnd > d.ms;
      if (isMultiDay) {
        // Timed multi-day events render as the staircase in the time zone.
        if (d.timeOfDay && d.timeOfDayEnd) continue;
        const x = xOf(d.ms);
        // An all-day end covers the WHOLE last day — extend one day.
        const end = xOf((d.msEnd as number) + MS_DAY);
        if (end < -40 || x > railW + 40) continue;
        spans.push({ d, xPx: x, wPx: Math.max(24, end - x) });
      } else {
        if (d.timeOfDay) continue; // timed entries belong to the time zone
        const x = xOf(d.ms);
        if (x < -40 || x > railW + 40) continue;
        const wPx = Math.max(20, Math.min(96, 26 + d.title.length * 5.5));
        singles.push({ d, xPx: x, wPx });
      }
    }
    singles.sort((a, b) => a.xPx - b.xPx);
    // 1-D clustering: pills that would overlap merge into one ×N badge, so the
    // single-date row NEVER overlaps by construction.
    const BADGE_W = 34;
    const groups: { items: { d: ND; xPx: number; wPx: number }[]; xPx: number; endPx: number }[] = [];
    for (const s of singles) {
      const g = groups[groups.length - 1];
      if (g && s.xPx <= g.endPx + 4) {
        g.items.push(s);
        g.endPx = Math.max(g.endPx, g.xPx + BADGE_W);
      } else {
        groups.push({ items: [s], xPx: s.xPx, endPx: s.xPx + s.wPx });
      }
    }
    // Span bars: greedy 2-lane packing; deeper overlap clamps into the last
    // lane (rare — and the bars are translucent, so a clamp stays readable).
    spans.sort((a, b) => a.xPx - b.xPx);
    const laneEnds: number[] = [];
    const placedSpans = spans.map((sp) => {
      let lane = 0;
      while (lane < laneEnds.length && sp.xPx < laneEnds[lane] + 4) lane++;
      if (lane > 1) lane = 1;
      laneEnds[lane] = Math.max(laneEnds[lane] ?? 0, sp.xPx + sp.wPx);
      return { ...sp, lane };
    });
    const spanLanes = placedSpans.length ? Math.max(...placedSpans.map((s) => s.lane)) + 1 : 0;
    const stripH =
      groups.length || spanLanes
        ? 6 + (groups.length ? 20 : 0) + spanLanes * 16 + 2
        : 0;
    return { groups, spans: placedSpans, stripH, hasSingles: groups.length > 0 };
  }, [nodeDates, startMs, span, railWidth]);

  const beginEdit = (id: string, label: string) => {
    setEditing(id);
    setDraft(label);
  };
  const commitEdit = (id: string) => {
    const label = draft.trim();
    if (label) updateMilestone(id, { label });
    else removeMilestone(id);
    setEditing(null);
  };

  const onBandDoubleClick = (e: React.MouseEvent) => {
    // Empty-band double-click → add a milestone on the clicked date.
    const id = addMilestone(isoOf(dateAtClientX(e.clientX)), "");
    beginEdit(id, "");
  };

  // Drag the band to pan through time (no-op at Fit zoom — range is auto).
  // Also clears any active timeline-chip selection so the arrow-key nudge
  // stops watching once the user clicks anywhere off a chip.
  const onPanStart = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button,input,[data-pin]")) return;
    if (timelineSelectedChip) setTimelineSelectedChip(null);
    if (selectedSpanId) setSelectedSpanId(null);
    if (timelineView.zoom === "fit") return;
    panRef.current = { startX: e.clientX, startCenterMs: timelineView.centerMs };
    const onMove = (ev: PointerEvent) => {
      const r = railRef.current?.getBoundingClientRect();
      const p = panRef.current;
      if (!r || !p) return;
      const dx = ev.clientX - p.startX;
      const msPerPx = span / r.width;
      setTimelineView({ centerMs: p.startCenterMs - dx * msPerPx });
    };
    const onUp = () => {
      panRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Schedule mode: the graph (TimelineGraph) drives a pointer-based drag of a
  // node and dispatches these events with the cursor position. We render a
  // live ghost while the cursor is over the rail, and on drop convert
  // X→date / Y→time and commit the SCHEDULED date through scheduleNode.
  useEffect(() => {
    const overRail = (x: number, y: number): DOMRect | null => {
      const r = railRef.current?.getBoundingClientRect();
      if (!r || x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
      return r;
    };
    const onMove = (e: Event) => {
      const { nodeId, x, y } = (e as CustomEvent<{ nodeId: string; x: number; y: number }>).detail;
      const r = overRail(x, y);
      if (!r) {
        setChipGhost(null);
        return;
      }
      const node = doc?.nodes.find((n) => n.id === nodeId);
      const dt = dateAtClientX(x);
      // Lane mode's y-axis is a packing artifact, not a time — schedule
      // date-only there (refine the time at 1W/2W or in the Calendar view).
      const time = laneModeRef.current ? "" : timeAtRailY(contentY(y), timeContentH, workHoursMode);
      setChipGhost({
        nodeId,
        deadline: false,
        title: node?.title ?? "(untitled)",
        color: "#a3be8c",
        x,
        y,
        iso: time ? `${isoOf(dt)} ${time}` : isoOf(dt),
        time,
      });
    };
    const onDrop = (e: Event) => {
      setChipGhost(null);
      const { nodeId, x, y } = (e as CustomEvent<{ nodeId: string; x: number; y: number }>).detail;
      const r = overRail(x, y);
      if (!r) return; // dropped off the timeline — no-op
      const node = doc?.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const dt = dateAtClientX(x);
      const time = laneModeRef.current ? "" : timeAtRailY(contentY(y), timeContentH, workHoursMode);
      const dateStr = time ? `${isoOf(dt)} ${time}` : isoOf(dt);
      // Calendar events pass their pre-move position so the event is MOVED on
      // Google (the old code called scheduleNode, which never reached Google);
      // unlinked tasks pass null and get the timeline-vs-calendar prompt.
      const orig = node.calendarId ? gcalOrigPoint(node, false) : null;
      void useOrgStore.getState().scheduleViaDrop(node, dateStr, "scheduled", orig).catch(() => {});
      setScheduleMode(false);
    };
    window.addEventListener("orggui:scheduleDragMove", onMove);
    window.addEventListener("orggui:scheduleDrop", onDrop);
    return () => {
      window.removeEventListener("orggui:scheduleDragMove", onMove);
      window.removeEventListener("orggui:scheduleDrop", onDrop);
    };
  }, [doc, workHoursMode, scheduleNode, setScheduleMode]);

  // Outside-click + Esc closes the stack popover. Capture-phase pointerdown
  // so React Flow / other capture handlers can't swallow the dismiss.
  useEffect(() => {
    if (!stackPopover) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      const pop = document.getElementById("org-stack-popover");
      if (pop && pop.contains(t)) return;
      // Click on a stack chip itself toggles via the chip's onClick, so
      // skip closing here when the target is one.
      if ((e.target as HTMLElement).closest("[data-stack-chip]")) return;
      setStackPopover(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setStackPopover(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [stackPopover]);

  /**
   * Arrow-key nudge when a timeline chip is selected:
   *   ← / →  shift the date by ±1 day
   *   ↑ / ↓  shift the time of day by ∓15 min  (↑ = earlier, ↓ = later)
   *   Esc    deselect
   *
   * The previous "coalesce while held" approach still spawned several
   * emacsclient processes per second of holding a key, which was enough
   * to overload the daemon for some users. The bridge call is now
   * deferred entirely until the key is RELEASED:
   *  - keydown only accumulates (ddate, dminutes) into pendingNudge state
   *  - the selected chip renders at the optimistic preview position
   *  - keyup of the last held arrow flushes one combined call
   *  - failsafe: if no keyup arrives within 800 ms (e.g. user alt-tabbed
   *    while a key was down) the pending delta commits anyway, so the
   *    edit doesn't sit forever uncommitted
   * One bridge call per gesture, no matter how long you hold the key.
   */
  // The optimistic preview is stored as an ABSOLUTE position (ms + time +
  // commit-ready iso), NOT a relative offset. This is what kills the
  // oscillation: a relative offset has to be re-applied to the doc's base,
  // and at the instant the commit lands the base jumps to the new value
  // while the offset is briefly still applied (or cleared too early),
  // bouncing the chip. With an absolute preview the chip sits at exactly the
  // same place before AND after the doc updates, so clearing the preview
  // once the commit lands is visually seamless.
  const [pendingNudge, setPendingNudge] = useState<{
    nodeId: string;
    isDeadline: boolean;
    ms: number; // start-of-day of the preview date
    timeOfDay: string | null; // "HH:MM", or null for an all-day (date-only) entry
    iso: string; // "YYYY-MM-DD HH:MM" — or bare "YYYY-MM-DD" when all-day
  } | null>(null);
  // Mirror of pendingNudge so commit() (fired from keyup/blur/idle) can read
  // the latest value synchronously without going through a state updater.
  const pendingNudgeRef = useRef<typeof pendingNudge>(null);
  useEffect(() => {
    pendingNudgeRef.current = pendingNudge;
  }, [pendingNudge]);
  const heldArrowKeys = useRef(new Set<string>());
  const idleCommitTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!timelineSelectedChip) {
      // Clear any pending nudge when selection drops; nothing to commit
      // against.
      setPendingNudge(null);
      heldArrowKeys.current.clear();
      if (idleCommitTimer.current) {
        window.clearTimeout(idleCommitTimer.current);
        idleCommitTimer.current = null;
      }
      return;
    }

    const commit = () => {
      if (idleCommitTimer.current) {
        window.clearTimeout(idleCommitTimer.current);
        idleCommitTimer.current = null;
      }
      const cur = pendingNudgeRef.current;
      if (!cur) return;
      const node = doc?.nodes.find((n) => n.id === cur.nodeId);
      if (!node) {
        setPendingNudge(null);
        return;
      }
      const committedIso = cur.iso;
      // Keep the preview applied across the bridge round-trip. Because the
      // preview is absolute, the chip stays exactly where the user put it
      // while scheduleNode runs. We clear it only AFTER the call settles —
      // by then `doc` already reflects the committed value (or, on a
      // validation rejection, is unchanged and the chip correctly snaps
      // back). Either way, no oscillation.
      Promise.resolve(
        commitPointMove(node, committedIso, cur.isDeadline ? "deadline" : "scheduled"),
      )
        .catch(() => {})
        .finally(() => {
          setPendingNudge((p) =>
            p && p.nodeId === cur.nodeId && p.isDeadline === cur.isDeadline && p.iso === committedIso
              ? null
              : p,
          );
        });
    };

    const armIdleCommit = () => {
      if (idleCommitTimer.current) window.clearTimeout(idleCommitTimer.current);
      idleCommitTimer.current = window.setTimeout(commit, 800);
    };

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      if (e.key === "Escape") {
        // Esc abandons the pending preview AND deselects — feels more
        // useful than committing on escape.
        setPendingNudge(null);
        heldArrowKeys.current.clear();
        if (idleCommitTimer.current) {
          window.clearTimeout(idleCommitTimer.current);
          idleCommitTimer.current = null;
        }
        setTimelineSelectedChip(null);
        return;
      }
      let ddate = 0;
      let dminutes = 0;
      if (e.key === "ArrowLeft") ddate = -1;
      else if (e.key === "ArrowRight") ddate = 1;
      else if (e.key === "ArrowUp") dminutes = -15;
      else if (e.key === "ArrowDown") dminutes = 15;
      else return;
      e.preventDefault();
      heldArrowKeys.current.add(e.key);
      const sel = timelineSelectedChip;
      setPendingNudge((cur) => {
        // Base to shift FROM: the current preview if we already have one for
        // this chip, else the chip's committed value in the doc. allDay
        // (date-only) entries carry timeOfDay === null through the preview so
        // an arrow-nudge never silently stamps a time onto them.
        let baseMs: number;
        let baseTime: string | null;
        if (cur && cur.nodeId === sel.nodeId && cur.isDeadline === sel.isDeadline) {
          baseMs = cur.ms;
          baseTime = cur.timeOfDay;
        } else {
          const node = doc?.nodes.find((n) => n.id === sel.nodeId);
          // A Google-Calendar event keeps its time in the :org-gcal: drawer
          // (node.timestamp), not SCHEDULED — so fall back to it, else the
          // arrow keys have no base to nudge from and do nothing.
          const isoNow = node
            ? sel.isDeadline
              ? node.deadline
              : node.scheduled ?? node.timestamp
            : null;
          const parsed = parseOrgDate(isoNow);
          if (!parsed) return cur; // nothing to nudge from
          baseMs = startOfDay(parsed).getTime();
          baseTime = timeOfDayFromIso(isoNow);
        }
        const allDay = baseTime === null;
        // ArrowUp/Down changes the TIME — meaningless for an all-day entry,
        // and invisible (silently committed!) in lane mode where y doesn't
        // encode time. Ignore it in both cases.
        if ((allDay || laneModeRef.current) && dminutes !== 0) return cur;
        const nd = new Date(baseMs);
        nd.setHours(0, 0, 0, 0);
        nd.setDate(nd.getDate() + ddate);
        if (allDay) {
          return {
            nodeId: sel.nodeId,
            isDeadline: sel.isDeadline,
            ms: startOfDay(nd).getTime(),
            timeOfDay: null,
            iso: isoOf(nd),
          };
        }
        const [hh, mm] = (baseTime as string).split(":").map((s) => parseInt(s, 10));
        const baseMin = (Number.isFinite(hh) ? hh : 12) * 60 + (Number.isFinite(mm) ? mm : 0);
        const wrapped = ((baseMin + dminutes) % 1440 + 1440) % 1440;
        const nh = Math.floor(wrapped / 60);
        const nm = wrapped % 60;
        const timeOfDay = `${String(nh).padStart(2, "0")}:${String(nm).padStart(2, "0")}`;
        return {
          nodeId: sel.nodeId,
          isDeadline: sel.isDeadline,
          ms: startOfDay(nd).getTime(),
          timeOfDay,
          iso: `${isoOf(nd)} ${timeOfDay}`,
        };
      });
      armIdleCommit();
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (
        e.key !== "ArrowLeft" &&
        e.key !== "ArrowRight" &&
        e.key !== "ArrowUp" &&
        e.key !== "ArrowDown"
      )
        return;
      heldArrowKeys.current.delete(e.key);
      if (heldArrowKeys.current.size === 0) {
        commit();
      }
    };

    // Window blur is the most reliable way to catch "user switched to
    // another app while holding a key" — keyup may never fire for that
    // key. Commit whatever's pending so the edit doesn't get stranded.
    const onBlur = () => {
      heldArrowKeys.current.clear();
      commit();
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      // Effect re-runs when timelineSelectedChip changes — commit anything
      // pending against the OLD selection before the new effect arms.
      commit();
    };
  }, [timelineSelectedChip, doc, scheduleNode, setTimelineSelectedChip]);

  // ── Arrow-key SHIFT for a selected span bar ───────────────────────────────
  // When a duration bar is selected (selectedSpanId), the arrows move the
  // WHOLE span — both endpoints by the same calendar delta, so the span keeps
  // its length: ←/→ ±1 day, ↑/↓ ±15 min. Same absolute-preview-on-keyup
  // pattern as the point-chip nudge: one bridge call per gesture, no bounce.
  const heldSpanKeys = useRef(new Set<string>());
  const spanIdleTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!selectedSpanId) {
      heldSpanKeys.current.clear();
      if (spanIdleTimer.current) {
        window.clearTimeout(spanIdleTimer.current);
        spanIdleTimer.current = null;
      }
      return;
    }

    // Resolve the live base span (start/end instants + which endpoints carry a
    // time) from the latest computed nodeDates.
    const baseSpan = () => {
      const d = nodeDatesRef.current.find(
        (x) => x.nodeId === selectedSpanId && hasDuration(x),
      );
      if (!d) return null;
      return {
        startMs: d.ms + minOfTime(d.timeOfDay) * 60000,
        endMs: (d.msEnd ?? d.ms) + minOfTime(d.timeOfDayEnd ?? d.timeOfDay) * 60000,
        hasStartTime: !!d.timeOfDay,
        hasEndTime: !!d.timeOfDayEnd,
      };
    };

    const commit = () => {
      if (spanIdleTimer.current) {
        window.clearTimeout(spanIdleTimer.current);
        spanIdleTimer.current = null;
      }
      const cur = spanPreviewRef.current;
      if (!cur || cur.nodeId !== selectedSpanId) return;
      const node = docRef.current?.nodes.find((n) => n.id === cur.nodeId);
      if (!node) {
        setSpanPreview(null);
        return;
      }
      const sStr = fmtSpanStr(cur.startMs, cur.hasStartTime);
      const eStr = fmtSpanStr(cur.endMs, cur.hasEndTime || cur.hasStartTime);
      const committedStart = cur.startMs;
      Promise.resolve(commitSpanMove(node, sStr, eStr))
        .catch(() => {})
        .finally(() => {
          setSpanPreview((p) =>
            p && p.nodeId === cur.nodeId && p.startMs === committedStart ? null : p,
          );
        });
    };

    const armIdleCommit = () => {
      if (spanIdleTimer.current) window.clearTimeout(spanIdleTimer.current);
      spanIdleTimer.current = window.setTimeout(commit, 800);
    };

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      if (e.key === "Escape") {
        setSpanPreview(null);
        heldSpanKeys.current.clear();
        if (spanIdleTimer.current) {
          window.clearTimeout(spanIdleTimer.current);
          spanIdleTimer.current = null;
        }
        setSelectedSpanId(null);
        return;
      }
      let ddate = 0;
      let dminutes = 0;
      if (e.key === "ArrowLeft") ddate = -1;
      else if (e.key === "ArrowRight") ddate = 1;
      else if (e.key === "ArrowUp") dminutes = -15;
      else if (e.key === "ArrowDown") dminutes = 15;
      else return;
      e.preventDefault();
      heldSpanKeys.current.add(e.key);
      // Lane mode has no time axis — a ±15 min shift would render NO visible
      // preview (lane chips don't consume spanPreview) and then silently
      // commit an org rewrite / Google Calendar move 800 ms later. Same guard
      // as the point-chip nudge; ← → date shifts stay (the chip visibly moves).
      if (laneModeRef.current && dminutes !== 0) return;
      // Shift BOTH endpoints by the same calendar delta (date math handles DST
      // cleanly vs raw ms). Base from the live preview if present, else the
      // committed span.
      const cur = spanPreviewRef.current;
      const from =
        cur && cur.nodeId === selectedSpanId
          ? { startMs: cur.startMs, endMs: cur.endMs, hasStartTime: cur.hasStartTime, hasEndTime: cur.hasEndTime }
          : baseSpan();
      if (!from) return;
      const shift = (ms: number) => {
        const dt = new Date(ms);
        if (ddate) dt.setDate(dt.getDate() + ddate);
        if (dminutes) dt.setMinutes(dt.getMinutes() + dminutes);
        return dt.getTime();
      };
      setSpanPreview({
        nodeId: selectedSpanId,
        startMs: shift(from.startMs),
        endMs: shift(from.endMs),
        hasStartTime: from.hasStartTime,
        hasEndTime: from.hasEndTime,
      });
      armIdleCommit();
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (
        e.key !== "ArrowLeft" &&
        e.key !== "ArrowRight" &&
        e.key !== "ArrowUp" &&
        e.key !== "ArrowDown"
      )
        return;
      heldSpanKeys.current.delete(e.key);
      if (heldSpanKeys.current.size === 0) commit();
    };

    const onBlur = () => {
      heldSpanKeys.current.clear();
      commit();
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      commit();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSpanId, setNodeSpan]);

  /** Drag a task chip on the timeline to reschedule it. X → date,
   *  Y → time of day. Sub-threshold gestures become a click that focuses
   *  the node in the graph; past-threshold gestures commit a new
   *  scheduled/deadline date via the bridge. */
  const onChipDown = (
    e: React.PointerEvent,
    // allDay: the chip has no time-of-day (it lives in the all-day strip) —
    // dragging it moves the DATE only, without stamping a time onto it.
    // fixedTime: the chip HAS a time but the current layout's y-axis doesn't
    // encode time (lane mode) — dragging moves the DATE and keeps this time.
    info: {
      nodeId: string;
      deadline: boolean;
      title: string;
      color: string;
      allDay?: boolean;
      fixedTime?: string;
    },
  ) => {
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < 4 && Math.abs(ev.clientY - startY) < 4) return;
        dragging = true;
      }
      const r = railRef.current?.getBoundingClientRect();
      if (!r) return;
      const dt = dateAtClientX(ev.clientX);
      const time = info.allDay
        ? ""
        : (info.fixedTime ?? timeAtRailY(contentY(ev.clientY), timeContentH, workHoursMode));
      setChipGhost({
        ...info,
        x: ev.clientX,
        y: ev.clientY,
        iso: info.allDay ? isoOf(dt) : `${isoOf(dt)} ${time}`,
        time,
      });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setChipGhost(null);
      if (!dragging) {
        // Sub-threshold gesture = click → select this chip (so the arrow-key
        // nudge handler kicks in) AND focus the node in the graph.
        setTimelineSelectedChip({ nodeId: info.nodeId, isDeadline: info.deadline });
        if (selectedSpanId) setSelectedSpanId(null);
        window.dispatchEvent(new CustomEvent("orggui:focusNode", { detail: { id: info.nodeId } }));
        return;
      }
      // Drag committed — push the new date+time through scheduleNode so the
      // dependency-ordering validator catches violations.
      const node = doc?.nodes.find((n) => n.id === info.nodeId);
      if (!node) return;
      const r = railRef.current?.getBoundingClientRect();
      if (!r) return;
      const dt = dateAtClientX(ev.clientX);
      const dateStr = info.allDay
        ? isoOf(dt)
        : `${isoOf(dt)} ${info.fixedTime ?? timeAtRailY(contentY(ev.clientY), timeContentH, workHoursMode)}`;
      void commitPointMove(node, dateStr, info.deadline ? "deadline" : "scheduled");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Drag a DURATION BAR to move the WHOLE span. The cursor's date+time
   *  becomes the new START; the END shifts by the same delta so the span
   *  keeps its length. Sub-threshold = a click that SELECTS the bar (gold
   *  ring) so the arrow-key shift handler takes over, and focuses the node.
   *  Both kinds commit through the unified setNodeSpan, which routes
   *  same-day → SCHEDULED time-range and multi-day → plain timestamp range. */
  const onBarDown = (
    e: React.PointerEvent,
    d: (typeof nodeDates)[number],
  ) => {
    e.stopPropagation();
    // Deadlines with ranges are rare and have no clean range-write path —
    // leave those bars click-only.
    if (d.kind === "deadline") return;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    const hasStartTime = !!d.timeOfDay;
    const hasEndTime = !!d.timeOfDayEnd;
    const oldStart = d.ms + minOfTime(d.timeOfDay) * 60000;
    const oldEnd = (d.msEnd ?? d.ms) + minOfTime(d.timeOfDayEnd ?? d.timeOfDay) * 60000;
    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < 4 && Math.abs(ev.clientY - startY) < 4) return;
        dragging = true;
      }
      const r = railRef.current?.getBoundingClientRect();
      if (!r) return;
      // New start from the cursor; the span shifts rigidly so we also preview
      // the end. The bar follows under the cursor via spanPreview.
      const ndate = dateAtClientX(ev.clientX);
      const ntimeStr = timeAtRailY(contentY(ev.clientY), timeContentH, workHoursMode);
      const newStartMs = startOfDay(ndate).getTime() + minOfTime(ntimeStr) * 60000;
      const delta = newStartMs - oldStart;
      setSpanPreview({
        nodeId: d.nodeId,
        startMs: newStartMs,
        endMs: oldEnd + delta,
        hasStartTime,
        hasEndTime,
      });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const node = docRef.current?.nodes.find((n) => n.id === d.nodeId);
      if (!dragging) {
        // Click → select this bar (enables arrow-key shift) + focus the node.
        setSpanPreview(null);
        setSelectedSpanId(d.nodeId);
        if (timelineSelectedChip) setTimelineSelectedChip(null);
        window.dispatchEvent(new CustomEvent("orggui:focusNode", { detail: { id: d.nodeId } }));
        return;
      }
      if (!node) {
        setSpanPreview(null);
        return;
      }
      const r = railRef.current?.getBoundingClientRect();
      if (!r) {
        setSpanPreview(null);
        return;
      }
      const ndate = dateAtClientX(ev.clientX);
      const ntimeStr = timeAtRailY(contentY(ev.clientY), timeContentH, workHoursMode);
      const newStartMs = startOfDay(ndate).getTime() + minOfTime(ntimeStr) * 60000;
      const delta = newStartMs - oldStart;
      const newEndMs = oldEnd + delta;
      const sStr = fmtSpanStr(newStartMs, hasStartTime);
      const eStr = fmtSpanStr(newEndMs, hasEndTime || hasStartTime);
      setSelectedSpanId(d.nodeId);
      if (timelineSelectedChip) setTimelineSelectedChip(null);
      // Keep the absolute preview applied across the bridge round-trip so the
      // bar doesn't bounce, then clear once the commit settles.
      Promise.resolve(commitSpanMove(node, sStr, eStr))
        .catch(() => {})
        .finally(() => setSpanPreview((p) => (p && p.nodeId === d.nodeId ? null : p)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Drag a RESIZE GRIP on a span bar to change ONE edge, keeping the rest
   *  fixed. Four independent edges so multi-day TIMED events (staircase) can
   *  adjust the start time (top of day-1 column), start date (left of it),
   *  end time (bottom of the last column) and end date (right of it). Same-day
   *  bars use just startTime/endTime; all-day multi-day bars use
   *  startDate/endDate. Commits through setNodeSpan. */
  const onBarResize = (
    e: React.PointerEvent,
    d: (typeof nodeDates)[number],
    edge: "startTime" | "endTime" | "startDate" | "endDate",
  ) => {
    e.stopPropagation();
    e.preventDefault();
    if (d.kind === "deadline") return;
    setSelectedSpanId(d.nodeId);
    if (timelineSelectedChip) setTimelineSelectedChip(null);
    const hasStartTime = !!d.timeOfDay;
    const hasEndTime = !!d.timeOfDayEnd;
    const MIN_GAP = 15 * 60000; // keep a same-day block at least 15 min long
    let curStart = d.ms + minOfTime(d.timeOfDay) * 60000;
    let curEnd = (d.msEnd ?? d.ms) + minOfTime(d.timeOfDayEnd ?? d.timeOfDay) * 60000;
    const dayOf = (ms: number) => startOfDay(new Date(ms)).getTime();
    const move = (ev: PointerEvent) => {
      const r = railRef.current?.getBoundingClientRect();
      if (!r) return;
      switch (edge) {
        case "startTime": {
          // Change the time-of-day of the start, keep its date.
          const mins = minOfTime(timeAtRailY(contentY(ev.clientY), timeContentH, workHoursMode));
          curStart = Math.min(dayOf(curStart) + mins * 60000, curEnd - MIN_GAP);
          break;
        }
        case "endTime": {
          const mins = minOfTime(timeAtRailY(contentY(ev.clientY), timeContentH, workHoursMode));
          curEnd = Math.max(dayOf(curEnd) + mins * 60000, curStart + MIN_GAP);
          break;
        }
        case "startDate": {
          // Change the start date, keep its time-of-day offset.
          const offset = curStart - dayOf(curStart);
          curStart = Math.min(dateAtClientX(ev.clientX).getTime() + offset, curEnd);
          break;
        }
        case "endDate": {
          const offset = curEnd - dayOf(curEnd);
          curEnd = Math.max(dateAtClientX(ev.clientX).getTime() + offset, curStart);
          break;
        }
      }
      setSpanPreview({
        nodeId: d.nodeId,
        startMs: curStart,
        endMs: curEnd,
        hasStartTime,
        hasEndTime,
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const node = docRef.current?.nodes.find((n) => n.id === d.nodeId);
      if (!node) {
        setSpanPreview(null);
        return;
      }
      const sStr = fmtSpanStr(curStart, hasStartTime);
      const eStr = fmtSpanStr(curEnd, hasEndTime || hasStartTime);
      Promise.resolve(commitSpanMove(node, sStr, eStr))
        .catch(() => {})
        .finally(() => setSpanPreview((p) => (p && p.nodeId === d.nodeId ? null : p)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onPinDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    if (editing) return;
    // Movement threshold — without it, micro-jitter between the two clicks of a
    // double-click was rewriting the milestone's iso on every pointermove, which
    // (a) made the milestone drift visibly per click and (b) sometimes prevented
    // the dblclick event from firing for rename. Drag only kicks in past 3 px.
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < 3 && Math.abs(ev.clientY - startY) < 3) return;
        dragging = true;
        dragId.current = id;
      }
      updateMilestone(id, { iso: isoOf(dateAtClientX(ev.clientX)) });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      dragId.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Centre the view on TODAY when switching to a fixed-span zoom from Fit.
  const onZoomClick = (z: ZoomLevel) => {
    if (z === timelineView.zoom) return;
    if (z === "fit") {
      setTimelineView({ zoom: z });
    } else {
      const switchingFromFit = timelineView.zoom === "fit";
      setTimelineView({
        zoom: z,
        centerMs: switchingFromFit ? todayMs : timelineView.centerMs,
      });
    }
  };

  const pxPerDay = useMemo(() => {
    if (!railWidth || !span) return 0;
    return (railWidth / span) * MS_DAY;
  }, [span, railWidth]);

  // ── LANE MODE (zoomed out) ─────────────────────────────────────────────
  // Below ~46px/day a day column is narrower than any readable word, so NO
  // labelling scheme can work inside time-of-day geometry — the industry
  // answer (Google/Outlook month views, vis-timeline) is to stop drawing
  // time-proportional blocks and switch to TEXT-FIRST chips whose rectangle
  // includes the label, stacked into non-overlapping lanes (y becomes a
  // packing artifact, x stays the date). Every event is identifiable at
  // every zoom, by construction. 1W/2W (>=46px/day) keep the classic
  // y = time-of-day layout, where text fits the geometry.
  const laneMode = pxPerDay > 0 && pxPerDay < 46;
  // Handlers registered inside effects (graph-node drop, arrow-key nudge)
  // outlive the render that created them — they read the CURRENT mode
  // through this ref instead of a possibly-stale closure value.
  laneModeRef.current = laneMode;
  const LANE_CHIP_H = 17;
  const LANE_GAP = 3;
  const laneLayout = useMemo(() => {
    type ND = (typeof nodeDates)[number];
    const out: {
      d: ND;
      idx: number;
      xPx: number;
      chipW: number;
      lane: number;
      text: string;
      spanDays: number;
      // ANY duration — a same-day 10:00–11:30 range OR a multi-day span. Such
      // items must never drag through commitPointMove: it rewrites the range
      // to a single point and silently destroys the end time.
      isSpan: boolean;
    }[] = [];
    if (!laneMode || !railWidth) return { items: out, laneCount: 0 };
    const xOf = (ms: number) => ((ms - startMs) / span) * railWidth;
    for (let i = 0; i < nodeDates.length; i++) {
      const d = nodeDates[i];
      const isMultiDay = d.msEnd != null && d.msEnd > d.ms;
      // All-day items (single dates, date-only deadlines, all-day spans) stay
      // in the pinned strip; the lanes carry everything TIMED.
      if (!d.timeOfDay) continue;
      const xPx = xOf(d.ms);
      const spanDays = isMultiDay ? Math.round(((d.msEnd as number) - d.ms) / MS_DAY) + 1 : 1;
      const geomW = spanDays * pxPerDay;
      const text = `${d.timeOfDay} ${d.title}`;
      const chipW = Math.max(geomW, Math.min(160, 22 + text.length * 5.8));
      // NO viewport cull here: the packing input must be the FULL timed set,
      // or panning (which slides chips through the cull edges) reshuffles the
      // greedy lane assignment every frame and rows visibly hop. The full-set
      // assignment is pan-invariant; off-screen chips are culled at render.
      const isSpan =
        isMultiDay || !!(d.timeOfDay && d.timeOfDayEnd && d.timeOfDayEnd > d.timeOfDay);
      out.push({ d, idx: i, xPx, chipW, lane: 0, text, spanDays, isSpan });
    }
    // Greedy first-fit lane packing on the full chip rectangle (label
    // included) — the vis-timeline guarantee: no chip ever overlaps another.
    out.sort((a, b) => a.xPx - b.xPx || a.d.ms - b.d.ms);
    const laneEnds: number[] = [];
    for (const it of out) {
      let lane = 0;
      while (lane < laneEnds.length && it.xPx < laneEnds[lane] + 4) lane++;
      it.lane = lane;
      laneEnds[lane] = Math.max(laneEnds[lane] ?? -Infinity, it.xPx + it.chipW);
    }
    return { items: out, laneCount: laneEnds.length };
  }, [laneMode, nodeDates, startMs, span, railWidth, pxPerDay]);

  // Lane origin: clear the pinned ALL-DAY strip overlay (root y 26..26+stripH)
  // so the first lanes aren't hidden underneath it at the default scroll.
  const laneTop = Math.max(TIME_TOP_PX, 32 + stripLayout.stripH);
  // Height of the (vertically-scrollable) content. In time mode it's the tall
  // time-of-day canvas; in lane mode it grows with the lane count (the rail
  // scrolls when lanes exceed the visible band).
  const timeContentH = laneMode
    ? Math.max(220, laneTop + laneLayout.laneCount * (LANE_CHIP_H + LANE_GAP) + TIME_BOTTOM_OFFSET)
    : timeContentHeight(workHoursMode);

  // Start the vertical scroll at the working day (~08:00) in TIME mode — with
  // scrollTop left at 0 the default view showed the 00:00–06:00 dead zone. In
  // lane mode the lanes start at the top, so scroll home instead.
  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    if (laneMode) {
      el.scrollTop = 0;
      return;
    }
    const h = timeContentHeight(workHoursMode);
    const y = yForTimeOfDay("08:00", h, workHoursMode);
    el.scrollTop = Math.max(0, y - 96);
  }, [workHoursMode, laneMode]);
  // Convert a viewport clientY into a Y inside the scrollable time content
  // (accounts for the current vertical scroll offset).
  const contentY = (clientY: number): number =>
    clientY -
    (railRef.current?.getBoundingClientRect().top ?? 0) +
    (railRef.current?.scrollTop ?? 0);

  // ⊙ Today: recentre a fixed-span window on today (Fit already shows the
  // whole range) and reset the vertical scroll to the working day — one
  // click back to "now" from wherever the user has panned/scrolled.
  const goToToday = () => {
    if (timelineView.zoom !== "fit") {
      setTimelineView({ zoom: timelineView.zoom, centerMs: todayMs });
    }
    const el = railRef.current;
    if (el) {
      const y = yForTimeOfDay("08:00", timeContentH, workHoursMode);
      el.scrollTop = Math.max(0, y - 96);
    }
  };

  // Adaptive day-tick density: only draw day labels when there's room.
  // Day gridlines visibility — driven by the 📆 toggle in the header, not
  // by zoom-level heuristics. Labels still gate on having enough width to
  // avoid overlapping each other.
  const showDayLabels = showDayTicks && pxPerDay >= 26;
  // Narrow-band header: drop button text down to icons (tooltips keep the
  // words) so the control row never overflows off the right edge.
  const compactHeader = railWidth > 0 && railWidth < 660;
  const months = monthStarts(startMs, endMs);
  const days = showDayTicks ? dayStarts(startMs, endMs) : [];

  return (
    <div
      style={{
        position: "relative",
        height: "100%",
        background: "var(--c-surface)",
        borderBottom: "1px solid var(--c-border)",
        overflow: "hidden",
        userSelect: "none",
        // Visual hint that the rail is an active drop target.
        boxShadow: scheduleMode ? "inset 0 0 0 2px #a3be8c" : undefined,
      }}
    >
      {/* Top row: title + zoom selector. Fixed height so the band stays compact. */}
      <div
        style={{
          position: "absolute",
          top: 4,
          left: 0,
          right: 0,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 10px",
          pointerEvents: "none",
          zIndex: 5,
        }}
      >
        {!compactHeader && (
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: "var(--c-text-dim)", whiteSpace: "nowrap" }}>
            Deadlines &amp; Milestones
          </span>
        )}
        {/* Pending Google-calendar moves → one-click push. Appears only while
            there are unsynced local moves (ghosts on the band). */}
        {Object.keys(gcalGhosts).length > 0 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              void syncGcalNow();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            disabled={gcalSyncing}
            title={
              gcalSyncError
                ? `Last sync failed: ${gcalSyncError}`
                : "Push your moved calendar events to Google Calendar, then refresh"
            }
            style={{
              pointerEvents: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              background: gcalSyncing ? "var(--c-surface2)" : "rgba(255,209,102,0.18)",
              color: "var(--c-text)",
              border: "1px solid rgba(255,209,102,0.85)",
              borderRadius: 6,
              padding: "2px 9px",
              fontSize: 11,
              fontWeight: 700,
              cursor: gcalSyncing ? "default" : "pointer",
              animation: gcalSyncing ? undefined : "priority-pulse 2s ease-in-out infinite",
            }}
          >
            <span aria-hidden>{gcalSyncing ? "⟳" : "📅"}</span>
            {gcalSyncing
              ? "Syncing…"
              : `Sync calendar (${Object.keys(gcalGhosts).length})`}
          </button>
        )}
        {gcalSyncError && Object.keys(gcalGhosts).length > 0 && !gcalSyncing && (
          <span
            title={gcalSyncError}
            style={{ pointerEvents: "auto", fontSize: 11, color: "#ff6c6b", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            ⚠ sync failed
          </span>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 4, pointerEvents: "auto" }}>
          {/* Zoom presets as ONE segmented control (they're a single choice,
              not seven independent toggles) — reads calmer than a row of
              individually-bordered buttons. */}
          <div
            style={{
              display: "inline-flex",
              border: "1px solid var(--c-border)",
              borderRadius: 5,
              overflow: "hidden",
            }}
          >
            {ZOOMS.map((z, i) => (
              <button
                key={z.id}
                onClick={(e) => {
                  e.stopPropagation();
                  onZoomClick(z.id);
                }}
                onPointerDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                title={
                  z.id === "fit"
                    ? "Fit window to all dates in this file"
                    : `Show a ${z.label} window`
                }
                style={{
                  background: timelineView.zoom === z.id ? "var(--c-accent)" : "transparent",
                  color: timelineView.zoom === z.id ? "#fff" : "var(--c-text-dim)",
                  border: "none",
                  borderLeft: i > 0 ? "1px solid var(--c-border)" : "none",
                  padding: "2px 7px",
                  fontSize: 10.5,
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                {z.label}
              </button>
            ))}
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              goToToday();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            title="Jump back to today (recentre the window, scroll to the working day)"
            style={{
              background: "transparent",
              color: "#e0a458",
              border: "1px solid var(--c-border)",
              borderRadius: 5,
              padding: "2px 7px",
              fontSize: 10.5,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            ⊙ Today
          </button>
          <span
            aria-hidden
            style={{ width: 1, alignSelf: "stretch", background: "var(--c-border)", margin: "0 3px" }}
          />
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowDayTicks((v) => !v);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            title={showDayTicks ? "Hide day gridlines" : "Show day gridlines"}
            style={{
              background: showDayTicks ? "var(--c-accent)" : "transparent",
              color: showDayTicks ? "#fff" : "var(--c-text-dim)",
              border: "1px solid var(--c-border)",
              borderRadius: 5,
              padding: "2px 7px",
              fontSize: 10.5,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            📆{compactHeader ? "" : " Days"}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setWorkHoursMode((v) => !v);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            title={
              workHoursMode
                ? "Switch back to a full 24h Y-axis"
                : "Zoom Y-axis to working hours (08:00–20:00); out-of-hours chips clamp to the edge"
            }
            style={{
              background: workHoursMode ? "var(--c-accent)" : "transparent",
              color: workHoursMode ? "#fff" : "var(--c-text-dim)",
              border: "1px solid var(--c-border)",
              borderRadius: 5,
              padding: "2px 7px",
              fontSize: 10.5,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            💼 {workHoursMode ? "8–20" : "24h"}
          </button>
          <span
            aria-hidden
            style={{ width: 1, alignSelf: "stretch", background: "var(--c-border)", margin: "0 3px" }}
          />
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowLegend((v) => !v);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            title="Show / hide the legend (item types + colours)"
            style={{
              background: showLegend ? "var(--c-accent)" : "transparent",
              color: showLegend ? "#fff" : "var(--c-text-dim)",
              border: "1px solid var(--c-border)",
              borderRadius: 5,
              padding: "2px 7px",
              fontSize: 10.5,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            🔑{compactHeader ? "" : " Key"}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setScheduleMode(!scheduleMode);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            title={
              scheduleMode
                ? "Exit schedule mode"
                : "Schedule mode: drag a node from the graph onto the timeline to set its date + time"
            }
            style={{
              background: scheduleMode ? "#a3be8c" : "transparent",
              color: scheduleMode ? "#1c1c1e" : "var(--c-text-dim)",
              border: scheduleMode ? "1px solid #a3be8c" : "1px solid var(--c-border)",
              borderRadius: 5,
              padding: "2px 7px",
              fontSize: 10.5,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            📅{scheduleMode ? " Drop on date" : compactHeader ? "" : " Schedule"}
          </button>
        </div>
      </div>

      {/* Legend / key — item types + tag/calendar colours. */}
      {showLegend && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: 26,
            right: 10,
            zIndex: 30,
            background: "var(--c-surface)",
            border: "1px solid var(--c-border)",
            borderRadius: 8,
            padding: "8px 10px",
            boxShadow: "0 8px 28px rgba(0,0,0,0.5)",
            maxWidth: 240,
            fontSize: 11,
            color: "var(--c-text)",
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 9.5, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--c-text-dim)", marginBottom: 5 }}>
            Item types
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 8px", alignItems: "center" }}>
            <span aria-hidden style={{ textAlign: "center" }}>⏱</span>
            <span>Scheduled task</span>
            <span aria-hidden style={{ textAlign: "center" }}>⚑</span>
            <span>Deadline</span>
            <span aria-hidden style={{ justifySelf: "center", width: 18, height: 9, background: "#5fb3a1", borderRadius: 3 }} />
            <span>Event / duration</span>
            <span aria-hidden style={{ justifySelf: "center", width: 12, height: 12, borderRadius: "50%", border: "2px dashed #ffd166" }} />
            <span>Moved — needs Sync</span>
          </div>
          {Object.keys(tagColors).length > 0 && (
            <>
              <div style={{ fontWeight: 700, fontSize: 9.5, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--c-text-dim)", margin: "8px 0 5px" }}>
                Tags / calendars
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: 150, overflowY: "auto" }}>
                {Object.entries(tagColors).map(([tag, color]) => (
                  <div key={tag} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 12, height: 12, borderRadius: 3, background: color, flexShrink: 0, border: "1px solid rgba(0,0,0,0.3)" }} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tag}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Sticky date axis — the month + day-number labels, pinned to the
          bottom of the band OUTSIDE the scroll rail so they're always visible
          no matter the vertical scroll position. (The gridlines they label
          live in the scrolling content and span its full height.) A gentle
          gradient fades the strip so chips scrolling underneath read clearly. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 22,
          pointerEvents: "none",
          background: "linear-gradient(to top, var(--c-surface) 55%, transparent)",
          overflow: "hidden",
          zIndex: 9,
        }}
      >
        {months.map((m) => {
          const left = pct(m.getTime());
          if (left < -2 || left > 102) return null;
          return (
            <div
              key={`ml${m.getTime()}`}
              style={{ position: "absolute", left: `${left}%`, bottom: 2, transform: "translateX(3px)", fontSize: 10, color: "var(--c-text-dim)", whiteSpace: "nowrap" }}
            >
              {MONTHS[m.getMonth()]}
              {m.getMonth() === 0 ? ` ${m.getFullYear()}` : ""}
            </div>
          );
        })}
        {showDayLabels &&
          days.map((d) => {
            const left = pct(d.getTime());
            if (left < -2 || left > 102) return null;
            const isMonday = d.getDay() === 1;
            const isWeekend = d.getDay() === 0 || d.getDay() === 6;
            const showWeekday = pxPerDay >= 40;
            return (
              <div
                key={`dl${d.getTime()}`}
                style={{
                  position: "absolute",
                  left: `${left}%`,
                  bottom: 2,
                  marginLeft: 3,
                  display: "flex",
                  gap: 3,
                  alignItems: "baseline",
                  fontSize: 9,
                  color: isWeekend ? "var(--c-red)" : "var(--c-text-dim)",
                  whiteSpace: "nowrap",
                  opacity: isMonday ? 1 : isWeekend ? 0.8 : 0.6,
                }}
              >
                {showWeekday && (
                  <span style={{ fontWeight: 600, letterSpacing: 0.2 }}>{WEEKDAYS[d.getDay()]}</span>
                )}
                <span>{d.getDate()}</span>
              </div>
            );
          })}
      </div>

      {/* Scrollable TIME content. The rail scrolls vertically; everything
          date/time-positioned lives in a tall content layer (timeContentH) so
          each event gets real room. The toolbar + legend above stay fixed. */}
      <div
        ref={railRef}
        onPointerDown={onPanStart}
        onDoubleClick={onBandDoubleClick}
        onDragOver={(e) => {
          if (!scheduleMode) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDrop={(e) => {
          if (!scheduleMode) return;
          e.preventDefault();
          const nodeId =
            e.dataTransfer.getData("application/orggui-node-id") || scheduleDragNodeId || "";
          if (!nodeId) return;
          const node = doc?.nodes.find((n) => n.id === nodeId);
          if (!node) return;
          const dt = dateAtClientX(e.clientX);
          // Lane mode has no time axis — schedule date-only there.
          const dateStr = laneMode
            ? isoOf(dt)
            : `${isoOf(dt)} ${timeAtRailY(contentY(e.clientY), timeContentH, workHoursMode)}`;
          Promise.resolve(scheduleNode(node, dateStr, "scheduled")).catch(() => {});
          setScheduleDragNode(null);
          setScheduleMode(false);
        }}
        title={
          scheduleMode
            ? "Drop a graph node here to schedule it at the X = date, Y = time of the drop point"
            : timelineView.zoom === "fit"
              ? "Double-click to add a milestone · use the zoom buttons to focus a date range"
              : "Drag to pan · scroll for all times · double-click empty band to add a milestone"
        }
        style={{
          position: "absolute",
          inset: 0,
          overflowX: "hidden",
          overflowY: "auto",
          cursor: scheduleMode
            ? "copy"
            : timelineView.zoom === "fit"
              ? "default"
              : panRef.current
                ? "grabbing"
                : "grab",
        }}
      >
        <div style={{ position: "relative", width: "100%", height: timeContentH }}>

      {/* Month gridlines (vertical, span the full content so they're visible
          at any scroll). The month/day LABELS live in the sticky date-axis
          footer below the rail, not here, so they stay readable no matter how
          far the band is scrolled. */}
      {months.map((m) => {
        const left = pct(m.getTime());
        if (left < -2 || left > 102) return null;
        return (
          <div key={`m${m.getTime()}`} style={{ position: "absolute", left: `${left}%`, top: 24, bottom: 0, width: 1, background: "var(--c-border)", opacity: 0.5 }} />
        );
      })}

      {/* Day gridlines at narrower zoom levels, plus a subtle weekend tint so
          the week rhythm reads at a glance (the same planning texture a paper
          planner gets by shading weekends). The tint is skipped when a day is
          only a few px wide — it would band together into noise. */}
      {days.map((d) => {
        const left = pct(d.getTime());
        const dow = d.getDay();
        const isMonday = dow === 1;
        const isWeekend = dow === 0 || dow === 6;
        // True width of THIS day (next local midnight − this one), so the tint
        // stays aligned with the gridlines across DST transitions (a 23h/25h
        // Sunday would otherwise over/under-shoot by ~1h of pixels).
        const nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
        const dayW = ((nextMidnight - d.getTime()) / span) * 100;
        // Cull on the day's RIGHT edge, not its start: a weekend day whose
        // midnight is just off-screen left still has most of its tint visible.
        if (left + dayW < -2 || left > 102) return null;
        return (
          <div key={`d${d.getTime()}`}>
            {isWeekend && pxPerDay >= 10 && (
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  left: `${left}%`,
                  width: `${dayW}%`,
                  top: 24,
                  bottom: 0,
                  background: "rgba(148,158,178,0.055)",
                  pointerEvents: "none",
                }}
              />
            )}
            <div
              style={{
                position: "absolute",
                left: `${left}%`,
                top: 24,
                bottom: 0,
                width: 1,
                background: "var(--c-border)",
                opacity: isMonday ? 0.45 : 0.18,
              }}
            />
          </div>
        );
      })}

      {/* Horizontal time gridlines spanning the chip-zone. In 24h mode we
          mark every 3 hours; in working-hours mode we mark every hour from
          08:00 to 20:00 so the denser visible window stays readable.
          Hidden in lane mode — y is a packing artifact there, not a time. */}
      {!laneMode && (() => {
        const bandH = timeContentH;
        const usable = Math.max(40, bandH - TIME_TOP_PX - TIME_BOTTOM_OFFSET);
        const hours = workHoursMode
          ? [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]
          : [0, 3, 6, 9, 12, 15, 18, 21];
        return hours.map((h) => {
          // y is computed the same way the chip y-mapper does it so the
          // gridlines and chip positions stay in lockstep across modes.
          const minOfDay = h * 60;
          const y = workHoursMode
            ? TIME_TOP_PX +
              ((minOfDay - WORK_START_MIN) / (WORK_END_MIN - WORK_START_MIN)) *
                usable
            : TIME_TOP_PX + (h / 24) * usable;
          const isMajor = workHoursMode
            ? h === 12 || h === WORK_START_MIN / 60 || h === WORK_END_MIN / 60
            : h === 0 || h === 12;
          return (
            <div key={`tg${h}`}>
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: y,
                  height: 1,
                  background: "var(--c-border)",
                  opacity: isMajor ? 0.32 : 0.16,
                  pointerEvents: "none",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  left: 4,
                  top: y - 6,
                  fontSize: 9,
                  fontFamily: "ui-monospace, monospace",
                  fontVariantNumeric: "tabular-nums",
                  color: "var(--c-text-dim)",
                  opacity: isMajor ? 0.7 : 0.45,
                  pointerEvents: "none",
                }}
              >
                {String(h).padStart(2, "0")}:00
              </div>
            </div>
          );
        });
      })()}

      {/* Duration bars: org timestamps that carry a range render as a span
          rather than a point. A same-day time block (SCHEDULED
          <… 10:00-11:30>) is a VERTICAL bar between its start- and end-time
          rows; a multi-day event (TIMESTAMP <a>--<b>) is a HORIZONTAL bar
          across its day columns. Click to select + focus the node (then the
          usual arrow-key nudge moves the start). */}
      {(() => {
        const bandH = timeContentH;
        const out: React.ReactNode[] = [];

        // ── Collision map for the flowing labels below ────────────────────
        // A narrow same-day bar (typical Google-Calendar import at ≤1M zoom)
        // can't carry its own text; the readable fix is a label floated to
        // its RIGHT — but only when that space is actually empty, or we'd
        // recreate the old "labels smeared across neighbouring events" soup.
        // Collect every occupant's (day, y-range): other same-day bars, timed
        // point chips, and each day column of a multi-day timed staircase.
        // idx = position in nodeDates (identity, so a bar can skip ITSELF
        // without also exempting same-day siblings); idx -1 = an already
        // PLACED label, pushed after rendering — the only occupant that can
        // collide with a label in its own day column. Net behaviour for
        // back-to-back same-day meetings: first label wins, the second falls
        // back to its tooltip instead of painting on top of the first.
        const colliders: { idx: number; dayMs: number; top: number; bot: number }[] = [];
        const staircaseDays = new Set<number>();
        for (let ci = 0; ci < nodeDates.length; ci++) {
          const d = nodeDates[ci];
          const isSpan = d.msEnd != null && d.msEnd > d.ms;
          if (isSpan) {
            if (d.timeOfDay && d.timeOfDayEnd) {
              const nDays = Math.round(((d.msEnd as number) - d.ms) / MS_DAY) + 1;
              for (let k = 0; k < Math.min(nDays, 90); k++) staircaseDays.add(d.ms + k * MS_DAY);
            }
            continue; // all-day spans live in the strip; their wash is fine under labels
          }
          if (!d.timeOfDay) continue; // date-only → all-day strip
          if (d.timeOfDayEnd && d.timeOfDayEnd > d.timeOfDay) {
            const t1 = yForTimeOfDay(d.timeOfDay, bandH, workHoursMode);
            const t2 = yForTimeOfDay(d.timeOfDayEnd, bandH, workHoursMode);
            const top = Math.min(t1, t2);
            colliders.push({ idx: ci, dayMs: d.ms, top, bot: top + Math.max(24, Math.abs(t2 - t1)) });
          } else {
            const y = yForTimeOfDay(d.timeOfDay, bandH, workHoursMode);
            colliders.push({ idx: ci, dayMs: d.ms, top: y - 9, bot: y + 9 });
          }
        }
        // True when the horizontal strip [top..top+14] to the right of DAY is
        // free for a labelPx-wide label. Bars/chips in the bar's OWN column
        // (idx >= 0, same day) sit LEFT of the label zone and are ignored;
        // a same-day PLACED label (idx -1) occupies exactly that zone and
        // blocks. Strictly-earlier days can never reach a right-flowing label.
        const labelFits = (selfIdx: number, dayMs: number, top: number, labelPx: number): boolean => {
          if (pxPerDay <= 0) return false;
          const reachDays = Math.ceil((labelPx + 8) / pxPerDay);
          for (let k = 1; k <= reachDays; k++) {
            if (staircaseDays.has(dayMs + k * MS_DAY)) return false;
          }
          for (const c of colliders) {
            if (c.idx === selfIdx) continue;
            if (c.idx >= 0 && c.dayMs === dayMs) continue;
            if (c.dayMs < dayMs) continue;
            if (c.dayMs - dayMs > reachDays * MS_DAY) continue;
            if (c.bot >= top - 2 && c.top <= top + 16) return false;
          }
          return true;
        };

        // ── Side-by-side columns for OVERLAPPING same-day bars ─────────────
        // Two meetings at 10:00 on the same day used to render superimposed
        // (one bar painted through the other) — with a real synced calendar
        // that's constant. Google-Calendar style fix: within each day, bars
        // whose time ranges overlap form a cluster and split the day column
        // evenly. Keyed by nodeDates index; committed geometry (a bar being
        // drag-previewed renders full-width on top, which reads fine).
        const sdLayout = new Map<number, { col: number; cols: number }>();
        {
          type SdBar = { idx: number; top: number; bot: number; col: number };
          const byDay = new Map<number, SdBar[]>();
          for (let ci = 0; ci < nodeDates.length; ci++) {
            const d = nodeDates[ci];
            if (!hasDuration(d)) continue;
            if (d.msEnd != null && d.msEnd > d.ms) continue; // multi-day → staircase/block
            if (!(d.timeOfDay && d.timeOfDayEnd)) continue;
            const t1 = yForTimeOfDay(d.timeOfDay, bandH, workHoursMode);
            const t2 = yForTimeOfDay(d.timeOfDayEnd, bandH, workHoursMode);
            const top = Math.min(t1, t2);
            const entry: SdBar = { idx: ci, top, bot: top + Math.max(24, Math.abs(t2 - t1)), col: 0 };
            const arr = byDay.get(d.ms);
            if (arr) arr.push(entry);
            else byDay.set(d.ms, [entry]);
          }
          for (const arr of byDay.values()) {
            arr.sort((a, b) => a.top - b.top || a.bot - b.bot);
            let i0 = 0;
            while (i0 < arr.length) {
              // Grow the overlap cluster while the next bar starts before the
              // cluster's running bottom.
              let end = arr[i0].bot;
              let i1 = i0 + 1;
              while (i1 < arr.length && arr[i1].top < end - 1) {
                end = Math.max(end, arr[i1].bot);
                i1++;
              }
              const cluster = arr.slice(i0, i1);
              const colEnds: number[] = [];
              for (const b of cluster) {
                let col = 0;
                while (col < colEnds.length && b.top < colEnds[col] - 1) col++;
                b.col = col;
                colEnds[col] = b.bot;
              }
              for (const b of cluster) sdLayout.set(b.idx, { col: b.col, cols: colEnds.length });
              i0 = i1;
            }
          }
        }

        for (let i = 0; i < nodeDates.length; i++) {
          const d = nodeDates[i];
          if (!hasDuration(d)) continue;
          // Lane mode replaces every TIMED geometry (same-day bars, timed
          // staircases) with labelled lane chips; only the all-day multi-day
          // block wash keeps rendering here (its title lives in the strip).
          if (laneMode && !(d.msEnd != null && d.msEnd > d.ms && !(d.timeOfDay && d.timeOfDayEnd))) continue;

          // Effective span geometry: follow the optimistic preview while a
          // shift/resize gesture is live, else the committed doc values.
          const prev = spanPreview && spanPreview.nodeId === d.nodeId ? spanPreview : null;
          const effStartFull = prev ? prev.startMs : d.ms + minOfTime(d.timeOfDay) * 60000;
          const effEndFull = prev
            ? prev.endMs
            : (d.msEnd ?? d.ms) + minOfTime(d.timeOfDayEnd ?? d.timeOfDay) * 60000;
          const effStartDay = startOfDay(new Date(effStartFull)).getTime();
          const effEndDay = startOfDay(new Date(effEndFull)).getTime();
          const effStartTime = (prev ? prev.hasStartTime : !!d.timeOfDay)
            ? hhmmOf(effStartFull)
            : null;
          const effEndTime = (prev ? prev.hasEndTime : !!d.timeOfDayEnd)
            ? hhmmOf(effEndFull)
            : null;
          const multiDay = effEndDay > effStartDay;

          const left = pct(effStartDay);
          // Right edge of a multi-day bar. A timed end reaches its actual end
          // instant (e.g. ends 17:00 on the last day); an all-day end covers
          // the WHOLE last day — extend to the start of the following day so a
          // Jun 20–22 event visually spans all three columns, not stopping at
          // the left edge of the 22nd (which read as a day short).
          const endOfLastDay = startOfDay(new Date(effEndDay + 36 * 3_600_000)).getTime();
          const rightMs = multiDay
            ? effEndTime
              ? effEndFull
              : endOfLastDay
            : effStartDay;
          const right = pct(rightMs);
          if (right < -5 || left > 105) continue;

          const isSelected = selectedSpanId === d.nodeId;
          const resizable = d.kind !== "deadline";
          const bg = chipBackground(d.tagsAll, tagColors, 0.42);
          // Border must be a SOLID colour (chipBackground may return a
          // linear-gradient for multi-tag nodes, which is invalid for
          // `border`). Use the first coloured tag, else the kind's default.
          const firstTagColor = d.tagsAll.map((t) => tagColors[t]).find(Boolean);
          const border = hexToRgba(firstTagColor ?? d.color, 0.85);
          const truncated = d.title.length > 30 ? d.title.slice(0, 29) + "…" : d.title;
          const rangeLabel = `${effStartTime ?? ""}${effEndTime ? "–" + effEndTime : ""}`.trim();

          // Resize grip on one edge. `side` is the physical edge it sits on;
          // `edge` is what it changes. Drags via onBarResize; stops the bar's
          // move-drag. Left/right grips (full height, ew-resize) change a date;
          // top/bottom grips (full width, ns-resize) change a time.
          const gripEl = (
            edge: "startTime" | "endTime" | "startDate" | "endDate",
            side: "top" | "bottom" | "left" | "right",
          ) => {
            // Grips appear ONLY on the selected bar, so an unselected event's
            // text isn't covered. They're slim — a thin accent rule on the
            // edge — and centred so they don't crowd the corners.
            if (!isSelected) return null;
            const accent = "rgba(255,209,102,0.95)";
            const horizontal = side === "left" || side === "right";
            const style: React.CSSProperties = {
              position: "absolute",
              background: accent,
              borderRadius: 3,
              touchAction: "none",
              cursor: horizontal ? "ew-resize" : "ns-resize",
              ...(horizontal
                ? {
                    top: 3,
                    bottom: 3,
                    width: 4,
                    left: side === "left" ? 0 : undefined,
                    right: side === "right" ? 0 : undefined,
                  }
                : {
                    left: 6,
                    right: 6,
                    height: 3,
                    top: side === "top" ? 0 : undefined,
                    bottom: side === "bottom" ? 0 : undefined,
                  }),
            };
            return (
              <span
                key={`${edge}-${side}`}
                data-pin
                onPointerDown={(e) => onBarResize(e, d, edge)}
                style={style}
                title={`Drag to change ${edge.startsWith("start") ? "start" : "end"} ${
                  edge.endsWith("Time") ? "time" : "date"
                }`}
              />
            );
          };

          const timed = !!effStartTime && !!effEndTime;
          const dayCount = multiDay ? Math.round((effEndDay - effStartDay) / MS_DAY) + 1 : 1;
          // A multi-day TIMED event renders as a per-day "staircase" so the
          // start time (top of day 1) and end time (bottom of the last day)
          // are both visible. Very long spans fall back to a flat bar.
          const useStaircase = multiDay && timed && dayCount <= 62;

          // Drag the bar body to move the whole span (onBarDown handles
          // click-to-select-vs-drag); the grips resize an edge; a plain click
          // selects the bar so arrow keys shift it. Deadlines are click-only.
          if (useStaircase) {
            const topY = yForTimeOfDay("00:00", bandH, workHoursMode);
            const botY = yForTimeOfDay("23:59", bandH, workHoursMode);
            const segW = Math.max(8, Math.min(46, pxPerDay - 4));
            const segs: React.ReactNode[] = [];
            for (let k = 0; k < dayCount; k++) {
              // +12h before startOfDay keeps day stepping DST-safe.
              const dayMs = startOfDay(new Date(effStartDay + k * MS_DAY + 12 * 3_600_000)).getTime();
              const xp = pct(dayMs);
              if (xp < -6 || xp > 106) continue;
              const isFirst = k === 0;
              const isLast = k === dayCount - 1;
              const segTop = isFirst ? yForTimeOfDay(effStartTime, bandH, workHoursMode) : topY;
              const segBot = isLast ? yForTimeOfDay(effEndTime, bandH, workHoursMode) : botY;
              const segH = Math.max(6, segBot - segTop);
              segs.push(
                <button
                  key={`dur${i}-${k}`}
                  data-pin
                  onPointerDown={(e) => onBarDown(e, d)}
                  title={`${d.title}\n${effStartTime} → ${effEndTime} (${dayCount} days — drag to move, edges to resize)`}
                  style={{
                    position: "absolute",
                    left: `${xp}%`,
                    top: segTop,
                    width: segW,
                    height: segH,
                    transform: "translateX(0)",
                    borderRadius: 4,
                    background: bg,
                    border: isSelected ? "2px solid #ffd166" : `1px solid ${border}`,
                    color: "var(--c-text)",
                    padding: 0,
                    cursor: "grab",
                    overflow: "visible",
                    boxShadow: isSelected ? "0 0 0 2px rgba(255,209,102,0.5)" : "none",
                  }}
                >
                  {/* Floating start/end labels are nowrap text hanging OUTSIDE
                      an ~8px column with no collision avoidance — at zoomed-out
                      widths they smear across neighbouring bars and each other.
                      Gate them on the same density threshold as the axis day
                      labels; the full title + range stays in the tooltip. */}
                  {isFirst && pxPerDay >= 26 && (
                    <span
                      style={{
                        position: "absolute",
                        top: -1,
                        left: segW / 2 + 5,
                        whiteSpace: "nowrap",
                        fontSize: 10,
                        fontWeight: 600,
                        fontVariantNumeric: "tabular-nums",
                        pointerEvents: "none",
                        background: "var(--c-bg)",
                        padding: "0 3px",
                        borderRadius: 3,
                        maxWidth: 180,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {effStartTime} {truncated}
                    </span>
                  )}
                  {isLast && pxPerDay >= 26 && (
                    <span
                      style={{
                        position: "absolute",
                        bottom: -1,
                        right: segW / 2 + 5,
                        whiteSpace: "nowrap",
                        fontSize: 10,
                        fontWeight: 500,
                        fontVariantNumeric: "tabular-nums",
                        opacity: 0.85,
                        pointerEvents: "none",
                        background: "var(--c-bg)",
                        padding: "0 3px",
                        borderRadius: 3,
                      }}
                    >
                      →{effEndTime}
                    </span>
                  )}
                  {resizable && isFirst && gripEl("startTime", "top")}
                  {resizable && isFirst && gripEl("startDate", "left")}
                  {resizable && isLast && gripEl("endTime", "bottom")}
                  {resizable && isLast && gripEl("endDate", "right")}
                </button>,
              );
            }
            // Faint full-period wash behind the segments so the day columns
            // read as ONE continuous multi-day event, not separate bars.
            const washLeft = Math.max(0, left);
            const washWidth = Math.max(0.5, Math.min(100, right) - washLeft);
            const wash = (
              <div
                key={`dur${i}-wash`}
                style={{
                  position: "absolute",
                  left: `${washLeft}%`,
                  width: `${washWidth}%`,
                  top: topY,
                  height: Math.max(8, botY - topY),
                  background: bg,
                  opacity: isSelected ? 0.28 : 0.16,
                  borderRadius: 6,
                  pointerEvents: "none",
                }}
              />
            );
            out.push(
              <div key={`dur${i}`}>
                {wash}
                {segs}
              </div>,
            );
          } else if (multiDay) {
            // All-day multi-day span → a TALL translucent block that occupies
            // the whole day columns it covers (not a thin strip), so the span
            // reads as "these days are taken". A solid header carries the
            // title; the see-through body lets point chips on those days show
            // through. Edges resize the start/end DATE.
            const topY = yForTimeOfDay("00:00", bandH, workHoursMode);
            const botY = yForTimeOfDay("23:59", bandH, workHoursMode);
            const leftClamped = Math.max(0, left);
            const rightClamped = Math.min(100, right);
            const widthPct = Math.max(0.5, rightClamped - leftClamped);
            const blockH = Math.max(28, botY - topY);
            out.push(
              <button
                key={`dur${i}`}
                data-pin
                onPointerDown={(e) => onBarDown(e, d)}
                title={`${d.title}\n${d.iso}${d.timeOfDayEnd ? " → " + d.timeOfDayEnd : ""} (${dayCount}-day event — drag to move, edges to resize)`}
                style={{
                  position: "absolute",
                  left: `${leftClamped}%`,
                  top: topY,
                  width: `${widthPct}%`,
                  height: blockH,
                  borderRadius: 6,
                  background: chipBackground(d.tagsAll, tagColors, isSelected ? 0.34 : 0.2),
                  border: isSelected ? "2px solid #ffd166" : `1px solid ${border}`,
                  color: "var(--c-text)",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "stretch",
                  justifyContent: "flex-start",
                  padding: 0,
                  overflow: "hidden",
                  cursor: "grab",
                  boxShadow: isSelected ? "0 0 0 2px rgba(255,209,102,0.5)" : "none",
                }}
              >
                {/* No in-block title header any more: overlapping all-day
                    events' headers all sat at the same Y and superimposed
                    exactly. The title now lives in this event's bar in the
                    pinned ALL-DAY strip (readable at every zoom) + the hover
                    tooltip; the block itself is the translucent "these days
                    are taken" wash plus the drag/resize surface. */}
                {resizable && gripEl("startDate", "left")}
                {resizable && gripEl("endDate", "right")}
              </button>,
            );
          } else {
            // Same-day time block → vertical bar between start/end rows.
            // Edges resize the start/end TIME.
            const yStart = yForTimeOfDay(effStartTime, bandH, workHoursMode);
            const yEnd = yForTimeOfDay(effEndTime, bandH, workHoursMode);
            const top = Math.min(yStart, yEnd);
            const height = Math.max(24, Math.abs(yEnd - yStart));
            // Bar width tracks the day column. The old hard 40 px floor meant
            // that at zoomed-out widths (Fit ≈ 10–15 px/day) every bar covered
            // 3+ day columns and neighbouring bars stacked into a solid wall.
            const wFull =
              pxPerDay >= 46
                ? Math.min(170, pxPerDay - 6)
                : Math.max(10, Math.min(40, Math.round(pxPerDay * 0.9)));
            // Overlap cluster → split the day column side-by-side. The bar
            // being drag-previewed opts out (full width, on top, follows the
            // cursor). The cluster must NEVER escape its day column: a floor
            // that widens past wFull would spill split bars over the next
            // day — recreating the 0.2.133 "wall" AND making a drag on the
            // spilled pixels reschedule to the wrong day (onBarDown derives
            // the date from the raw cursor X). So: proportional 3px floor,
            // and xShift hard-clamped so col*(w+1)+w stays inside wFull even
            // for 4+ column clusters (trailing columns then overlap their
            // left sibling instead of invading the neighbouring day).
            const lay = prev ? { col: 0, cols: 1 } : (sdLayout.get(i) ?? { col: 0, cols: 1 });
            const w = lay.cols > 1 ? Math.max(3, Math.floor(wFull / lay.cols) - 1) : wFull;
            const xShift = lay.cols > 1 ? Math.min(lay.col * (w + 1), Math.max(0, wFull - w)) : 0;
            // In-bar text only when it can say something useful ("10:00 Meet…"
            // needs ~64px). Below that the collision-aware flowing label (or
            // the tooltip) carries the words — a 34-60px bar showing "La…" was
            // just noise.
            const showBarText = w >= 64;
            // Keep ALL text INSIDE the bar (ellipsis-clipped) so a title can
            // never spill into the neighbouring day column — the full title +
            // range stays available via the hover tooltip. The time range gets
            // its own line only when the bar is tall enough for two lines.
            const tallEnough = height >= 30;
            out.push(
              <button
                key={`dur${i}`}
                data-pin
                onPointerDown={(e) => onBarDown(e, d)}
                title={`${d.title}\n${rangeLabel} (duration — drag to move, edges to resize)`}
                style={{
                  position: "absolute",
                  left: xShift ? `calc(${left}% + ${xShift}px)` : `${left}%`,
                  top,
                  height,
                  width: w,
                  transform: "translateX(0)",
                  borderRadius: 5,
                  background: chipBackground(d.tagsAll, tagColors, isSelected ? 0.62 : 0.52),
                  border: isSelected ? "2px solid #ffd166" : `1px solid ${border}`,
                  color: "var(--c-text)",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  justifyContent: "center",
                  gap: 1,
                  padding: showBarText ? "3px 6px" : 0,
                  fontSize: 11,
                  fontWeight: 600,
                  overflow: "hidden",
                  cursor: "grab",
                  textAlign: "left",
                  boxShadow: isSelected ? "0 0 0 2px rgba(255,209,102,0.5)" : "none",
                }}
              >
                {/* Title — always inside the bar, ellipsis-clipped to its width
                    so it never escapes into the next column. Hidden entirely on
                    the slim zoomed-out bars (tooltip carries it). */}
                {showBarText && (
                  <span
                    style={{
                      width: "100%",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      textShadow: "0 1px 2px rgba(0,0,0,0.55)",
                    }}
                  >
                    {/* Short bar = one line only → lead with the time so the
                        line reads "10:00 Meeting…". Tall bars keep the time on
                        its own second line below. */}
                    {!tallEnough && effStartTime ? `${effStartTime} ` : ""}
                    {d.title}
                  </span>
                )}
                {/* Time range — second line, only when the bar is tall enough;
                    otherwise it's in the tooltip. */}
                {rangeLabel && tallEnough && showBarText && (
                  <span
                    style={{
                      width: "100%",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      opacity: 0.9,
                      fontSize: 10,
                      fontVariantNumeric: "tabular-nums",
                      fontWeight: 600,
                      textShadow: "0 1px 2px rgba(0,0,0,0.6)",
                    }}
                  >
                    {rangeLabel}
                  </span>
                )}
                {resizable && gripEl("startTime", "top")}
                {resizable && gripEl("endTime", "bottom")}
              </button>,
            );
            // Narrow bar (typical calendar import at ≤1M zoom) → the bar
            // itself is an anonymous sliver. Float "HH:MM Title" beside it,
            // Google-Calendar-month style, but ONLY when the space to the
            // right is actually free (labelFits checks other bars, timed
            // chips and staircase columns) so labels never pile onto
            // neighbouring events. Tooltip still carries the full details.
            // No label for a split (overlapping) bar — its sibling occupies
            // the very zone the label would use; the cluster stays hover-
            // discoverable. Also skip bars scrolled off the left edge: their
            // labels would poke in from the rail edge as orphaned fragments.
            if (!showBarText && pxPerDay >= 14 && !prev && lay.cols === 1 && left >= 0) {
              const labelText = `${effStartTime ?? ""} ${d.title}`.trim();
              const labelPx = Math.min(150, 10 + labelText.length * 5.8);
              if (labelFits(i, effStartDay, top, w + labelPx)) {
                // Claim the zone so a same-day sibling's label falls back to
                // its tooltip instead of painting over this one.
                colliders.push({ idx: -1, dayMs: effStartDay, top: top - 1, bot: top + 15 });
                out.push(
                  <span
                    key={`durlbl${i}`}
                    aria-hidden
                    style={{
                      position: "absolute",
                      left: `calc(${left}% + ${w + 3}px)`,
                      top: top - 1,
                      maxWidth: labelPx,
                      fontSize: 9.5,
                      fontWeight: 600,
                      color: "var(--c-text)",
                      background: "var(--c-bg)",
                      border: `1px solid ${hexToRgba(firstTagColor ?? d.color, 0.5)}`,
                      borderRadius: 3,
                      padding: "0 3px",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      pointerEvents: "none",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {labelText}
                  </span>,
                );
              }
            }
          }
        }
        return out;
      })()}

      {/* ── LANE CHIPS (zoomed-out, text-first) ─────────────────────────────
          The research-backed answer to "many events are just blocks with no
          text": below ~46px/day, every TIMED event renders as a labelled chip
          ("HH:MM Title") whose rectangle INCLUDES the label, greedily packed
          into non-overlapping lanes — vis-timeline's guarantee. x = start
          date; y = packing artifact; a thin underline shows a multi-day
          event's true span when the label is wider than its duration. */}
      {laneMode &&
        laneLayout.items.map((it) => {
          // Render-time viewport cull (packing above is full-set on purpose).
          if (it.xPx + it.chipW < -40 || it.xPx > (railWidth || 0) + 40) return null;
          const d = it.d;
          // isSpan covers BOTH multi-day spans and same-day timed ranges — any
          // item whose end would be destroyed by a point-move.
          const isMulti = it.isSpan;
          const isSelChip =
            !isMulti &&
            timelineSelectedChip != null &&
            timelineSelectedChip.nodeId === d.nodeId &&
            timelineSelectedChip.isDeadline === d.deadline;
          const isSelSpan = isMulti && selectedSpanId === d.nodeId;
          const isSelected = isSelChip || isSelSpan;
          const nudge =
            !isMulti &&
            pendingNudge != null &&
            pendingNudge.nodeId === d.nodeId &&
            pendingNudge.isDeadline === d.deadline
              ? pendingNudge
              : null;
          const xEff = nudge ? it.xPx + ((nudge.ms - d.ms) / MS_DAY) * pxPerDay : it.xPx;
          const y = laneTop + it.lane * (LANE_CHIP_H + LANE_GAP);
          const isOverdue = d.deadline && d.ms <= todayMs;
          const geomW = it.spanDays * pxPerDay;
          const firstTagColor = d.tagsAll.map((t) => tagColors[t]).find(Boolean);
          return (
            <button
              key={`lane-${it.idx}`}
              className={isOverdue ? "deadline-flash" : undefined}
              data-pin
              onPointerDown={(e) => {
                if (isMulti) {
                  // A drag through onChipDown would rewrite the SPAN into a
                  // single point — spans are click-to-select here; move them
                  // at 1W/2W or in the Calendar/Timeline views.
                  e.stopPropagation();
                  return;
                }
                onChipDown(e, {
                  nodeId: d.nodeId,
                  deadline: d.deadline,
                  title: d.title,
                  color: d.color,
                  fixedTime: d.timeOfDay ?? undefined,
                });
              }}
              onClick={
                isMulti
                  ? (e) => {
                      e.stopPropagation();
                      setSelectedSpanId(d.nodeId);
                      setTimelineSelectedChip(null);
                      window.dispatchEvent(
                        new CustomEvent("orggui:focusNode", { detail: { id: d.nodeId } }),
                      );
                    }
                  : undefined
              }
              title={`${d.deadline ? "⚑ Deadline" : "⏱ Scheduled"}: ${d.title}\n${d.iso}${
                d.timeOfDayEnd ? " → " + d.timeOfDayEnd : ""
              }${
                isMulti
                  ? `\n(${it.spanDays > 1 ? `${it.spanDays}-day event` : "timed range"} — click to select; drag at 1W/2W)`
                  : "\nClick to select (← → nudge the date), drag to move it to another day"
              }`}
              style={{
                position: "absolute",
                left: xEff,
                top: y,
                width: it.chipW,
                height: LANE_CHIP_H,
                display: "flex",
                alignItems: "center",
                gap: 3,
                padding: "0 5px",
                borderRadius: 4,
                background: chipBackground(d.tagsAll, tagColors, isSelected ? 0.62 : 0.5),
                color: "var(--c-text)",
                textShadow: "0 1px 2px rgba(0,0,0,0.7)",
                border: isSelected
                  ? "2px solid #ffd166"
                  : d.deadline
                    ? "1px solid rgba(255,108,107,0.85)"
                    : "1px solid rgba(0,0,0,0.3)",
                fontSize: 9.5,
                fontWeight: 700,
                lineHeight: 1,
                whiteSpace: "nowrap",
                overflow: "hidden",
                cursor: isMulti ? "pointer" : "grab",
                userSelect: "none",
                zIndex: 3,
              }}
            >
              <span aria-hidden style={{ fontSize: 9, flexShrink: 0 }}>
                {d.deadline ? "⚑" : "⏱"}
              </span>
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {it.text}
              </span>
              {/* True duration underline when the label out-spans the days */}
              {isMulti && it.chipW > geomW + 2 && (
                <span
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: 0,
                    bottom: 0,
                    width: geomW,
                    height: 2,
                    background: hexToRgba(firstTagColor ?? d.color, 0.95),
                    pointerEvents: "none",
                  }}
                />
              )}
            </button>
          );
        })}

      {/* Google-calendar "ghosts": where Google still has an event the user
          moved locally. A faded marker sits at the original spot with a dashed
          line to the new position; the floating "Sync calendar" button (top
          row) pushes the moves and clears the ghosts. Click a ghost to forget
          it without syncing. */}
      {(() => {
        const ghosts = Object.values(gcalGhosts);
        if (ghosts.length === 0 || !doc) return null;
        const railWidthPx = railWidth || railRef.current?.getBoundingClientRect().width || 800;
        const bandH = timeContentH;
        const xPx = (ms: number) => (pct(startOfDay(new Date(ms)).getTime()) / 100) * railWidthPx;
        const out: React.ReactNode[] = [];
        for (const g of ghosts) {
          const node = doc.nodes.find((n) => n.orgId === g.orgId);
          if (!node) continue;
          const curStart = parseOrgDate(node.timestamp);
          if (!curStart) continue;
          const curTime = timeOfDayFromIso(node.timestamp);
          const gStartTime = g.hasStartTime ? hhmmOf(g.startMs) : null;
          const gEndTime = g.hasEndTime && g.endMs != null ? hhmmOf(g.endMs) : null;
          const gx = xPx(g.startMs);
          const cx = xPx(curStart.getTime());
          // Lane mode has no time axis — pin ghosts to a fixed row under the
          // toolbar instead of a (meaningless) time-derived y.
          const cy = laneMode
            ? laneTop + 8
            : yForTimeOfDay(curTime ?? "12:00", bandH, workHoursMode);
          // Faded "ghost" geometry mirrors the original event: a vertical bar
          // for a same-day timed event, a small chip otherwise.
          const sameDayTimed =
            g.endMs != null &&
            !!gStartTime &&
            !!gEndTime &&
            startOfDay(new Date(g.startMs)).getTime() === startOfDay(new Date(g.endMs)).getTime();
          // Track the day column like the bars do — the old 36 px floor made
          // every ghost span multiple day columns at zoomed-out widths.
          const ghostW =
            pxPerDay >= 42
              ? Math.min(120, pxPerDay - 6)
              : Math.max(10, Math.min(36, Math.round(pxPerDay * 0.9)));
          let ghostTop: number;
          let ghostH: number;
          if (laneMode) {
            ghostTop = laneTop;
            ghostH = 16;
          } else if (sameDayTimed) {
            const t1 = yForTimeOfDay(gStartTime as string, bandH, workHoursMode);
            const t2 = yForTimeOfDay(gEndTime as string, bandH, workHoursMode);
            ghostTop = Math.min(t1, t2);
            ghostH = Math.max(18, Math.abs(t2 - t1));
          } else {
            ghostTop = yForTimeOfDay(gStartTime ?? "12:00", bandH, workHoursMode) - 10;
            ghostH = 20;
          }
          const ghostCx = gx + ghostW / 2;
          const ghostCy = ghostTop + ghostH / 2;
          // Both endpoints far off-screen → nothing useful to draw.
          if ((gx < -20 && cx < -20) || (gx > railWidthPx + 20 && cx > railWidthPx + 20)) continue;
          out.push(
            <svg
              key={`ghostline-${g.orgId}`}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}
            >
              <line
                x1={ghostCx}
                y1={ghostCy}
                x2={cx}
                y2={cy}
                stroke="rgba(255,209,102,0.75)"
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
            </svg>,
          );
          out.push(
            <div
              key={`ghost-${g.orgId}`}
              data-pin
              onClick={(e) => {
                e.stopPropagation();
                void syncGcalNow();
              }}
              title={`“${g.title}” moved here on the timeline, but Google still has it ${
                gStartTime ? `at ${gStartTime}` : "at the original time"
              }.\nClick to push your change to Google Calendar (or the × to forget it).`}
              style={{
                position: "absolute",
                left: gx,
                top: ghostTop,
                width: ghostW,
                height: ghostH,
                borderRadius: 4,
                // Greyed + diagonally hatched ("cross-shaded") so it reads as a
                // stale copy, with a dashed amber border tying it to the move.
                background:
                  "repeating-linear-gradient(45deg, rgba(140,144,156,0.34) 0 5px, rgba(140,144,156,0.10) 5px 10px)",
                border: "1px dashed rgba(255,209,102,0.85)",
                cursor: gcalSyncing ? "default" : "pointer",
                opacity: gcalSyncing ? 0.5 : 1,
                zIndex: 6,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                overflow: "visible",
              }}
            >
              {ghostW >= 20 && (
                <span
                  aria-hidden
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: "rgba(255,209,102,0.95)",
                    textShadow: "0 1px 2px rgba(0,0,0,0.6)",
                    pointerEvents: "none",
                  }}
                >
                  ⟳
                </span>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  clearGcalGhost(g.orgId);
                }}
                title="Forget this ghost (don't push to Google)"
                style={{
                  position: "absolute",
                  top: -7,
                  right: -7,
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  background: "var(--c-bg)",
                  border: "1px solid var(--c-border)",
                  color: "var(--c-text-dim)",
                  cursor: "pointer",
                  fontSize: 10,
                  lineHeight: 1,
                  padding: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                ×
              </button>
            </div>,
          );
        }
        return out;
      })()}

      {/* Task chips with pixel-proximity clustering. Two chips whose on-
          screen positions are within CLUSTER_PX of each other (and share
          the deadline-vs-scheduled flag) collapse into a single stack
          indicator. This catches the visually-overlapping case — e.g. a
          10:00 and a 10:15 task end up at the same dot at most zoom
          levels — not just exact same-time matches.
          The chip body adapts to available horizontal space: full (icon +
          title + time) when the day cell is wide, compact (icon + time)
          mid-range, dot (icon only) when narrow. */}
      {(() => {
        // Lane mode renders every timed event as a labelled lane chip in its
        // own layer — the y-positioned point chips (and their dot/cluster
        // machinery) only apply to the time-of-day layout.
        if (laneMode) return null;
        const railWidthPx = railWidth || railRef.current?.getBoundingClientRect().width || 800;
        const bandH = timeContentH;
        const CLUSTER_X_PX = 22; // ~one chip width on a typical 1Y zoom
        const CLUSTER_Y_PX = 20; // chip height ≈ 18 px → cluster anything touching

        // Per-day-cell rendering tier based on horizontal room. Same value
        // is used by every singleton + stack chip below so the look is
        // uniform across the band.
        const chipWidthAvail = Math.max(20, Math.min(220, pxPerDay - 6));
        type Tier = "full" | "compact" | "dot";
        // Thresholds tuned so a "compact" chip is ALWAYS wide enough for the
        // full HH:MM time (≈60px incl. icon + padding) — below that we drop to a
        // clean dot rather than a half-clipped "09:0". "full" adds the title
        // once there's room for it too.
        const tier: Tier =
          chipWidthAvail >= 96 ? "full" : chipWidthAvail >= 64 ? "compact" : "dot";

        type Anchor = (typeof nodeDates)[number] & {
          leftPct: number;
          leftPx: number;
          topPx: number;
        };

        const visible: Anchor[] = [];
        for (const d of nodeDates) {
          // Duration items render as bars in their own layer below — skip
          // them here so they don't also appear as point chips.
          if (hasDuration(d)) continue;
          // Date-only chips live in the pinned ALL-DAY strip overlay — the
          // time-of-day Y axis has no meaningful position for them.
          if (!d.timeOfDay) continue;
          const leftPct = pct(d.ms);
          if (leftPct < -5 || leftPct > 105) continue;
          visible.push({
            ...d,
            leftPct,
            leftPx: (leftPct / 100) * railWidthPx,
            topPx: yForTimeOfDay(d.timeOfDay, bandH, workHoursMode),
          });
        }
        // Sort by x then y so the greedy clustering below is stable.
        visible.sort((a, b) => a.leftPx - b.leftPx || a.topPx - b.topPx);

        // Greedy pixel-proximity clustering. At readable zooms we keep
        // deadlines and scheduled chips in separate clusters (a deadline pin
        // shouldn't merge with a scheduled chip). At dot zoom that separation
        // guarantees two fully-coincident 16 px dots whenever a deadline and a
        // scheduled item share a spot — so there we merge everything and let
        // the badge's red border carry the "contains a deadline" signal.
        const clusters: Anchor[][] = [];
        const centers: { x: number; y: number; deadline: boolean }[] = [];
        for (const c of visible) {
          let placed = false;
          for (let i = 0; i < clusters.length; i++) {
            const bc = centers[i];
            if (tier !== "dot" && bc.deadline !== c.deadline) continue;
            if (
              Math.abs(bc.x - c.leftPx) <= CLUSTER_X_PX &&
              Math.abs(bc.y - c.topPx) <= CLUSTER_Y_PX
            ) {
              clusters[i].push(c);
              const n = clusters[i].length;
              bc.x = bc.x + (c.leftPx - bc.x) / n;
              bc.y = bc.y + (c.topPx - bc.y) / n;
              placed = true;
              break;
            }
          }
          if (!placed) {
            clusters.push([c]);
            centers.push({ x: c.leftPx, y: c.topPx, deadline: c.deadline });
          }
        }

        // Bucket key: sorted nodeIds + deadline flag. Stable across
        // re-renders so the open popover survives small data changes.
        const keyFor = (chips: Anchor[]) =>
          chips
            .map((c) => `${c.nodeId}:${c.deadline ? "d" : "s"}`)
            .sort()
            .join(",");

        // De-overlap: rather than collapse a small pile of chips into one stack
        // badge, SPREAD them into vertical lanes around the cluster centre so
        // each is individually visible and clickable. Only larger piles
        // collapse into the expandable stack indicator.
        const LANE_MAX = 4; // up to this many → lanes; more → stack badge
        const LANE_H = 19; // px between lanes
        const laneClusters: Anchor[][] = [];
        for (const chips of clusters) {
          // At dot zoom, spreading a pile into lanes just relocates unlabelled
          // dots on top of NEIGHBOURING clusters (the spread never re-checks
          // collisions) — a ×N badge is strictly more readable there.
          if (tier !== "dot" && chips.length >= 2 && chips.length <= LANE_MAX) {
            const sorted = [...chips].sort(
              (a, b) => a.topPx - b.topPx || (a.title < b.title ? -1 : 1),
            );
            const cy = sorted.reduce((s, c) => s + c.topPx, 0) / sorted.length;
            sorted.forEach((c, i) => {
              const offset = (i - (sorted.length - 1) / 2) * LANE_H;
              const ty = Math.max(8, Math.min(bandH - 8, cy + offset));
              laneClusters.push([{ ...c, topPx: ty }]);
            });
          } else {
            laneClusters.push(chips);
          }
        }

        const out: React.ReactNode[] = [];
        for (const chips of laneClusters) {
          const key = keyFor(chips);
          if (chips.length === 1) {
            // ── Singleton chip ────────────────────────────────────────────
            const d = chips[0];
            // Optimistic preview while the user is holding arrow keys:
            // shift the chip's apparent date+time by the pending delta so
            // the motion is immediate, even though the bridge call only
            // fires on keyup. The committed position (after the bridge
            // round-trip) overrides this on next render.
            const preview =
              pendingNudge != null &&
              pendingNudge.nodeId === d.nodeId &&
              pendingNudge.isDeadline === d.deadline
                ? pendingNudge
                : null;
            const isPreview = preview != null;
            let left = d.leftPct;
            let top = d.topPx;
            let dispTime = d.timeOfDay;
            if (preview) {
              // Absolute preview position — no re-derivation from the doc
              // base, so the chip doesn't bounce when the commit lands.
              left = pct(preview.ms);
              dispTime = preview.timeOfDay;
              top = yForTimeOfDay(preview.timeOfDay, bandH, workHoursMode);
            }
            const isOverdue = d.deadline && d.ms <= todayMs;
            const isSelected =
              timelineSelectedChip != null &&
              timelineSelectedChip.nodeId === d.nodeId &&
              timelineSelectedChip.isDeadline === d.deadline;
            // While previewing, use the optimistic time for the OOH check and
            // display so the chip's label keeps up with the cursor.
            const effectiveTime = isPreview ? dispTime : d.timeOfDay;
            const outOfWorkHours = workHoursMode && isOutsideWorkHours(effectiveTime);
            const showTitle = tier === "full";
            const showTime = tier !== "dot" && !!effectiveTime;
            // Trim title aggressively at narrow zooms.
            const titleLimit = chipWidthAvail >= 160 ? 32 : chipWidthAvail >= 104 ? 22 : 15;
            const truncated =
              d.title.length > titleLimit ? d.title.slice(0, titleLimit - 1) + "…" : d.title;
            out.push(
              <button
                key={`t${key}`}
                className={isOverdue ? "deadline-flash" : undefined}
                data-pin
                onPointerDown={(e) =>
                  onChipDown(e, {
                    nodeId: d.nodeId,
                    deadline: d.deadline,
                    title: d.title,
                    color: d.color,
                  })
                }
                title={`${d.deadline ? "⚑ Deadline" : "⏱ Scheduled"}: ${d.title}${
                  effectiveTime ? " @ " + effectiveTime : ""
                }${isPreview ? "\n(pending — release key to commit)" : ""}${
                  outOfWorkHours ? "\n(outside working hours — clamped to edge)" : ""
                }\nClick to select (arrow keys nudge), drag to reschedule freely`}
                style={{
                  position: "absolute",
                  left: `${left}%`,
                  top,
                  transform: "translate(0, -50%)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: tier === "dot" ? "center" : "flex-start",
                  gap: tier === "dot" ? 0 : 4,
                  padding: tier === "dot" ? "0" : "3px 7px",
                  width: tier === "dot" ? 16 : undefined,
                  height: tier === "dot" ? 16 : undefined,
                  borderRadius: tier === "dot" ? 999 : 6,
                  // Match the duration BAR's translucent fill + white text, so
                  // a point chip and the bar it turns into when resized look
                  // identical (no dark→white text flip). The shadow keeps the
                  // text legible on lighter tag colours.
                  background: chipBackground(d.tagsAll, tagColors, isSelected ? 0.62 : 0.52),
                  color: "var(--c-text)",
                  textShadow: "0 1px 2px rgba(0,0,0,0.7)",
                  border: isSelected
                    ? "2px solid #ffd166"
                    : "1px solid rgba(0,0,0,0.3)",
                  cursor: "grab",
                  fontSize: 10.5,
                  fontWeight: 700,
                  lineHeight: 1.1,
                  whiteSpace: "nowrap",
                  boxShadow: isSelected
                    ? `0 0 0 2px rgba(255,209,102,0.6), 0 2px 10px ${d.color}cc`
                    : d.deadline
                      ? `0 1px 6px ${d.color}aa`
                      : "0 1px 3px rgba(0,0,0,0.4)",
                  // Only "full" (which shows a clippable title) is width-capped;
                  // a "compact" chip sizes to its content so the HH:MM time is
                  // never half-clipped to "09:0".
                  maxWidth: tier === "full" ? chipWidthAvail : undefined,
                  overflow: "hidden",
                  userSelect: "none",
                  opacity: outOfWorkHours ? 0.6 : 1,
                }}
              >
                <span aria-hidden style={{ fontSize: 11, flexShrink: 0 }}>
                  {d.deadline ? "⚑" : "⏱"}
                </span>
                {/* Time FIRST (flexShrink:0) so it stays visible even when a
                    long title is clipped — important because arrow-key
                    nudging changes this value and the user needs to see it. */}
                {showTime && (
                  <span
                    style={{
                      opacity: 0.85,
                      fontVariantNumeric: "tabular-nums",
                      flexShrink: 0,
                      fontWeight: 700,
                      fontSize: tier === "compact" ? 10 : 10.5,
                    }}
                  >
                    {effectiveTime}
                    {outOfWorkHours && (
                      <span aria-hidden style={{ marginLeft: 2 }}>
                        {(() => {
                          const [h] = (effectiveTime as string)
                            .split(":")
                            .map((s) => parseInt(s, 10));
                          const minOfDay = (Number.isFinite(h) ? h : 0) * 60;
                          return minOfDay < WORK_START_MIN ? "↑" : "↓";
                        })()}
                      </span>
                    )}
                  </span>
                )}
                {showTitle && (
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", opacity: 0.92 }}>
                    {truncated}
                  </span>
                )}
              </button>,
            );
            // Selected chip → show its FULL (untruncated) title as a pill above
            // it, so even a long or clipped title is always readable.
            // Render the title pill for a selected chip at EVERY tier — including
            // dot zoom, where it's the only way to read the title on click (the
            // pill is pointerEvents:none, so it never blocks dragging).
            if (isSelected && d.title) {
              out.push(
                <div
                  key={`sellbl${key}`}
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: `${left}%`,
                    top: top - 15,
                    transform: "translate(0, -50%)",
                    fontSize: 10,
                    fontWeight: 700,
                    color: "var(--c-text)",
                    background: "var(--c-bg)",
                    border: "1px solid #ffd166",
                    padding: "1px 5px",
                    borderRadius: 4,
                    whiteSpace: "nowrap",
                    pointerEvents: "none",
                    maxWidth: 260,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    zIndex: 8,
                    boxShadow: "0 1px 4px rgba(0,0,0,0.45)",
                  }}
                >
                  {d.title}
                  {effectiveTime ? ` · ${effectiveTime}` : ""}
                </div>,
              );
            }
            // "Set duration" affordance: any timed, non-deadline point chip
            // gets a small handle below it; drag it down to give the task an
            // end time (turn the single point into a range). The handle is
            // always visible (subtle) so it is discoverable without first
            // selecting the chip, and brightens once the chip is selected.
            // Deadlines have no duration; dot-tier (zoomed right out) is too
            // coarse to set a meaningful end time, so it is excluded there.
            if (!d.deadline && !!d.timeOfDay && tier !== "dot") {
              if (stretch?.nodeId === d.nodeId) {
                const endY = yForTimeOfDay(hhmmOf(stretch.endMs), bandH, workHoursMode);
                out.push(
                  <div
                    key={`stretch${key}`}
                    aria-hidden
                    style={{
                      position: "absolute",
                      left: `${left}%`,
                      top: Math.min(top, endY),
                      width: Math.max(34, Math.min(120, pxPerDay - 6)),
                      height: Math.max(6, Math.abs(endY - top)),
                      background: chipBackground(d.tagsAll, tagColors, 0.4),
                      border: "1px dashed #ffd166",
                      borderRadius: 5,
                      pointerEvents: "none",
                      zIndex: 2,
                    }}
                  >
                    <span
                      style={{
                        position: "absolute",
                        bottom: 0,
                        left: 3,
                        fontSize: 9,
                        fontWeight: 700,
                        color: "#ffd166",
                        background: "var(--c-bg)",
                        padding: "0 3px",
                        borderRadius: 3,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {hhmmOf(stretch.endMs)}
                    </span>
                  </div>,
                );
              }
              out.push(
                <div
                  key={`grip${key}`}
                  data-pin
                  onPointerDown={(e) => onPointStretch(e, d)}
                  title="Drag down to set a duration (end time)"
                  style={{
                    position: "absolute",
                    left: `${left}%`,
                    top: top + 8,
                    width: isSelected ? 22 : 18,
                    height: isSelected ? 7 : 5,
                    background: isSelected ? "#ffd166" : "rgba(255,209,102,0.6)",
                    border: "1px solid rgba(0,0,0,0.35)",
                    borderRadius: 3,
                    cursor: "ns-resize",
                    zIndex: 7,
                    boxShadow: isSelected
                      ? "0 1px 3px rgba(0,0,0,0.5)"
                      : "0 1px 2px rgba(0,0,0,0.35)",
                    transition: "width 0.1s, height 0.1s, background 0.1s",
                    touchAction: "none",
                  }}
                />,
              );
            }
            // At dot zoom the chip is a bare indicator; its full title + time
            // live in the hover tooltip and the click-to-select pill — we no
            // longer float a label to the right, which spilled across
            // neighbouring day columns into an unreadable soup when zoomed out.
          } else {
            // ── Stack chip ────────────────────────────────────────────────
            // Click expands a popover listing each task. Position uses the
            // cluster centroid so a tight 3-chip cluster still pins on the
            // average spot rather than the first chip's exact dot.
            const railRect = railRef.current?.getBoundingClientRect();
            const cIdx = clusters.indexOf(chips);
            const centroidLeftPx = centers[cIdx].x;
            const centroidTopPx = centers[cIdx].y;
            const left = railRect ? (centroidLeftPx / railRect.width) * 100 : chips[0].leftPct;
            const top = centroidTopPx;
            const anyOverdue = chips.some((c) => c.deadline && c.ms <= todayMs);
            const allDeadlines = chips.every((c) => c.deadline);
            const isOpen = stackPopover?.key === key;
            // Use the first chip's time-of-day as the stack's display time
            // when chips actually share a time; otherwise show a span.
            const allSameTime =
              chips.every((c) => c.timeOfDay === chips[0].timeOfDay) && !!chips[0].timeOfDay;
            const stackOutOfWorkHours =
              workHoursMode && allSameTime && isOutsideWorkHours(chips[0].timeOfDay);
            const tagSet = new Set<string>();
            for (const c of chips) for (const t of c.tagsAll) tagSet.add(t);
            const aggTags = Array.from(tagSet);
            const showTime = tier !== "dot" && allSameTime;
            out.push(
              <button
                key={`stk${key}`}
                className={anyOverdue ? "deadline-flash" : undefined}
                data-pin
                data-stack-chip
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (isOpen) setStackPopover(null);
                  else setStackPopover({ key, x: e.clientX, y: e.clientY });
                }}
                title={`${chips.length} tasks ${
                  allDeadlines
                    ? "due"
                    : chips.some((c) => c.deadline)
                      ? "due / scheduled"
                      : "scheduled"
                } near this point${
                  allSameTime ? " @ " + chips[0].timeOfDay : ""
                } — click to expand\n${chips
                  .slice(0, 6)
                  .map(
                    (c) =>
                      `${c.deadline ? "⚑" : "⏱"}${c.timeOfDay ? " " + c.timeOfDay : ""} ${c.title}`,
                  )
                  .join("\n")}${chips.length > 6 ? `\n…and ${chips.length - 6} more` : ""}`}
                style={{
                  position: "absolute",
                  left: `${left}%`,
                  top,
                  transform: "translate(0, -50%)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: tier === "dot" ? 0 : 4,
                  padding: tier === "dot" ? "0" : "3px 8px",
                  width: tier === "dot" ? 20 : undefined,
                  height: tier === "dot" ? 20 : undefined,
                  borderRadius: 999,
                  background: chipBackground(aggTags, tagColors, 0.85),
                  color: "#1c1c1e",
                  // Red ring = the pile contains at least one deadline (matters
                  // at dot zoom, where mixed clusters merge into one badge).
                  border: isOpen
                    ? "2px solid #ffd166"
                    : chips.some((c) => c.deadline)
                      ? "1.5px solid rgba(255,108,107,0.9)"
                      : "1px solid rgba(0,0,0,0.4)",
                  cursor: "pointer",
                  fontSize: tier === "dot" ? 9.5 : 10.5,
                  fontWeight: 800,
                  lineHeight: 1.1,
                  whiteSpace: "nowrap",
                  boxShadow: isOpen
                    ? "0 0 0 2px rgba(255,209,102,0.55), 0 2px 10px rgba(0,0,0,0.45)"
                    : "0 1px 6px rgba(0,0,0,0.5)",
                  maxWidth: chipWidthAvail,
                  overflow: "hidden",
                  userSelect: "none",
                  opacity: stackOutOfWorkHours ? 0.6 : 1,
                }}
              >
                {tier !== "dot" && (
                  <span aria-hidden style={{ fontSize: 11, flexShrink: 0 }}>
                    {allDeadlines ? "⚑" : "📚"}
                  </span>
                )}
                <span style={{ fontVariantNumeric: "tabular-nums" }}>
                  {tier === "dot" ? chips.length : `×${chips.length}`}
                </span>
                {showTime && (
                  <span
                    style={{
                      opacity: 0.75,
                      fontVariantNumeric: "tabular-nums",
                      flexShrink: 0,
                    }}
                  >
                    {chips[0].timeOfDay}
                  </span>
                )}
              </button>,
            );
            // A dot-mode stack shows just its count; the member titles are one
            // click away in the popover (and on hover). We no longer float a
            // preview label beside it — at zoomed-out widths it overflowed
            // across neighbouring columns and collided with other labels.
          }
        }
        return out;
      })()}

      {stackPopover && (() => {
        // Decompose the stored key (sorted "nodeId:s|d" comma list) back into
        // its members and gather the live chip data so the popover stays in
        // sync with the underlying doc. If a member is no longer scheduled
        // (e.g. the user nudged it away from the cluster) the popover just
        // closes — the count would have changed under us anyway.
        const memberSet = new Set(stackPopover.key.split(","));
        const expanded: typeof nodeDates = [];
        for (const d of nodeDates) {
          const m = `${d.nodeId}:${d.deadline ? "d" : "s"}`;
          if (memberSet.has(m)) expanded.push(d);
        }
        if (expanded.length === 0) return null;
        const WIDTH = 260;
        const HEIGHT_GUESS = Math.min(40 + expanded.length * 28, 360);
        const left = Math.min(Math.max(stackPopover.x - WIDTH / 2, 8), window.innerWidth - WIDTH - 8);
        const top = Math.min(stackPopover.y + 14, window.innerHeight - HEIGHT_GUESS - 8);
        return (
          <div
            id="org-stack-popover"
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              position: "fixed",
              left,
              top,
              width: WIDTH,
              maxHeight: 360,
              overflowY: "auto",
              zIndex: 10001,
              background: "var(--c-surface)",
              border: "1px solid var(--c-border)",
              borderRadius: 8,
              boxShadow: "0 8px 28px rgba(0,0,0,0.55)",
              padding: 4,
            }}
          >
            <div style={{ padding: "4px 8px 6px 8px", fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: "var(--c-text-dim)", borderBottom: "1px solid var(--c-border)" }}>
              {(() => {
                const allDead = expanded.every((d) => d.deadline);
                const anyDead = expanded.some((d) => d.deadline);
                const kind = allDead
                  ? "⚑ Deadline"
                  : anyDead
                    ? "⚑ Deadlines + ⏱ Scheduled"
                    : "⏱ Scheduled";
                const times = Array.from(
                  new Set(expanded.map((d) => d.timeOfDay).filter(Boolean) as string[]),
                ).sort();
                const timeLabel =
                  times.length === 0
                    ? ""
                    : times.length === 1
                      ? ` @ ${times[0]}`
                      : ` @ ${times[0]} – ${times[times.length - 1]}`;
                return `${expanded.length} task${expanded.length === 1 ? "" : "s"} · ${kind}${timeLabel}`;
              })()}
            </div>
            {expanded.map((d, idx) => (
              <button
                key={`${stackPopover.key}-${idx}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setTimelineSelectedChip({ nodeId: d.nodeId, isDeadline: d.deadline });
                  if (selectedSpanId) setSelectedSpanId(null);
                  window.dispatchEvent(new CustomEvent("orggui:focusNode", { detail: { id: d.nodeId } }));
                  setStackPopover(null);
                }}
                title={`Focus ${d.title} in the graph`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  textAlign: "left",
                  background: "transparent",
                  border: "none",
                  padding: "5px 8px",
                  borderRadius: 4,
                  fontSize: 12,
                  color: "var(--c-text)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--c-surface2)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <span
                  aria-hidden
                  style={{
                    width: 4,
                    height: 18,
                    borderRadius: 2,
                    background: chipBackground(d.tagsAll, tagColors, 1),
                    flexShrink: 0,
                  }}
                />
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {d.title}
                </span>
                {d.timeOfDay && (
                  <span style={{ fontSize: 10.5, color: "var(--c-text-dim)", fontVariantNumeric: "tabular-nums" }}>
                    {d.timeOfDay}
                  </span>
                )}
              </button>
            ))}
          </div>
        );
      })()}

      {/* Live drag preview: ghost chip pinned at the cursor showing the
          date+time that will be committed on pointerup. */}
      {chipGhost && (
        <div
          style={{
            position: "fixed",
            left: chipGhost.x,
            top: chipGhost.y,
            transform: "translate(-50%, -50%)",
            pointerEvents: "none",
            zIndex: 10002,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 2,
          }}
        >
          <div
            style={{
              padding: "3px 8px",
              borderRadius: 6,
              background: chipGhost.color,
              color: "#1c1c1e",
              fontSize: 10.5,
              fontWeight: 700,
              boxShadow: "0 4px 14px rgba(0,0,0,0.5)",
              opacity: 0.85,
            }}
          >
            {chipGhost.deadline ? "⚑" : "⏱"} {chipGhost.title.slice(0, 20)} {chipGhost.time}
          </div>
          <div style={{ fontSize: 9.5, color: "var(--c-text-dim)", fontFamily: "ui-monospace, monospace" }}>
            {chipGhost.iso}
          </div>
        </div>
      )}

      {/* TODAY marker — vertical line at the current wall-clock instant.
          The line advances through the day on a 1 s tick (subtle but
          real: a few px/min at 1W zoom). Z-index 0 keeps it BEHIND task
          chips so the marker doesn't visually punch through indicators.
          (The HH:MM:SS label lives in the pinned overlay below the rail,
          so it stays visible at any vertical scroll.) */}
      {nowMs >= startMs && nowMs <= endMs && (
        <div
          style={{
            position: "absolute",
            left: `${pct(nowMs)}%`,
            top: 24,
            bottom: 18,
            width: 2,
            marginLeft: -1,
            background: "#e0a458",
            zIndex: 0,
            pointerEvents: "none",
          }}
        />
      )}

        </div>
      </div>

      {/* ── PINNED OVERLAY: milestone pins + TODAY label ─────────────────────
          These live OUTSIDE the vertically-scrollable rail so they stay put
          while the time zone scrolls (the default scroll starts at ~08:00,
          which would otherwise hide every flag above the fold). Container is
          pointer-transparent; the flags re-enable pointer events themselves.
          Pin drags are x-only (dateAtClientX), so leaving the scroll content
          changes nothing about their interactions. */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 8 }}>
      {nowMs >= startMs && nowMs <= endMs && (() => {
        const nowDate = new Date(nowMs);
        const hh = String(nowDate.getHours()).padStart(2, "0");
        const mm = String(nowDate.getMinutes()).padStart(2, "0");
        const ss = String(nowDate.getSeconds()).padStart(2, "0");
        return (
          <div
            style={{
              position: "absolute",
              left: `${pct(nowMs)}%`,
              top: 28 + stripLayout.stripH,
              transform: "translateX(4px)",
              fontSize: 9,
              color: "#e0a458",
              fontWeight: 700,
              fontFamily: "ui-monospace, monospace",
              fontVariantNumeric: "tabular-nums",
              pointerEvents: "none",
              whiteSpace: "nowrap",
            }}
          >
            TODAY {hh}:{mm}:{ss}
          </div>
        );
      })()}
      {/* Milestone pins — greedy lane assignment so close-by dates stagger
          vertically instead of overlapping their labels. Click ⚑ to recolour,
          drag the pin to move, double-click to rename, ✕ to remove. */}
      {(() => {
        const railWidth = railRef.current?.getBoundingClientRect().width ?? 800;
        // Clear the pinned all-day strip overlay so flags aren't hidden
        // underneath it when the band is scrolled to the top.
        const PIN_BASE_TOP = 44 + stripLayout.stripH;
        const PIN_LANE_H = 26;
        const MAX_PIN_LANES = 5;
        // Per-pin flag width estimate: enough room for the flag icon (~16),
        // padding (~10), close ✕ (~12), and a label sized to its actual
        // string length capped at 160 px. Short labels pack tighter; long
        // labels get a real reservation. Date label below ("1 Jun" etc.)
        // is ~46 px wide centered on the pin → ±23 px around the x, smaller
        // than the flag's bounding box, so it doesn't dominate the layout.
        const flagWidthPx = (label: string) => {
          const approx = 38 + Math.min(160, label.length * 6.5);
          return Math.max(70, approx);
        };

        type Placed = {
          m: typeof milestones[number];
          d: Date;
          leftPct: number;
          lane: number;
          overflow: boolean;
        };
        const candidates = milestones
          .map((m) => {
            const d = parseOrgDate(m.iso);
            if (!d) return null;
            const leftPct = pct(startOfDay(d).getTime());
            return { m, d, leftPct };
          })
          .filter((x): x is { m: typeof milestones[number]; d: Date; leftPct: number } =>
            x !== null && x.leftPct > -5 && x.leftPct < 105,
          )
          .sort((a, b) => a.leftPct - b.leftPct);

        const laneEnds: number[] = [];
        const placed: Placed[] = candidates.map((c) => {
          const xPx = (c.leftPct / 100) * railWidth;
          const w = flagWidthPx(c.m.label || "(unnamed)");
          let lane = 0;
          while (lane < laneEnds.length && xPx < laneEnds[lane] + 8) lane++;
          // Overflow: when more pins crowd in than we have lanes for, the
          // last lane keeps stacking. Track this so we can hide that pin's
          // date label below (otherwise it'd collide horizontally with the
          // pin already occupying that x-slot in the same lane).
          const overflow = lane >= MAX_PIN_LANES;
          if (overflow) lane = MAX_PIN_LANES - 1;
          laneEnds[lane] = xPx + w;
          return { ...c, lane, overflow };
        });

        return placed.map(({ m, d, leftPct, lane, overflow }) => {
          const isEditing = editing === m.id;
          const color = m.color || MILESTONE_COLOR;
          const topPx = PIN_BASE_TOP + lane * PIN_LANE_H;
          return (
            <div key={m.id} data-pin style={{ position: "absolute", left: `${leftPct}%`, top: topPx, bottom: 18, width: 0, pointerEvents: "none" }}>
              {/* stem reaches from below the date label down to the month axis
                  regardless of which lane the flag occupies */}
              <div style={{ position: "absolute", top: 32, bottom: 0, left: 0, width: 2, marginLeft: -1, background: color, opacity: 0.8 }} />
              <div
                onPointerDown={(e) => onPinDown(e, m.id)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  beginEdit(m.id, m.label);
                }}
                title={`${m.label || "(unnamed)"} · ${m.iso} — drag to move, double-click to rename, click ⚑ to recolour`}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  pointerEvents: "auto",
                  transform: "translateX(-50%)",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "1px 5px",
                  background: color,
                  color: "#1c1c1e",
                  borderRadius: 4,
                  fontSize: 10.5,
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                  cursor: dragId.current === m.id ? "grabbing" : "grab",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
                }}
              >
                {/* Label-input pattern: clicking the flag triggers the OS-native
                    color picker via the hidden &lt;input type="color"&gt;. This is
                    more reliable in WKWebView (macOS Tauri) than a programmatic
                    .click() on a dynamically-created input. */}
                <label
                  onPointerDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  title="Click to change this milestone's colour"
                  style={{
                    position: "relative",
                    display: "inline-flex",
                    alignItems: "center",
                    cursor: "pointer",
                    lineHeight: 1,
                  }}
                >
                  ⚑
                  <input
                    type="color"
                    value={color}
                    onChange={(e) => updateMilestone(m.id, { color: e.target.value })}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    style={{
                      position: "absolute",
                      inset: 0,
                      width: "100%",
                      height: "100%",
                      opacity: 0,
                      cursor: "pointer",
                      border: "none",
                      padding: 0,
                      margin: 0,
                      background: "transparent",
                    }}
                  />
                </label>
                {isEditing ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onPointerDown={(e) => e.stopPropagation()}
                    onBlur={() => commitEdit(m.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit(m.id);
                      if (e.key === "Escape") {
                        if (!m.label) removeMilestone(m.id);
                        setEditing(null);
                      }
                    }}
                    placeholder="name…"
                    style={{ width: 90, border: "none", outline: "none", background: "rgba(0,0,0,0.15)", color: "#1c1c1e", borderRadius: 2, font: "inherit", padding: "0 2px" }}
                  />
                ) : (
                  // Overflow pins (more pins than lanes) share their lane with
                  // another flag at the same x — showing the label there means
                  // two labels printed on top of each other. Collapse to a bare
                  // ⚑ flag; the label stays in the tooltip.
                  !overflow && (
                    <span style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}>{m.label || "(unnamed)"}</span>
                  )
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeMilestone(m.id);
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  title="Remove milestone"
                  style={{ border: "none", background: "transparent", color: "#1c1c1e", cursor: "pointer", fontSize: 10, padding: 0, lineHeight: 1, opacity: 0.7 }}
                >
                  ✕
                </button>
              </div>
              {/* Small "1 Jun" date label under the flag. Hidden when this
                  pin overflowed its lane — at that density the date text
                  would horizontally collide with the pin sharing its slot,
                  which is exactly the "1 Jun overlapping into another
                  deadline" case the user reported. The flag itself stays
                  visible; the date is recoverable from the tooltip. */}
              {!overflow && (
                <div style={{ position: "absolute", top: 18, left: 0, transform: "translateX(-50%)", fontSize: 8.5, color: color, whiteSpace: "nowrap" }}>
                  {d.getDate()} {MONTHS[d.getMonth()]}
                </div>
              )}
            </div>
          );
        });
      })()}

      {milestones.length === 0 && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            top: 24,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--c-text-dim)",
            fontSize: 11.5,
            pointerEvents: "none",
            opacity: 0.55,
          }}
        >
          Double-click to drop a milestone · double-click a tick to focus that node
        </div>
      )}
      </div>

      {/* ── ALL-DAY STRIP (overlay) ──────────────────────────────────────────
          Pinned under the toolbar, OVER the scrollable rail, so date-only
          entries are always visible no matter where the time zone is scrolled.
          Empty areas are pointer-transparent — panning / double-click-to-add
          on the rail still work through the strip. */}
      {stripLayout.stripH > 0 && (
        <div
          style={{
            position: "absolute",
            top: 26,
            left: 0,
            right: 0,
            height: stripLayout.stripH,
            zIndex: 9,
            pointerEvents: "none",
          }}
        >
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              background: "var(--c-surface)",
              opacity: 0.92,
              borderBottom: "1px solid var(--c-border)",
              boxShadow: "0 2px 6px rgba(0,0,0,0.25)",
            }}
          />
          <span
            aria-hidden
            style={{
              position: "absolute",
              left: 4,
              top: 5,
              fontSize: 8.5,
              fontWeight: 700,
              letterSpacing: 0.4,
              textTransform: "uppercase",
              color: "var(--c-text-dim)",
              opacity: 0.55,
              pointerEvents: "none",
            }}
          >
            all-day
          </span>
          {/* Single-date pills / ×N badges (never overlap — merged upstream) */}
          {stripLayout.groups.map((g) => {
            if (g.items.length === 1) {
              const { d, xPx, wPx } = g.items[0];
              const isDeadline = d.deadline;
              const isOverdue = isDeadline && d.ms <= todayMs;
              const isSelected =
                timelineSelectedChip != null &&
                timelineSelectedChip.nodeId === d.nodeId &&
                timelineSelectedChip.isDeadline === d.deadline;
              // Optimistic arrow-key nudge preview (date-only: ← → moves the
              // date; ↑ ↓ is a no-op for all-day entries).
              const nudge =
                pendingNudge != null &&
                pendingNudge.nodeId === d.nodeId &&
                pendingNudge.isDeadline === d.deadline
                  ? pendingNudge
                  : null;
              const xEff = nudge ? ((nudge.ms - startMs) / span) * (railWidth || 800) : xPx;
              return (
                <button
                  key={`strip-${d.nodeId}-${isDeadline ? "d" : "s"}`}
                  className={isOverdue ? "deadline-flash" : undefined}
                  data-pin
                  onPointerDown={(e) =>
                    onChipDown(e, {
                      nodeId: d.nodeId,
                      deadline: d.deadline,
                      title: d.title,
                      color: d.color,
                      allDay: true,
                    })
                  }
                  title={`${isDeadline ? "⚑ Deadline" : "⏱ Scheduled"} (all-day): ${d.title}\nClick to select (← → nudge the date), drag to reschedule`}
                  style={{
                    position: "absolute",
                    left: xEff,
                    top: 4,
                    height: 17,
                    maxWidth: wPx,
                    display: "flex",
                    alignItems: "center",
                    gap: 3,
                    padding: "0 5px",
                    borderRadius: 5,
                    background: chipBackground(d.tagsAll, tagColors, isSelected ? 0.62 : 0.5),
                    color: "var(--c-text)",
                    textShadow: "0 1px 2px rgba(0,0,0,0.7)",
                    border: isSelected
                      ? "2px solid #ffd166"
                      : isDeadline
                        ? "1px solid rgba(255,108,107,0.85)"
                        : "1px solid rgba(0,0,0,0.3)",
                    fontSize: 9.5,
                    fontWeight: 700,
                    lineHeight: 1,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    cursor: "grab",
                    userSelect: "none",
                    pointerEvents: "auto",
                  }}
                >
                  <span aria-hidden style={{ fontSize: 9, flexShrink: 0 }}>
                    {isDeadline ? "⚑" : "▪"}
                  </span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{d.title}</span>
                </button>
              );
            }
            // ×N badge → opens the same stack popover the time zone uses.
            const key = g.items
              .map((s) => `${s.d.nodeId}:${s.d.deadline ? "d" : "s"}`)
              .sort()
              .join(",");
            const anyDeadline = g.items.some((s) => s.d.deadline);
            const anyOverdue = g.items.some((s) => s.d.deadline && s.d.ms <= todayMs);
            const isOpen = stackPopover?.key === key;
            return (
              <button
                key={`stripstk-${key}`}
                className={anyOverdue ? "deadline-flash" : undefined}
                data-pin
                data-stack-chip
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (isOpen) setStackPopover(null);
                  else setStackPopover({ key, x: e.clientX, y: e.clientY });
                }}
                title={`${g.items.length} all-day ${
                  anyDeadline ? "items (incl. deadlines)" : "items"
                } — click to expand\n${g.items
                  .slice(0, 6)
                  .map((s) => `${s.d.deadline ? "⚑" : "▪"} ${s.d.title}`)
                  .join("\n")}${g.items.length > 6 ? `\n…and ${g.items.length - 6} more` : ""}`}
                style={{
                  position: "absolute",
                  left: g.xPx,
                  top: 4,
                  height: 17,
                  display: "flex",
                  alignItems: "center",
                  gap: 3,
                  padding: "0 6px",
                  borderRadius: 999,
                  background: "var(--c-surface2, rgba(120,124,136,0.9))",
                  color: "var(--c-text)",
                  border: isOpen
                    ? "2px solid #ffd166"
                    : anyDeadline
                      ? "1.5px solid rgba(255,108,107,0.9)"
                      : "1px solid rgba(0,0,0,0.4)",
                  fontSize: 9.5,
                  fontWeight: 800,
                  lineHeight: 1,
                  whiteSpace: "nowrap",
                  cursor: "pointer",
                  userSelect: "none",
                  pointerEvents: "auto",
                }}
              >
                <span aria-hidden style={{ fontSize: 9, flexShrink: 0 }}>
                  {anyDeadline ? "⚑" : "▪"}
                </span>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>×{g.items.length}</span>
              </button>
            );
          })}
          {/* Multi-day all-day span bars, lane-packed */}
          {stripLayout.spans.map(({ d, xPx, wPx, lane }) => {
            const isSelected = selectedSpanId === d.nodeId;
            const firstTagColor = d.tagsAll.map((t) => tagColors[t]).find(Boolean);
            const top = 4 + (stripLayout.hasSingles ? 20 : 0) + lane * 16;
            return (
              <button
                key={`stripspan-${d.nodeId}`}
                data-pin
                onPointerDown={(e) => onBarDown(e, d)}
                title={`${d.title}\n${d.iso} (all-day span — drag to move; resize on the block below)`}
                style={{
                  position: "absolute",
                  left: xPx,
                  top,
                  width: wPx,
                  height: 13,
                  display: "flex",
                  alignItems: "center",
                  gap: 3,
                  padding: "0 5px",
                  borderRadius: 4,
                  background: chipBackground(d.tagsAll, tagColors, isSelected ? 0.6 : 0.45),
                  color: "var(--c-text)",
                  textShadow: "0 1px 2px rgba(0,0,0,0.7)",
                  border: isSelected
                    ? "2px solid #ffd166"
                    : `1px solid ${hexToRgba(firstTagColor ?? d.color, 0.85)}`,
                  fontSize: 9,
                  fontWeight: 700,
                  lineHeight: 1,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  cursor: "grab",
                  userSelect: "none",
                  pointerEvents: "auto",
                }}
              >
                {wPx >= 56 && (
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{d.title}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
