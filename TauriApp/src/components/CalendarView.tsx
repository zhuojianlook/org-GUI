import { useMemo, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { buildSchedItems, type SchedItem } from "../utils/scheduleItems";
import { startOfDay, minutesOfDay } from "../utils/time";
import { hexToRgba } from "../utils/tagColor";

// Todoist-style week calendar: day columns × time-of-day rows, with an all-day
// row on top. Timed tasks render as blocks (title + time, height = duration);
// overlapping events split the column. Click a block to select the task.

const DAY_MS = 86_400_000;
const VIEW_START_H = 6; // first hour row
const VIEW_END_H = 22; // last hour boundary
const PX_PER_HOUR = 46;
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function mondayOf(d: Date): Date {
  const s = startOfDay(d);
  const dow = (s.getDay() + 6) % 7; // 0 = Monday
  return new Date(s.getFullYear(), s.getMonth(), s.getDate() - dow);
}

/** Pack a day's timed items into non-overlapping lanes (interval partitioning)
 *  so concurrent events sit side-by-side instead of on top of each other. */
function packLanes(dayItems: SchedItem[]) {
  const enriched = dayItems
    .map((it) => {
      const startMin = minutesOfDay(it.timeOfDay);
      const endMin = it.timeOfDayEnd
        ? Math.max(startMin + 15, minutesOfDay(it.timeOfDayEnd))
        : startMin + 60;
      return { it, startMin, endMin };
    })
    .sort((a, b) => a.startMin - b.startMin);
  const laneEnds: number[] = [];
  const placed = enriched.map((e) => {
    let lane = laneEnds.findIndex((end) => end <= e.startMin);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(e.endMin);
    } else {
      laneEnds[lane] = e.endMin;
    }
    return { ...e, lane };
  });
  const lanes = Math.max(1, laneEnds.length);
  return placed.map((p) => ({ ...p, lanes }));
}

export default function CalendarView() {
  const doc = useOrgStore((s) => s.doc);
  const tagColors = useOrgStore((s) => s.tagColors);
  const select = useOrgStore((s) => s.select);
  const selectedId = useOrgStore((s) => s.selectedId);
  const [weekStart, setWeekStart] = useState<number>(() => mondayOf(new Date()).getTime());

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => weekStart + i * DAY_MS),
    [weekStart],
  );
  const items = useMemo(() => buildSchedItems(doc, tagColors), [doc, tagColors]);
  const gridH = (VIEW_END_H - VIEW_START_H) * PX_PER_HOUR;
  const todayMs = startOfDay(new Date()).getTime();

  // Split into all-day/multi-day (top row) vs timed single-day (grid).
  const weekEnd = weekStart + 7 * DAY_MS;
  const allDayByDay: SchedItem[][] = days.map(() => []);
  const timedByDay: SchedItem[][] = days.map(() => []);
  for (const it of items) {
    if (it.endDayMs < weekStart || it.dayMs >= weekEnd) continue;
    if (it.allDay || it.multiDay) {
      // place on each visible covered day's all-day row
      for (let i = 0; i < 7; i++) {
        if (days[i] >= it.dayMs && days[i] <= it.endDayMs) allDayByDay[i].push(it);
      }
    } else {
      const idx = Math.round((it.dayMs - weekStart) / DAY_MS);
      if (idx >= 0 && idx < 7) timedByDay[idx].push(it);
    }
  }

  const onPick = (it: SchedItem) => select(it.nodeId);

  // Now-line position (only when today is in the visible week).
  const now = new Date();
  const nowIdx = Math.round((startOfDay(now).getTime() - weekStart) / DAY_MS);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nowTop = ((nowMin - VIEW_START_H * 60) / 60) * PX_PER_HOUR;
  const showNow = nowIdx >= 0 && nowIdx < 7 && nowTop >= 0 && nowTop <= gridH;

  const monthLbl = `${MONTHS[new Date(weekStart).getMonth()]} ${new Date(weekStart).getFullYear()}`;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, position: "relative", background: "var(--c-bg)" }}>
      {/* Week navigation */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", flexShrink: 0 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>{monthLbl}</span>
        <div style={{ flex: 1 }} />
        <NavBtn onClick={() => setWeekStart((w) => w - 7 * DAY_MS)}>‹</NavBtn>
        <NavBtn onClick={() => setWeekStart(mondayOf(new Date()).getTime())}>Today</NavBtn>
        <NavBtn onClick={() => setWeekStart((w) => w + 7 * DAY_MS)}>›</NavBtn>
      </div>

      {/* Day headers */}
      <div style={{ display: "grid", gridTemplateColumns: `48px repeat(7, 1fr)`, borderBottom: "1px solid var(--c-border)", flexShrink: 0 }}>
        <div />
        {days.map((ms, i) => {
          const d = new Date(ms);
          const isToday = ms === todayMs;
          return (
            <div key={ms} style={{ padding: "6px 8px", borderLeft: "1px solid var(--c-surface2)", fontSize: 11.5 }}>
              <span style={{ color: "var(--c-text-dim)" }}>{DAY_NAMES[i]} </span>
              <span style={{ fontWeight: isToday ? 800 : 600, color: isToday ? "#fff" : "var(--c-text)", background: isToday ? "var(--c-accent)" : "transparent", borderRadius: 8, padding: isToday ? "0 6px" : 0 }}>
                {d.getDate()}
              </span>
            </div>
          );
        })}
      </div>

      {/* All-day row */}
      <div style={{ display: "grid", gridTemplateColumns: `48px repeat(7, 1fr)`, borderBottom: "1px solid var(--c-border)", minHeight: 24, flexShrink: 0 }}>
        <div style={{ fontSize: 9.5, color: "var(--c-text-dim)", padding: "4px 4px 0", textAlign: "right" }}>all-day</div>
        {days.map((ms, i) => (
          <div key={ms} style={{ borderLeft: "1px solid var(--c-surface2)", padding: 2, display: "flex", flexDirection: "column", gap: 2 }}>
            {allDayByDay[i].map((it) => (
              <button
                key={it.nodeId}
                onClick={() => onPick(it)}
                title={it.title}
                style={{
                  textAlign: "left",
                  background: hexToRgba(it.color, selectedId === it.nodeId ? 0.85 : 0.5),
                  border: selectedId === it.nodeId ? "1px solid #ffd166" : `1px solid ${hexToRgba(it.color, 0.8)}`,
                  borderRadius: 4,
                  padding: "1px 6px",
                  fontSize: 10.5,
                  fontWeight: 600,
                  color: "var(--c-text)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  cursor: "pointer",
                  textDecoration: it.done ? "line-through" : "none",
                }}
              >
                {it.title}
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* Time grid (scrolls) */}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        <div style={{ position: "relative", display: "grid", gridTemplateColumns: `48px repeat(7, 1fr)`, height: gridH }}>
          {/* hour labels */}
          <div style={{ position: "relative" }}>
            {Array.from({ length: VIEW_END_H - VIEW_START_H }, (_, h) => (
              <div key={h} style={{ position: "absolute", top: h * PX_PER_HOUR - 6, right: 4, fontSize: 9.5, color: "var(--c-text-dim)" }}>
                {String(VIEW_START_H + h).padStart(2, "0")}:00
              </div>
            ))}
          </div>
          {/* day columns */}
          {days.map((ms, i) => {
            const packed = packLanes(timedByDay[i]);
            return (
              <div key={ms} style={{ position: "relative", borderLeft: "1px solid var(--c-surface2)" }}>
                {/* hour gridlines */}
                {Array.from({ length: VIEW_END_H - VIEW_START_H + 1 }, (_, h) => (
                  <div key={h} style={{ position: "absolute", top: h * PX_PER_HOUR, left: 0, right: 0, height: 1, background: "var(--c-surface2)" }} />
                ))}
                {packed.map(({ it, startMin, endMin, lane, lanes }) => {
                  const top = Math.max(0, ((startMin - VIEW_START_H * 60) / 60) * PX_PER_HOUR);
                  const rawH = ((endMin - startMin) / 60) * PX_PER_HOUR;
                  const height = Math.max(20, Math.min(rawH, gridH - top));
                  const wPct = 100 / lanes;
                  const sel = selectedId === it.nodeId;
                  return (
                    <button
                      key={it.nodeId}
                      onClick={() => onPick(it)}
                      title={`${it.title}${it.timeOfDay ? "\n" + it.timeOfDay + (it.timeOfDayEnd ? "–" + it.timeOfDayEnd : "") : ""}`}
                      style={{
                        position: "absolute",
                        top,
                        height,
                        left: `calc(${lane * wPct}% + 1px)`,
                        width: `calc(${wPct}% - 2px)`,
                        background: hexToRgba(it.color, sel ? 0.7 : 0.42),
                        borderLeft: `3px solid ${it.color}`,
                        border: sel ? "1px solid #ffd166" : "1px solid rgba(0,0,0,0.25)",
                        borderRadius: 4,
                        padding: "2px 5px",
                        textAlign: "left",
                        overflow: "hidden",
                        cursor: "pointer",
                        color: "var(--c-text)",
                        display: "flex",
                        flexDirection: "column",
                        gap: 1,
                      }}
                    >
                      <span style={{ fontSize: 10.5, fontWeight: 700, lineHeight: 1.15, overflow: "hidden", textOverflow: "ellipsis", textDecoration: it.done ? "line-through" : "none" }}>
                        {it.title}
                      </span>
                      {height >= 32 && it.timeOfDay && (
                        <span style={{ fontSize: 9.5, opacity: 0.85, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {it.timeOfDay}
                          {it.timeOfDayEnd ? `–${it.timeOfDayEnd}` : ""}
                        </span>
                      )}
                    </button>
                  );
                })}
                {showNow && i === nowIdx && (
                  <div style={{ position: "absolute", left: 0, right: 0, top: nowTop, height: 2, background: "#ff453a", zIndex: 3 }}>
                    <div style={{ position: "absolute", left: -3, top: -3, width: 8, height: 8, borderRadius: "50%", background: "#ff453a" }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {items.length === 0 && (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--c-text-dim)", pointerEvents: "none", fontSize: 14 }}>
          No scheduled tasks — give a task a SCHEDULED date/time to see it here.
        </div>
      )}
    </div>
  );
}

function NavBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "var(--c-surface2)",
        color: "var(--c-text)",
        border: "1px solid var(--c-border)",
        borderRadius: 5,
        padding: "3px 9px",
        fontSize: 12,
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      {children}
    </button>
  );
}
