import { useEffect, useMemo, useRef, useState } from "react";
import { useOrgStore, type ZoomLevel } from "../store/useOrgStore";
import { parseOrgDate, startOfDay } from "../utils/time";

// A horizontal calendar band across the top of the canvas. Shows zoom-level
// controls (1W / 2W / 1M / 3M / 6M / 1Y / Fit), a month axis with adaptive day
// labels at narrow zooms, a "today" marker, task-date ticks (double-click a
// tick to focus that node in the graph), and user-placed milestone pins
// (double-click empty band to add; drag to move; double-click flag to rename;
// ✕ to remove). Drag the band itself to pan through time at any non-Fit zoom.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
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

/** Default Fit window — wraps all relevant dates with ~1 month padding. */
function autoFitRange(dates: number[]): [number, number] {
  const today = startOfDay(new Date()).getTime();
  const all = dates.length ? [...dates, today] : [today];
  const min = new Date(Math.min(...all));
  const max = new Date(Math.max(...all));
  const start = new Date(min.getFullYear(), min.getMonth() - 1, 1).getTime();
  let end = new Date(max.getFullYear(), max.getMonth() + 2, 1).getTime();
  if (end - start < 60 * MS_DAY) end = start + 90 * MS_DAY;
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
  const timelineSelectedChip = useOrgStore((s) => s.timelineSelectedChip);
  const setTimelineSelectedChip = useOrgStore((s) => s.setTimelineSelectedChip);
  const tagColors = useOrgStore((s) => s.tagColors);
  const scheduleMode = useOrgStore((s) => s.scheduleMode);
  const setScheduleMode = useOrgStore((s) => s.setScheduleMode);
  const scheduleDragNodeId = useOrgStore((s) => s.scheduleDragNodeId);
  const setScheduleDragNode = useOrgStore((s) => s.setScheduleDragNode);

  const railRef = useRef<HTMLDivElement>(null);
  const dragId = useRef<string | null>(null);
  const panRef = useRef<{ startX: number; startCenterMs: number } | null>(null);
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
      // only the start of a `--` range. Single-point timestamps are skipped
      // so date-only notes don't flood the band.
      const tsEnd = parseOrgDate(n.timestampEnd);
      const ts = parseOrgDate(n.timestamp);
      if (ts && tsEnd) {
        out.push({
          ms: startOfDay(ts).getTime(),
          deadline: false,
          nodeId: n.id,
          title: n.title ?? "(untitled)",
          color: "#5fb3a1",
          tagsAll: tags,
          timeOfDay: timeOfDayFromIso(n.timestamp),
          iso: n.timestamp ?? "",
          msEnd: startOfDay(tsEnd).getTime(),
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
      const time = timeAtRailY(y - r.top, r.height, workHoursMode);
      setChipGhost({
        nodeId,
        deadline: false,
        title: node?.title ?? "(untitled)",
        color: "#a3be8c",
        x,
        y,
        iso: `${isoOf(dt)} ${time}`,
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
      const time = timeAtRailY(y - r.top, r.height, workHoursMode);
      Promise.resolve(scheduleNode(node, `${isoOf(dt)} ${time}`, "scheduled")).catch(() => {});
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
    timeOfDay: string; // "HH:MM"
    iso: string; // "YYYY-MM-DD HH:MM" handed to scheduleNode
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
        scheduleNode(node, committedIso, cur.isDeadline ? "deadline" : "scheduled"),
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
        // this chip, else the chip's committed value in the doc.
        let baseMs: number;
        let baseTime: string;
        if (cur && cur.nodeId === sel.nodeId && cur.isDeadline === sel.isDeadline) {
          baseMs = cur.ms;
          baseTime = cur.timeOfDay;
        } else {
          const node = doc?.nodes.find((n) => n.id === sel.nodeId);
          const isoNow = node ? (sel.isDeadline ? node.deadline : node.scheduled) : null;
          const parsed = parseOrgDate(isoNow);
          if (!parsed) return cur; // nothing to nudge from
          baseMs = startOfDay(parsed).getTime();
          baseTime = timeOfDayFromIso(isoNow) ?? "12:00";
        }
        const [hh, mm] = baseTime.split(":").map((s) => parseInt(s, 10));
        const baseMin = (Number.isFinite(hh) ? hh : 12) * 60 + (Number.isFinite(mm) ? mm : 0);
        const nd = new Date(baseMs);
        nd.setHours(0, 0, 0, 0);
        nd.setDate(nd.getDate() + ddate);
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
      Promise.resolve(setNodeSpan(node, sStr, eStr))
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
    info: { nodeId: string; deadline: boolean; title: string; color: string },
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
      const time = timeAtRailY(ev.clientY - r.top, r.height, workHoursMode);
      setChipGhost({
        ...info,
        x: ev.clientX,
        y: ev.clientY,
        iso: `${isoOf(dt)} ${time}`,
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
      const time = timeAtRailY(ev.clientY - r.top, r.height, workHoursMode);
      const dateStr = `${isoOf(dt)} ${time}`;
      scheduleNode(node, dateStr, info.deadline ? "deadline" : "scheduled");
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
      const ntimeStr = timeAtRailY(ev.clientY - r.top, r.height, workHoursMode);
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
      const ntimeStr = timeAtRailY(ev.clientY - r.top, r.height, workHoursMode);
      const newStartMs = startOfDay(ndate).getTime() + minOfTime(ntimeStr) * 60000;
      const delta = newStartMs - oldStart;
      const newEndMs = oldEnd + delta;
      const sStr = fmtSpanStr(newStartMs, hasStartTime);
      const eStr = fmtSpanStr(newEndMs, hasEndTime || hasStartTime);
      setSelectedSpanId(d.nodeId);
      if (timelineSelectedChip) setTimelineSelectedChip(null);
      // Keep the absolute preview applied across the bridge round-trip so the
      // bar doesn't bounce, then clear once the commit settles.
      Promise.resolve(setNodeSpan(node, sStr, eStr))
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
          const mins = minOfTime(timeAtRailY(ev.clientY - r.top, r.height, workHoursMode));
          curStart = Math.min(dayOf(curStart) + mins * 60000, curEnd - MIN_GAP);
          break;
        }
        case "endTime": {
          const mins = minOfTime(timeAtRailY(ev.clientY - r.top, r.height, workHoursMode));
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
      Promise.resolve(setNodeSpan(node, sStr, eStr))
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
    const r = railRef.current?.getBoundingClientRect();
    if (!r) return 0;
    return (r.width / span) * MS_DAY;
  }, [span]);

  // Adaptive day-tick density: only draw day labels when there's room.
  // Day gridlines visibility — driven by the 📆 toggle in the header, not
  // by zoom-level heuristics. Labels still gate on having enough width to
  // avoid overlapping each other.
  const showDayLabels = showDayTicks && pxPerDay >= 26;
  const months = monthStarts(startMs, endMs);
  const days = showDayTicks ? dayStarts(startMs, endMs) : [];

  return (
    <div
      ref={railRef}
      onPointerDown={onPanStart}
      onDoubleClick={onBandDoubleClick}
      // HTML5 drag-and-drop drop target for the Schedule mode. Accepting
      // dragover (with preventDefault) is required for drop to fire. The
      // dataTransfer payload is set by OrgNode in its onDragStart handler
      // when scheduleMode is on.
      onDragOver={(e) => {
        if (!scheduleMode) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDrop={(e) => {
        if (!scheduleMode) return;
        e.preventDefault();
        const nodeId =
          e.dataTransfer.getData("application/orggui-node-id") ||
          scheduleDragNodeId ||
          "";
        if (!nodeId) return;
        const node = doc?.nodes.find((n) => n.id === nodeId);
        if (!node) return;
        const r = railRef.current?.getBoundingClientRect();
        if (!r) return;
        const dt = dateAtClientX(e.clientX);
        const time = timeAtRailY(e.clientY - r.top, r.height, workHoursMode);
        const dateStr = `${isoOf(dt)} ${time}`;
        Promise.resolve(scheduleNode(node, dateStr, "scheduled")).catch(() => {});
        setScheduleDragNode(null);
        setScheduleMode(false);
      }}
      title={
        scheduleMode
          ? "Drop a graph node here to schedule it at the X = date, Y = time of the drop point"
          : timelineView.zoom === "fit"
            ? "Double-click to add a milestone · use the zoom buttons to focus a date range"
            : "Drag to pan · double-click empty band to add a milestone · double-click a tick to focus that node"
      }
      style={{
        position: "relative",
        height: "100%",
        background: "var(--c-surface)",
        borderBottom: "1px solid var(--c-border)",
        overflow: "hidden",
        userSelect: "none",
        cursor: scheduleMode
          ? "copy"
          : timelineView.zoom === "fit"
            ? "default"
            : panRef.current
              ? "grabbing"
              : "grab",
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
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: "var(--c-text-dim)" }}>
          Deadlines &amp; Milestones
        </span>
        <div style={{ display: "flex", gap: 2, pointerEvents: "auto" }}>
          {ZOOMS.map((z) => (
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
                border: "1px solid var(--c-border)",
                borderRadius: 4,
                padding: "1px 7px",
                fontSize: 10.5,
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {z.label}
            </button>
          ))}
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
              borderRadius: 4,
              padding: "1px 7px",
              fontSize: 10.5,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "inherit",
              marginLeft: 4,
            }}
          >
            📆 Days
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
              borderRadius: 4,
              padding: "1px 7px",
              fontSize: 10.5,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "inherit",
              marginLeft: 4,
            }}
          >
            💼 {workHoursMode ? "8–20" : "24h"}
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
              borderRadius: 4,
              padding: "1px 7px",
              fontSize: 10.5,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "inherit",
              marginLeft: 4,
            }}
          >
            📅 {scheduleMode ? "Drop on date" : "Schedule"}
          </button>
        </div>
      </div>

      {/* Month gridlines + labels */}
      {months.map((m) => {
        const left = pct(m.getTime());
        if (left < -2 || left > 102) return null;
        return (
          <div key={`m${m.getTime()}`}>
            <div style={{ position: "absolute", left: `${left}%`, top: 24, bottom: 18, width: 1, background: "var(--c-border)", opacity: 0.5 }} />
            <div style={{ position: "absolute", left: `${left}%`, bottom: 2, transform: "translateX(3px)", fontSize: 10, color: "var(--c-text-dim)", whiteSpace: "nowrap" }}>
              {MONTHS[m.getMonth()]}
              {m.getMonth() === 0 ? ` ${m.getFullYear()}` : ""}
            </div>
          </div>
        );
      })}

      {/* Day ticks at narrower zoom levels */}
      {days.map((d) => {
        const left = pct(d.getTime());
        if (left < -2 || left > 102) return null;
        const isMonday = d.getDay() === 1;
        // The gridline marks the boundary BETWEEN this day and the previous
        // one. The number label belongs centered in this day's cell — so its
        // x is the midpoint between this day's start and the next day's
        // start. That puts "5" in the middle of the day-5 column rather than
        // hugging the line separating day 4 from day 5.
        const nextLeft = pct(d.getTime() + MS_DAY);
        const labelLeft = (left + nextLeft) / 2;
        return (
          <div key={`d${d.getTime()}`}>
            <div
              style={{
                position: "absolute",
                left: `${left}%`,
                top: 24,
                bottom: 18,
                width: 1,
                background: isMonday ? "var(--c-border)" : "var(--c-border)",
                opacity: isMonday ? 0.45 : 0.18,
              }}
            />
            {showDayLabels && (
              <div
                style={{
                  position: "absolute",
                  left: `${labelLeft}%`,
                  bottom: 2,
                  transform: "translateX(-50%)",
                  fontSize: 9,
                  color: "var(--c-text-dim)",
                  whiteSpace: "nowrap",
                  opacity: isMonday ? 1 : 0.55,
                }}
              >
                {d.getDate()}
              </div>
            )}
          </div>
        );
      })}

      {/* Horizontal time gridlines spanning the chip-zone. In 24h mode we
          mark every 3 hours; in working-hours mode we mark every hour from
          08:00 to 20:00 so the denser visible window stays readable. */}
      {(() => {
        const bandH = railRef.current?.getBoundingClientRect().height ?? 200;
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
        const bandH = railRef.current?.getBoundingClientRect().height ?? 200;
        const out: React.ReactNode[] = [];
        for (let i = 0; i < nodeDates.length; i++) {
          const d = nodeDates[i];
          if (!hasDuration(d)) continue;

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
            const accent = isSelected ? "rgba(255,209,102,0.95)" : "rgba(255,255,255,0.3)";
            const horizontal = side === "left" || side === "right";
            const style: React.CSSProperties = {
              position: "absolute",
              background: accent,
              borderRadius: 4,
              touchAction: "none",
              cursor: horizontal ? "ew-resize" : "ns-resize",
              ...(horizontal
                ? {
                    top: 1,
                    bottom: 1,
                    width: 7,
                    left: side === "left" ? 0 : undefined,
                    right: side === "right" ? 0 : undefined,
                  }
                : {
                    left: 1,
                    right: 1,
                    height: 5,
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
                    transform: "translateX(-50%)",
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
                  {isFirst && (
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
                  {isLast && (
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
            out.push(<div key={`dur${i}`}>{segs}</div>);
          } else if (multiDay) {
            // All-day (or partially-timed) multi-day span → horizontal bar
            // across day columns, anchored at the start row (mid-band if
            // undated). Edges resize the start/end DATE.
            const top = yForTimeOfDay(effStartTime, bandH, workHoursMode);
            const leftClamped = Math.max(0, left);
            const rightClamped = Math.min(100, right);
            const widthPct = Math.max(0.5, rightClamped - leftClamped);
            out.push(
              <button
                key={`dur${i}`}
                data-pin
                onPointerDown={(e) => onBarDown(e, d)}
                title={`${d.title}\n${d.iso}${d.timeOfDayEnd ? " → " + d.timeOfDayEnd : ""} (duration — drag to move, edges to resize)`}
                style={{
                  position: "absolute",
                  left: `${leftClamped}%`,
                  top: top - 9,
                  width: `${widthPct}%`,
                  height: 18,
                  borderRadius: 5,
                  background: bg,
                  border: isSelected ? "2px solid #ffd166" : `1px solid ${border}`,
                  color: "var(--c-text)",
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "0 9px",
                  fontSize: 10.5,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  cursor: "grab",
                  boxShadow: isSelected ? "0 0 0 2px rgba(255,209,102,0.5)" : "none",
                }}
              >
                <span aria-hidden style={{ flexShrink: 0, opacity: 0.8 }}>↔</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{truncated}</span>
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
            const w = Math.max(34, Math.min(160, pxPerDay - 6));
            out.push(
              <button
                key={`dur${i}`}
                data-pin
                onPointerDown={(e) => onBarDown(e, d)}
                title={`${d.title}\n${rangeLabel} (duration — drag to move, edges to resize)`}
                style={{
                  position: "absolute",
                  left: `${left}%`,
                  top,
                  height,
                  width: w,
                  transform: "translateX(-50%)",
                  borderRadius: 5,
                  background: bg,
                  border: isSelected ? "2px solid #ffd166" : `1px solid ${border}`,
                  color: "var(--c-text)",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  justifyContent: "center",
                  gap: 1,
                  padding: "4px 6px",
                  fontSize: 10,
                  fontWeight: 600,
                  overflow: "hidden",
                  cursor: "grab",
                  textAlign: "left",
                  boxShadow: isSelected ? "0 0 0 2px rgba(255,209,102,0.5)" : "none",
                }}
              >
                <span style={{ width: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {truncated}
                </span>
                {rangeLabel && (
                  <span style={{ opacity: 0.7, fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>
                    {rangeLabel}
                  </span>
                )}
                {resizable && gripEl("startTime", "top")}
                {resizable && gripEl("endTime", "bottom")}
              </button>,
            );
          }
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
        const railWidthPx = railRef.current?.getBoundingClientRect().width ?? 800;
        const bandH = railRef.current?.getBoundingClientRect().height ?? 200;
        const CLUSTER_X_PX = 22; // ~one chip width on a typical 1Y zoom
        const CLUSTER_Y_PX = 16; // chip height ≈ 18 px → overlap if within this

        // Per-day-cell rendering tier based on horizontal room. Same value
        // is used by every singleton + stack chip below so the look is
        // uniform across the band.
        const chipWidthAvail = Math.max(20, Math.min(220, pxPerDay - 6));
        type Tier = "full" | "compact" | "dot";
        const tier: Tier =
          chipWidthAvail >= 110 ? "full" : chipWidthAvail >= 56 ? "compact" : "dot";

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

        // Greedy pixel-proximity clustering. Same deadline-flag only — we
        // don't want a deadline pin merging with a scheduled chip even if
        // they coincidentally land in the same pixel.
        const clusters: Anchor[][] = [];
        const centers: { x: number; y: number; deadline: boolean }[] = [];
        for (const c of visible) {
          let placed = false;
          for (let i = 0; i < clusters.length; i++) {
            const bc = centers[i];
            if (bc.deadline !== c.deadline) continue;
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

        const out: React.ReactNode[] = [];
        for (const chips of clusters) {
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
            const titleLimit = chipWidthAvail >= 180 ? 28 : chipWidthAvail >= 130 ? 18 : 12;
            const truncated =
              d.title.length > titleLimit ? d.title.slice(0, titleLimit - 1) + "…" : d.title;
            const externalLabel = tier === "dot" ? (d.title.length > 22 ? d.title.slice(0, 21) + "…" : d.title) : null;
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
                  transform: "translate(-50%, -50%)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: tier === "dot" ? "center" : "flex-start",
                  gap: tier === "dot" ? 0 : 4,
                  padding: tier === "dot" ? "0" : "3px 7px",
                  width: tier === "dot" ? 16 : undefined,
                  height: tier === "dot" ? 16 : undefined,
                  borderRadius: tier === "dot" ? 999 : 6,
                  background: chipBackground(d.tagsAll, tagColors, 0.82),
                  color: "#1c1c1e",
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
                  maxWidth: chipWidthAvail,
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
            // In dot mode the chip itself carries only an icon — surface the
            // task title as a small floating label to the right of the dot so
            // the user can still read what each indicator is for. pointer-
            // events:none keeps the label from blocking drag on neighbouring
            // chips.
            if (externalLabel) {
              out.push(
                <div
                  key={`tlbl${key}`}
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: `${left}%`,
                    top,
                    transform: "translate(12px, -50%)",
                    fontSize: 9.5,
                    color: "var(--c-text-dim)",
                    background: "rgba(0,0,0,0.25)",
                    padding: "1px 4px",
                    borderRadius: 3,
                    whiteSpace: "nowrap",
                    pointerEvents: "none",
                    maxWidth: 140,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    opacity: outOfWorkHours ? 0.55 : 0.85,
                    zIndex: 1,
                  }}
                >
                  {externalLabel}
                  {effectiveTime ? ` · ${effectiveTime}` : ""}
                </div>,
              );
            }
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
                title={`${chips.length} tasks ${allDeadlines ? "due" : "scheduled"} near this point${
                  allSameTime ? " @ " + chips[0].timeOfDay : ""
                } — click to expand`}
                style={{
                  position: "absolute",
                  left: `${left}%`,
                  top,
                  transform: "translate(-50%, -50%)",
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
                  border: isOpen ? "2px solid #ffd166" : "1px solid rgba(0,0,0,0.4)",
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
            // External label for a dot-mode stack: brief preview of the
            // first 1-2 titles + the count overflow. Keeps the indicator
            // tiny while making it readable at a glance.
            if (tier === "dot") {
              const previewTitles = chips
                .slice(0, 2)
                .map((c) => (c.title.length > 16 ? c.title.slice(0, 15) + "…" : c.title))
                .join(", ");
              const more = chips.length > 2 ? ` +${chips.length - 2}` : "";
              out.push(
                <div
                  key={`stklbl${key}`}
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: `${left}%`,
                    top,
                    transform: "translate(14px, -50%)",
                    fontSize: 9.5,
                    color: "var(--c-text-dim)",
                    background: "rgba(0,0,0,0.3)",
                    padding: "1px 4px",
                    borderRadius: 3,
                    whiteSpace: "nowrap",
                    pointerEvents: "none",
                    maxWidth: 180,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    opacity: stackOutOfWorkHours ? 0.55 : 0.85,
                    zIndex: 1,
                    fontWeight: 600,
                  }}
                >
                  {previewTitles}
                  {more}
                </div>,
              );
            }
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
          real: a few px/min at 1W zoom), and the label reads HH:MM:SS so
          you can see it moving. Z-index 0 keeps it BEHIND task chips and
          milestone pins so the marker doesn't visually punch through
          deadline/scheduled indicators. */}
      {nowMs >= startMs && nowMs <= endMs && (() => {
        const nowDate = new Date(nowMs);
        const hh = String(nowDate.getHours()).padStart(2, "0");
        const mm = String(nowDate.getMinutes()).padStart(2, "0");
        const ss = String(nowDate.getSeconds()).padStart(2, "0");
        return (
          <>
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
            <div
              style={{
                position: "absolute",
                left: `${pct(nowMs)}%`,
                top: 28,
                transform: "translateX(4px)",
                fontSize: 9,
                color: "#e0a458",
                fontWeight: 700,
                fontFamily: "ui-monospace, monospace",
                fontVariantNumeric: "tabular-nums",
                zIndex: 0,
                pointerEvents: "none",
                whiteSpace: "nowrap",
              }}
            >
              TODAY {hh}:{mm}:{ss}
            </div>
          </>
        );
      })()}

      {/* Milestone pins — greedy lane assignment so close-by dates stagger
          vertically instead of overlapping their labels. Click ⚑ to recolour,
          drag the pin to move, double-click to rename, ✕ to remove. */}
      {(() => {
        const railWidth = railRef.current?.getBoundingClientRect().width ?? 800;
        const PIN_BASE_TOP = 44;
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
            <div key={m.id} data-pin style={{ position: "absolute", left: `${leftPct}%`, top: topPx, bottom: 18, width: 0 }}>
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
                  <span style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}>{m.label || "(unnamed)"}</span>
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
  );
}
