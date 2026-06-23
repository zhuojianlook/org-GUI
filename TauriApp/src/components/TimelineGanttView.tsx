import { useMemo, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { buildSchedItems, groupSectionsAndTasks, type SchedItem } from "../utils/scheduleItems";
import { startOfDay } from "../utils/time";
import { hexToRgba } from "../utils/tagColor";

// Asana-style swimlane timeline (Gantt). PIXEL-based and horizontally scrollable
// so a chosen zoom keeps bars wide enough to read (a minimum bar width is always
// enforced) and the timeline simply scrolls when it overruns the window. Tasks
// are grouped by their top-level section; repeated same-name tasks (e.g. a
// recurring "Lab Meeting") collapse into ONE row with an occurrence bar each.

const DAY_MS = 86_400_000;
const LABEL_W = 200; // sticky left-rail width
const ROW_H = 26;
const MIN_BAR = 38; // enforced minimum bar width so a 1-day task stays readable
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Zoom = "1w" | "2w" | "1m" | "3m" | "6m" | "1y";
const ZOOMS: { id: Zoom; label: string; pxPerDay: number }[] = [
  { id: "1w", label: "1W", pxPerDay: 150 },
  { id: "2w", label: "2W", pxPerDay: 88 },
  { id: "1m", label: "1M", pxPerDay: 42 },
  { id: "3m", label: "3M", pxPerDay: 18 },
  { id: "6m", label: "6M", pxPerDay: 9 },
  { id: "1y", label: "1Y", pxPerDay: 5 },
];

export default function TimelineGanttView() {
  const doc = useOrgStore((s) => s.doc);
  const tagColors = useOrgStore((s) => s.tagColors);
  const select = useOrgStore((s) => s.select);
  const selectedId = useOrgStore((s) => s.selectedId);
  const [zoom, setZoom] = useState<Zoom>("1m");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const pxPerDay = ZOOMS.find((z) => z.id === zoom)!.pxPerDay;
  const items = useMemo(() => buildSchedItems(doc, tagColors), [doc, tagColors]);
  const sections = useMemo(() => groupSectionsAndTasks(items), [items]);

  const { rangeStart, totalDays } = useMemo(() => {
    if (items.length === 0) {
      const t = startOfDay(new Date()).getTime();
      return { rangeStart: t - 7 * DAY_MS, totalDays: 35 };
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const it of items) {
      lo = Math.min(lo, it.dayMs);
      hi = Math.max(hi, it.endDayMs);
    }
    const start = lo - 3 * DAY_MS;
    const days = Math.round((hi + 4 * DAY_MS - start) / DAY_MS);
    return { rangeStart: start, totalDays: Math.max(7, days) };
  }, [items]);

  const trackW = totalDays * pxPerDay;
  const pxOf = (ms: number) => ((ms - rangeStart) / DAY_MS) * pxPerDay;
  const rowW = LABEL_W + trackW;

  const todayMs = startOfDay(new Date()).getTime();
  const todayX = pxOf(todayMs);
  const showToday = todayX >= 0 && todayX <= trackW;

  // Axis ticks: keep labels ~>=64px apart so they never crowd.
  const ticks = useMemo(() => {
    const stepDays = Math.max(1, Math.ceil(64 / pxPerDay));
    const out: { ms: number; label: string; major: boolean }[] = [];
    const first = startOfDay(new Date(rangeStart));
    for (let i = 0; i <= totalDays; i += stepDays) {
      const ms = first.getTime() + i * DAY_MS;
      const dd = new Date(ms);
      out.push({ ms, label: `${dd.getDate()} ${MONTHS[dd.getMonth()]}`, major: dd.getDate() <= stepDays });
    }
    return out;
  }, [rangeStart, totalDays, pxPerDay]);

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const onBar = (it: SchedItem) => select(it.nodeId);

  const renderRow = (row: { title: string; items: SchedItem[] }, indent: boolean) => {
    const sel = row.items.some((it) => it.nodeId === selectedId);
    return (
      <div key={row.title + row.items[0]?.nodeId} style={{ display: "flex", width: rowW, height: ROW_H, borderBottom: "1px solid var(--c-surface2)" }}>
        <button
          onClick={() => row.items[0] && select(row.items[0].nodeId)}
          title={row.title + (row.items.length > 1 ? ` (${row.items.length}×)` : "")}
          style={{ width: LABEL_W, flexShrink: 0, position: "sticky", left: 0, zIndex: 2, textAlign: "left", background: sel ? "var(--c-surface2)" : "var(--c-bg)", border: "none", borderRight: "1px solid var(--c-border)", color: "var(--c-text)", fontSize: 11, padding: indent ? "0 8px 0 26px" : "0 8px 0 12px", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {row.title}
          {row.items.length > 1 && <span style={{ color: "var(--c-text-dim)", marginLeft: 4 }}>×{row.items.length}</span>}
        </button>
        <div style={{ width: trackW, flexShrink: 0, position: "relative" }}>
          {showToday && <div style={{ position: "absolute", left: todayX, top: 0, bottom: 0, width: 1, background: "rgba(224,164,88,0.4)" }} />}
          {row.items.map((it) => {
            const left = pxOf(it.dayMs);
            const width = Math.max(MIN_BAR, pxOf(it.endDayMs + DAY_MS) - left);
            const isSel = it.nodeId === selectedId;
            return (
              <button
                key={it.nodeId}
                onClick={() => onBar(it)}
                title={`${it.title} — ${it.kind}${it.timeOfDay ? " @ " + it.timeOfDay : ""}`}
                style={{
                  position: "absolute",
                  left,
                  width,
                  top: 4,
                  height: ROW_H - 9,
                  background: hexToRgba(it.color, isSel ? 0.9 : 0.62),
                  border: isSel ? "1px solid #ffd166" : `1px solid ${it.color}`,
                  borderRadius: 9,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  padding: "0 8px",
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                  color: "var(--c-text)",
                  fontSize: 10.5,
                  fontWeight: 600,
                  textShadow: "0 1px 2px rgba(0,0,0,0.5)",
                  textDecoration: it.done ? "line-through" : "none",
                }}
              >
                {it.priority && <span style={{ flexShrink: 0, marginRight: 4, fontWeight: 800, color: "#ffd166" }}>[{it.priority}]</span>}
                {it.title}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, background: "var(--c-bg)" }}>
      {/* Zoom controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", flexShrink: 0 }}>
        <span style={{ fontSize: 11, color: "var(--c-text-dim)" }}>Zoom</span>
        <div style={{ display: "inline-flex", border: "1px solid var(--c-border)", borderRadius: 6, overflow: "hidden" }}>
          {ZOOMS.map((z) => (
            <button
              key={z.id}
              onClick={() => setZoom(z.id)}
              style={{ background: zoom === z.id ? "var(--c-accent)" : "var(--c-surface2)", color: zoom === z.id ? "#fff" : "var(--c-text)", border: "none", padding: "2px 9px", fontSize: 11.5, fontWeight: zoom === z.id ? 700 : 500, cursor: "pointer", fontFamily: "inherit" }}
            >
              {z.label}
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: "var(--c-text-dim)" }}>{items.length} dated task{items.length === 1 ? "" : "s"}</span>
      </div>

      {items.length === 0 ? (
        <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--c-text-dim)", fontSize: 14, padding: 24, textAlign: "center" }}>
          No dated tasks yet — give a task a SCHEDULED / DEADLINE / timestamp to see it on the timeline.
        </div>
      ) : (
        <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
          {/* date axis (sticky top) */}
          <div style={{ display: "flex", width: rowW, height: 24, position: "sticky", top: 0, zIndex: 4 }}>
            <div style={{ width: LABEL_W, flexShrink: 0, position: "sticky", left: 0, zIndex: 5, background: "var(--c-surface)", borderRight: "1px solid var(--c-border)", borderBottom: "1px solid var(--c-border)", fontSize: 10.5, color: "var(--c-text-dim)", padding: "5px 10px" }}>
              Tasks
            </div>
            <div style={{ width: trackW, flexShrink: 0, position: "relative", background: "var(--c-surface)", borderBottom: "1px solid var(--c-border)" }}>
              {ticks.map((t) => (
                <div key={t.ms} style={{ position: "absolute", left: pxOf(t.ms), top: 0, bottom: 0, borderLeft: `1px solid ${t.major ? "var(--c-border)" : "var(--c-surface2)"}`, paddingLeft: 4, fontSize: 9.5, color: t.major ? "var(--c-text)" : "var(--c-text-dim)", fontWeight: t.major ? 700 : 400, whiteSpace: "nowrap" }}>
                  {t.label}
                </div>
              ))}
              {showToday && <div style={{ position: "absolute", left: todayX, top: 0, bottom: 0, width: 2, background: "#e0a458" }} />}
            </div>
          </div>

          {/* sections + rows */}
          {sections.map((sec) => {
            if (sec.redundantHeader) return renderRow(sec.rows[0], false);
            const isCollapsed = collapsed.has(sec.key);
            return (
              <div key={sec.key}>
                <div style={{ display: "flex", width: rowW, background: "var(--c-surface)", borderBottom: "1px solid var(--c-border)" }}>
                  <button
                    onClick={() => toggle(sec.key)}
                    title={sec.title}
                    style={{ width: LABEL_W, flexShrink: 0, position: "sticky", left: 0, zIndex: 2, textAlign: "left", background: "var(--c-surface)", border: "none", borderRight: "1px solid var(--c-border)", color: "var(--c-text)", fontWeight: 700, fontSize: 11.5, padding: "5px 10px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}
                  >
                    <span style={{ display: "inline-block", flexShrink: 0, transform: isCollapsed ? "none" : "rotate(90deg)", transition: "transform 0.12s" }}>▸</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sec.title}</span>
                    <span style={{ color: "var(--c-text-dim)", fontWeight: 500 }}>({sec.rows.length})</span>
                  </button>
                  <div style={{ width: trackW, flexShrink: 0 }} />
                </div>
                {!isCollapsed && sec.rows.map((r) => renderRow(r, true))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
