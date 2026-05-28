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
  const timelineSelectedChip = useOrgStore((s) => s.timelineSelectedChip);
  const setTimelineSelectedChip = useOrgStore((s) => s.setTimelineSelectedChip);
  const tagColors = useOrgStore((s) => s.tagColors);

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
    }[] = [];
    for (const n of doc?.nodes ?? []) {
      if (n.done) continue;
      const tags = n.tagsAll ?? [];
      const s = parseOrgDate(n.scheduled);
      if (s)
        out.push({
          ms: startOfDay(s).getTime(),
          deadline: false,
          nodeId: n.id,
          title: n.title ?? "(untitled)",
          color: "#51afef",
          tagsAll: tags,
          timeOfDay: timeOfDayFromIso(n.scheduled),
          iso: n.scheduled ?? "",
        });
      const d = parseOrgDate(n.deadline);
      if (d)
        out.push({
          ms: startOfDay(d).getTime(),
          deadline: true,
          nodeId: n.id,
          title: n.title ?? "(untitled)",
          color: n.deadlineColor || "#ff6c6b",
          tagsAll: tags,
          timeOfDay: timeOfDayFromIso(n.deadline),
          iso: n.deadline ?? "",
        });
    }
    return out;
  }, [doc]);

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
   * Holding an arrow key auto-repeats at ~30 events/s. Firing scheduleNode
   * on every event spawns 30 parallel emacsclient processes per second,
   * which overloads the daemon and produces "Connection refused" / stale-
   * socket errors. We coalesce instead: at most one bridge call is in
   * flight at a time. Further keypresses accumulate into pendingDelta
   * (date + minute offsets) and flush in a single combined call once the
   * previous one returns. End result: pressing & holding ↓ produces ~3-5
   * bridge calls per second, each advancing the schedule by however many
   * 15-min steps elapsed since the last flush.
   */
  const nudgeInflight = useRef(false);
  const nudgePending = useRef({ ddate: 0, dminutes: 0 });
  useEffect(() => {
    if (!timelineSelectedChip) return;

    const flush = () => {
      if (nudgeInflight.current) return;
      const { ddate, dminutes } = nudgePending.current;
      if (ddate === 0 && dminutes === 0) return;
      const sel = timelineSelectedChip;
      const node = doc?.nodes.find((n) => n.id === sel.nodeId);
      if (!node) {
        nudgePending.current = { ddate: 0, dminutes: 0 };
        return;
      }
      const isoNow = sel.isDeadline ? node.deadline : node.scheduled;
      const cur = parseOrgDate(isoNow);
      if (!cur) {
        nudgePending.current = { ddate: 0, dminutes: 0 };
        return;
      }
      const curTime = timeOfDayFromIso(isoNow) ?? "12:00";
      const [hh, mm] = curTime.split(":").map((s) => parseInt(s, 10));
      const baseMin = (Number.isFinite(hh) ? hh : 12) * 60 + (Number.isFinite(mm) ? mm : 0);
      const newDate = new Date(cur);
      newDate.setHours(0, 0, 0, 0);
      newDate.setDate(newDate.getDate() + ddate);
      const wrapped = ((baseMin + dminutes) % 1440 + 1440) % 1440;
      const newH = Math.floor(wrapped / 60);
      const newM = wrapped % 60;
      const dateStr = `${isoOf(newDate)} ${String(newH).padStart(2, "0")}:${String(newM).padStart(2, "0")}`;
      nudgePending.current = { ddate: 0, dminutes: 0 };
      nudgeInflight.current = true;
      Promise.resolve(scheduleNode(node, dateStr, sel.isDeadline ? "deadline" : "scheduled"))
        .catch(() => {
          // scheduleNode already surfaces errors via store.error → toast;
          // we just need to make sure inflight clears so the next nudge
          // can fire instead of getting stuck.
        })
        .finally(() => {
          nudgeInflight.current = false;
          // Drain anything the user accumulated while we were waiting.
          if (nudgePending.current.ddate !== 0 || nudgePending.current.dminutes !== 0) {
            flush();
          }
        });
    };

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      if (e.key === "Escape") {
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
      nudgePending.current.ddate += ddate;
      nudgePending.current.dminutes += dminutes;
      flush();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // Don't carry pending deltas across selection changes — a queued
      // nudge for the previous chip would silently retarget when the
      // selection moves.
      nudgePending.current = { ddate: 0, dminutes: 0 };
    };
  }, [timelineSelectedChip, doc, scheduleNode, setTimelineSelectedChip]);

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
      title={
        timelineView.zoom === "fit"
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
        cursor: timelineView.zoom === "fit" ? "default" : panRef.current ? "grabbing" : "grab",
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
            const left = d.leftPct;
            const top = d.topPx;
            const isOverdue = d.deadline && d.ms <= todayMs;
            const isSelected =
              timelineSelectedChip != null &&
              timelineSelectedChip.nodeId === d.nodeId &&
              timelineSelectedChip.isDeadline === d.deadline;
            const outOfWorkHours = workHoursMode && isOutsideWorkHours(d.timeOfDay);
            const showTitle = tier === "full";
            const showTime = tier !== "dot" && !!d.timeOfDay;
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
                  d.timeOfDay ? " @ " + d.timeOfDay : ""
                }${
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
                {showTitle && (
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                    {truncated}
                  </span>
                )}
                {showTime && (
                  <span
                    style={{
                      opacity: 0.75,
                      fontVariantNumeric: "tabular-nums",
                      flexShrink: 0,
                      fontSize: tier === "compact" ? 10 : 10.5,
                    }}
                  >
                    {d.timeOfDay}
                    {outOfWorkHours && (
                      <span aria-hidden style={{ marginLeft: 2 }}>
                        {(() => {
                          const [h] = (d.timeOfDay as string)
                            .split(":")
                            .map((s) => parseInt(s, 10));
                          const minOfDay = (Number.isFinite(h) ? h : 0) * 60;
                          return minOfDay < WORK_START_MIN ? "↑" : "↓";
                        })()}
                      </span>
                    )}
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
                  {d.timeOfDay ? ` · ${d.timeOfDay}` : ""}
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
