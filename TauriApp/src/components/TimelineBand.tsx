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

/** Extract the "HH:MM" component from an ISO timestamp, or null when the
 *  value is date-only (no T separator). */
function timeOfDayFromIso(iso: string | null | undefined): string | null {
  if (!iso || !iso.includes("T")) return null;
  return iso.slice(11, 16);
}

// Vertical zone in the band where task chips live; y in this zone maps
// linearly to time of day (00:00 at top, 23:59 at bottom). The top
// padding clears the zoom toolbar; the bottom padding clears the month
// labels and milestone pins.
const TIME_TOP_PX = 56;
const TIME_BOTTOM_OFFSET = 32;

function yForTimeOfDay(timeOfDay: string | null, bandHeight: number): number {
  const usable = Math.max(40, bandHeight - TIME_TOP_PX - TIME_BOTTOM_OFFSET);
  if (!timeOfDay) return TIME_TOP_PX + usable / 2; // unscheduled time → mid-band
  const [h, m] = timeOfDay.split(":").map((s) => parseInt(s, 10));
  const min = (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  return TIME_TOP_PX + (min / 1440) * usable;
}

/** Inverse of yForTimeOfDay — convert a clientY (relative to railRef) into a
 *  "HH:MM" string snapped to the nearest 15-minute mark. */
function timeAtRailY(yRel: number, bandHeight: number): string {
  const usable = Math.max(40, bandHeight - TIME_TOP_PX - TIME_BOTTOM_OFFSET);
  const frac = Math.max(0, Math.min(1, (yRel - TIME_TOP_PX) / usable));
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

  const railRef = useRef<HTMLDivElement>(null);
  const dragId = useRef<string | null>(null);
  const panRef = useRef<{ startX: number; startCenterMs: number } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
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
      color: string;
      timeOfDay: string | null; // "HH:MM" when the timestamp carries a time
      iso: string; // the underlying YYYY-MM-DD[ THH:MM] stored on the node
    }[] = [];
    for (const n of doc?.nodes ?? []) {
      if (n.done) continue;
      const s = parseOrgDate(n.scheduled);
      if (s)
        out.push({
          ms: startOfDay(s).getTime(),
          deadline: false,
          nodeId: n.id,
          title: n.title ?? "(untitled)",
          color: "#51afef",
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

  /**
   * Arrow-key nudge when a timeline chip is selected:
   *   ← / →  shift the date by ±1 day
   *   ↑ / ↓  shift the time of day by ∓15 min  (↑ = earlier, ↓ = later)
   *   Esc    deselect
   * All commits go through scheduleNode → dependency validator.
   */
  useEffect(() => {
    if (!timelineSelectedChip) return;
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
      const node = doc?.nodes.find((n) => n.id === timelineSelectedChip.nodeId);
      if (!node) return;
      const isoNow = timelineSelectedChip.isDeadline ? node.deadline : node.scheduled;
      const cur = parseOrgDate(isoNow);
      if (!cur) return;
      // Existing time of day if present, otherwise midday so the first
      // ↑/↓ press moves a reasonable amount instead of jumping to midnight.
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
      scheduleNode(node, dateStr, timelineSelectedChip.isDeadline ? "deadline" : "scheduled");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
      const time = timeAtRailY(ev.clientY - r.top, r.height);
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
      const time = timeAtRailY(ev.clientY - r.top, r.height);
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
  const showDayLabels = pxPerDay >= 26;
  const months = monthStarts(startMs, endMs);
  const days = pxPerDay >= 18 ? dayStarts(startMs, endMs) : [];

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
                  left: `${left}%`,
                  bottom: 2,
                  transform: "translateX(3px)",
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

      {/* Task chips: real, draggable task representations on the timeline.
          X coordinate is the task's date; Y coordinate is its time of day
          (00:00 at the top of the chip-zone, 23:59 at the bottom). Drag in
          2D to reschedule (X commits date, Y commits time); single-click
          (no drag) focuses the node in the graph. Overdue deadlines
          inherit the .deadline-flash CSS animation so they pulse red. */}
      {nodeDates.map((d, i) => {
        const left = pct(d.ms);
        if (left < -5 || left > 105) return null;
        const bandH = railRef.current?.getBoundingClientRect().height ?? 200;
        const top = yForTimeOfDay(d.timeOfDay, bandH);
        const isOverdue = d.deadline && d.ms <= todayMs;
        const truncated = d.title.length > 22 ? d.title.slice(0, 21) + "…" : d.title;
        const isSelected =
          timelineSelectedChip != null &&
          timelineSelectedChip.nodeId === d.nodeId &&
          timelineSelectedChip.isDeadline === d.deadline;
        return (
          <button
            key={`t${i}`}
            className={isOverdue ? "deadline-flash" : undefined}
            data-pin
            onPointerDown={(e) =>
              onChipDown(e, { nodeId: d.nodeId, deadline: d.deadline, title: d.title, color: d.color })
            }
            title={`${d.deadline ? "⚑ Deadline" : "⏱ Scheduled"}: ${d.title}${d.timeOfDay ? " @ " + d.timeOfDay : ""}\nClick to select (then arrow keys nudge), drag to reschedule freely`}
            style={{
              position: "absolute",
              left: `${left}%`,
              top,
              transform: "translate(-50%, -50%)",
              display: "flex",
              alignItems: "center",
              gap: 5,
              padding: "3px 8px",
              borderRadius: 6,
              background: d.color,
              color: "#1c1c1e",
              border: isSelected ? "2px solid #ffd166" : "1px solid rgba(0,0,0,0.25)",
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
              maxWidth: 200,
              overflow: "hidden",
              userSelect: "none",
            }}
          >
            <span aria-hidden style={{ fontSize: 11, flexShrink: 0 }}>
              {d.deadline ? "⚑" : "⏱"}
            </span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{truncated}</span>
            {d.timeOfDay && (
              <span style={{ opacity: 0.7, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                {d.timeOfDay}
              </span>
            )}
          </button>
        );
      })}

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

      {/* Today marker */}
      {todayMs >= startMs && todayMs <= endMs && (
        <>
          <div style={{ position: "absolute", left: `${pct(todayMs)}%`, top: 24, bottom: 18, width: 2, marginLeft: -1, background: "#e0a458" }} />
          <div style={{ position: "absolute", left: `${pct(todayMs)}%`, top: 28, transform: "translateX(4px)", fontSize: 9, color: "#e0a458", fontWeight: 700 }}>TODAY</div>
        </>
      )}

      {/* Milestone pins — greedy lane assignment so close-by dates stagger
          vertically instead of overlapping their labels. Click ⚑ to recolour,
          drag the pin to move, double-click to rename, ✕ to remove. */}
      {(() => {
        const railWidth = railRef.current?.getBoundingClientRect().width ?? 800;
        const PIN_BASE_TOP = 44;
        const PIN_LANE_H = 26;
        const MAX_PIN_LANES = 3;
        const LABEL_PX = 160;

        type Placed = { m: typeof milestones[number]; d: Date; leftPct: number; lane: number };
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
          let lane = 0;
          while (lane < laneEnds.length && xPx < laneEnds[lane] + 8) lane++;
          if (lane >= MAX_PIN_LANES) lane = MAX_PIN_LANES - 1;
          laneEnds[lane] = xPx + LABEL_PX;
          return { ...c, lane };
        });

        return placed.map(({ m, d, leftPct, lane }) => {
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
              <div style={{ position: "absolute", top: 18, left: 0, transform: "translateX(-50%)", fontSize: 8.5, color: color, whiteSpace: "nowrap" }}>
                {d.getDate()} {MONTHS[d.getMonth()]}
              </div>
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
