import { useMemo, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { buildSchedItems, groupBySection, type SchedItem } from "../utils/scheduleItems";
import { startOfDay } from "../utils/time";
import { hexToRgba } from "../utils/tagColor";

// Asana-style swimlane timeline (Gantt). Tasks are grouped by their top-level
// section heading; each task gets its OWN full-width row with a horizontal bar
// spanning its date range and the title right there — so titles always have
// room (a short bar's title simply flows into the empty rest of its own row,
// which can't collide with anything). Click a bar/row to select the task.

const DAY_MS = 86_400_000;
const LABEL_W = 190; // left rail width
const ROW_H = 26;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function TimelineGanttView() {
  const doc = useOrgStore((s) => s.doc);
  const tagColors = useOrgStore((s) => s.tagColors);
  const select = useOrgStore((s) => s.select);
  const selectedId = useOrgStore((s) => s.selectedId);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const items = useMemo(() => buildSchedItems(doc, tagColors), [doc, tagColors]);
  const groups = useMemo(() => groupBySection(items), [items]);

  // Auto-fit the date axis to all items, with a few days of padding each side.
  const { rangeStart, rangeEnd } = useMemo(() => {
    if (items.length === 0) {
      const t = startOfDay(new Date()).getTime();
      return { rangeStart: t - 7 * DAY_MS, rangeEnd: t + 21 * DAY_MS };
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const it of items) {
      lo = Math.min(lo, it.dayMs);
      hi = Math.max(hi, it.endDayMs);
    }
    return { rangeStart: lo - 3 * DAY_MS, rangeEnd: hi + 4 * DAY_MS };
  }, [items]);

  const span = Math.max(DAY_MS, rangeEnd - rangeStart);
  const pctOf = (ms: number) => ((ms - rangeStart) / span) * 100;

  // Axis ticks: month boundaries (labelled) + a day step that stays readable.
  const totalDays = Math.round(span / DAY_MS);
  const ticks = useMemo(() => {
    const out: { ms: number; label: string; major: boolean }[] = [];
    const step = totalDays <= 21 ? DAY_MS : totalDays <= 70 ? 7 * DAY_MS : 14 * DAY_MS;
    let d = startOfDay(new Date(rangeStart));
    // align to step start
    for (let ms = d.getTime(); ms <= rangeEnd; ms += step) {
      const dd = new Date(ms);
      const major = dd.getDate() <= step / DAY_MS; // first tick of a month-ish
      out.push({ ms, label: `${dd.getDate()} ${MONTHS[dd.getMonth()]}`, major });
    }
    return out;
  }, [rangeStart, rangeEnd, totalDays]);

  const todayMs = startOfDay(new Date()).getTime();
  const showToday = todayMs >= rangeStart && todayMs <= rangeEnd;

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (items.length === 0) {
    return (
      <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--c-text-dim)", background: "var(--c-bg)", fontSize: 14, padding: 24, textAlign: "center" }}>
        No dated tasks yet — give a task a SCHEDULED / DEADLINE / timestamp to see it on the timeline.
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, background: "var(--c-bg)" }}>
      {/* Date axis header */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--c-border)", flexShrink: 0, height: 26 }}>
        <div style={{ width: LABEL_W, flexShrink: 0, borderRight: "1px solid var(--c-border)", fontSize: 11, color: "var(--c-text-dim)", padding: "5px 10px" }}>
          {MONTHS[new Date(rangeStart).getMonth()]} → {MONTHS[new Date(rangeEnd).getMonth()]}
        </div>
        <div style={{ position: "relative", flex: 1 }}>
          {ticks.map((t) => (
            <div key={t.ms} style={{ position: "absolute", left: `${pctOf(t.ms)}%`, top: 0, bottom: 0, paddingLeft: 4, borderLeft: `1px solid ${t.major ? "var(--c-border)" : "var(--c-surface2)"}`, fontSize: 9.5, color: t.major ? "var(--c-text)" : "var(--c-text-dim)", fontWeight: t.major ? 700 : 400, whiteSpace: "nowrap" }}>
              {t.label}
            </div>
          ))}
          {showToday && <div style={{ position: "absolute", left: `${pctOf(todayMs)}%`, top: 0, bottom: 0, width: 2, background: "#e0a458" }} />}
        </div>
      </div>

      {/* Scrollable lanes */}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.id);
          return (
            <div key={g.id}>
              {/* section header */}
              <div style={{ display: "flex", alignItems: "center", background: "var(--c-surface)", borderBottom: "1px solid var(--c-border)", position: "sticky", top: 0, zIndex: 2 }}>
                <button
                  onClick={() => toggle(g.id)}
                  style={{ width: LABEL_W, flexShrink: 0, textAlign: "left", background: "transparent", border: "none", color: "var(--c-text)", fontWeight: 700, fontSize: 11.5, padding: "5px 10px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}
                  title={g.title}
                >
                  <span style={{ display: "inline-block", transform: isCollapsed ? "none" : "rotate(90deg)", transition: "transform 0.12s" }}>▸</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.title}</span>
                  <span style={{ color: "var(--c-text-dim)", fontWeight: 500 }}>({g.items.length})</span>
                </button>
                <div style={{ flex: 1 }} />
              </div>
              {/* task rows */}
              {!isCollapsed &&
                g.items.map((it) => {
                  const left = pctOf(it.dayMs);
                  const right = pctOf(it.endDayMs + DAY_MS);
                  const width = Math.max(0.8, right - left);
                  const sel = selectedId === it.nodeId;
                  return (
                    <div key={it.nodeId} style={{ display: "flex", height: ROW_H, borderBottom: "1px solid var(--c-surface2)" }}>
                      {/* row label */}
                      <button
                        onClick={() => select(it.nodeId)}
                        title={it.title}
                        style={{ width: LABEL_W, flexShrink: 0, textAlign: "left", background: sel ? "var(--c-surface2)" : "transparent", border: "none", borderRight: "1px solid var(--c-border)", color: it.done ? "var(--c-text-dim)" : "var(--c-text)", fontSize: 10.5, padding: "0 10px 0 24px", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: it.done ? "line-through" : "none" }}
                      >
                        {it.title}
                      </button>
                      {/* bar track */}
                      <div style={{ position: "relative", flex: 1 }}>
                        {showToday && <div style={{ position: "absolute", left: `${pctOf(todayMs)}%`, top: 0, bottom: 0, width: 1, background: "rgba(224,164,88,0.4)" }} />}
                        <button
                          onClick={() => select(it.nodeId)}
                          title={`${it.title} — ${it.kind}`}
                          style={{
                            position: "absolute",
                            left: `${left}%`,
                            width: `${width}%`,
                            top: 4,
                            height: ROW_H - 9,
                            background: hexToRgba(it.color, sel ? 0.85 : 0.6),
                            border: sel ? "1px solid #ffd166" : `1px solid ${it.color}`,
                            borderRadius: 9,
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            padding: "0 8px",
                            // The title flows past a short bar's right edge into
                            // the row's own empty space — readable, and it can't
                            // collide with anything (one task per row).
                            overflow: "visible",
                            whiteSpace: "nowrap",
                            color: "var(--c-text)",
                            fontSize: 10.5,
                            fontWeight: 600,
                            textShadow: "0 1px 2px rgba(0,0,0,0.5)",
                            textDecoration: it.done ? "line-through" : "none",
                          }}
                        >
                          {it.priority && (
                            <span style={{ flexShrink: 0, marginRight: 4, fontWeight: 800, color: "#ffd166" }}>[{it.priority}]</span>
                          )}
                          {it.title}
                        </button>
                      </div>
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
