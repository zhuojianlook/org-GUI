import { useMemo, useRef, useState } from "react";
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

  const railRef = useRef<HTMLDivElement>(null);
  const dragId = useRef<string | null>(null);
  const panRef = useRef<{ startX: number; startCenterMs: number } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

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
        });
      const d = parseOrgDate(n.deadline);
      if (d)
        out.push({
          ms: startOfDay(d).getTime(),
          deadline: true,
          nodeId: n.id,
          title: n.title ?? "(untitled)",
          color: n.deadlineColor || "#ff6c6b",
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
  const onPanStart = (e: React.PointerEvent) => {
    if (timelineView.zoom === "fit") return;
    if (e.button !== 0) return;
    // Don't start a pan if the target is interactive (button, input, pin).
    if ((e.target as HTMLElement).closest("button,input,[data-pin]")) return;
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
          Milestones
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

      {/* Task-date ticks with truncated labels. Lanes are assigned greedily
          left-to-right so labels that would overlap horizontally bump up to
          the next vertical lane. Double-click a tick to focus the node in the
          graph. */}
      {(() => {
        const railWidth = railRef.current?.getBoundingClientRect().width ?? 800;
        const LABEL_PX = 92; // approximate width of a 12-char truncated label
        const LANE_H = 16; // vertical step per lane
        const LANE_BASE = 22; // px above bottom of band (above month axis)
        const MAX_LANES = 4;

        // Sort by x; deadlines first so they end up in the lower lanes (more
        // visible) when stacked against same-day scheduled ticks.
        const sorted = nodeDates
          .map((d, i) => ({ ...d, idx: i, leftPct: pct(d.ms) }))
          .filter((d) => d.leftPct > -5 && d.leftPct < 105)
          .sort((a, b) =>
            a.leftPct === b.leftPct ? Number(b.deadline) - Number(a.deadline) : a.leftPct - b.leftPct,
          );

        // Greedy lane assignment.
        const laneEnds: number[] = []; // last-occupied right-edge (px) per lane
        const placed = sorted.map((t) => {
          const xPx = (t.leftPct / 100) * railWidth;
          let lane = 0;
          while (lane < laneEnds.length && xPx < laneEnds[lane] + 6) lane++;
          if (lane >= MAX_LANES) lane = MAX_LANES - 1; // overflow lane (will overlap visually)
          laneEnds[lane] = xPx + LABEL_PX;
          return { ...t, lane };
        });

        return placed.map((d) => {
          const truncated = d.title.length > 14 ? d.title.slice(0, 13) + "…" : d.title;
          const bottom = LANE_BASE + d.lane * LANE_H;
          return (
            <button
              key={`t${d.idx}`}
              onDoubleClick={(e) => {
                e.stopPropagation();
                window.dispatchEvent(new CustomEvent("orggui:focusNode", { detail: { id: d.nodeId } }));
              }}
              onPointerDown={(e) => e.stopPropagation()}
              title={`${d.deadline ? "⚑ Deadline" : "⏱ Scheduled"}: ${d.title} — double-click to focus in graph`}
              style={{
                position: "absolute",
                left: `${d.leftPct}%`,
                bottom,
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "1px 4px 1px 0",
                borderRadius: 4,
                background: "transparent",
                border: "none",
                cursor: "pointer",
                lineHeight: 1,
                color: d.color,
                maxWidth: LABEL_PX,
                whiteSpace: "nowrap",
                overflow: "hidden",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 4,
                  background: d.color,
                  flexShrink: 0,
                  marginLeft: -3.5,
                  boxShadow: d.deadline ? `0 0 4px ${d.color}` : "none",
                }}
              />
              <span
                style={{
                  fontSize: 9.5,
                  fontWeight: d.deadline ? 700 : 500,
                  color: "var(--c-text)",
                  opacity: 0.85,
                  textOverflow: "ellipsis",
                  overflow: "hidden",
                }}
              >
                {truncated}
              </span>
            </button>
          );
        });
      })()}

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
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    pickColor(color, (c) => updateMilestone(m.id, { color: c }));
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  title="Click to change this milestone's colour"
                  style={{
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    margin: 0,
                    color: "inherit",
                    font: "inherit",
                    cursor: "pointer",
                    lineHeight: 1,
                  }}
                >
                  ⚑
                </button>
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
