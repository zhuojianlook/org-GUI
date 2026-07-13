import { useEffect, useMemo, useRef, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { buildScheduleTree, type TreeRow } from "../utils/scheduleItems";
import { startOfDay } from "../utils/time";
import { hexToRgba } from "../utils/tagColor";

// Asana / MS-Project-style HIERARCHICAL swimlane timeline. The rows mirror the
// org outline: an ancestor that contains scheduled descendants is a collapsible
// GROUP with a faint roll-up bar spanning its descendants; a scheduled task is a
// solid bar; same-title sibling leaves (a recurring "Lab Meeting") collapse into
// one row with an occurrence pill each. Pixel-based + horizontally scrollable so
// bars stay readable at any zoom.
//
//  • Right-click a bar to ARCHIVE that task (offers to delete from Google too,
//    so the archive survives the next sync).
//  • "Today" / changing zoom re-centres on today.

const DAY_MS = 86_400_000;
const LABEL_W = 220;
const ROW_H = 26;
const INDENT = 15;
const MIN_BAR = 16;
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
  const archive = useOrgStore((s) => s.archive);
  const [zoom, setZoom] = useState<Zoom>(() => {
    try {
      const saved = localStorage.getItem("org-gui:ganttZoom");
      if (saved && ZOOMS.some((z) => z.id === saved)) return saved as Zoom;
    } catch {}
    return "1m";
  });
  useEffect(() => {
    try {
      localStorage.setItem("org-gui:ganttZoom", zoom);
    } catch {}
  }, [zoom]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  const pxPerDay = ZOOMS.find((z) => z.id === zoom)!.pxPerDay;
  const tree = useMemo(() => buildScheduleTree(doc, tagColors), [doc, tagColors]);

  // Flatten the tree into the visible rows, skipping subtrees under a collapsed
  // group. Depth drives the rail indentation.
  const flat = useMemo(() => {
    const out: { row: TreeRow; depth: number }[] = [];
    const walk = (rows: TreeRow[], depth: number) => {
      for (const r of rows) {
        out.push({ row: r, depth });
        if (r.isGroup && !collapsed.has(r.key)) walk(r.children, depth + 1);
      }
    };
    walk(tree, 0);
    return out;
  }, [tree, collapsed]);

  const { rangeStart, totalDays } = useMemo(() => {
    if (tree.length === 0) {
      const t = startOfDay(new Date()).getTime();
      return { rangeStart: t - 7 * DAY_MS, totalDays: 35 };
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of tree) {
      lo = Math.min(lo, r.rollupStart);
      hi = Math.max(hi, r.rollupEnd);
    }
    const start = lo - 3 * DAY_MS;
    const days = Math.round((hi + 4 * DAY_MS - start) / DAY_MS);
    return { rangeStart: start, totalDays: Math.max(7, days) };
  }, [tree]);

  const trackW = totalDays * pxPerDay;
  const pxOf = (ms: number) => ((ms - rangeStart) / DAY_MS) * pxPerDay;
  const rowW = LABEL_W + trackW;
  const todayMs = startOfDay(new Date()).getTime();
  const todayX = pxOf(todayMs);
  const showToday = todayX >= 0 && todayX <= trackW;

  // Subtle weekend columns (same planning texture as the band). One repeating
  // gradient per row track — aligned to the first Saturday — instead of
  // hundreds of per-day divs.
  const satOffsetDays = (6 - new Date(rangeStart).getDay() + 7) % 7;
  const weekendBg: React.CSSProperties =
    pxPerDay >= 6
      ? {
          backgroundImage: `repeating-linear-gradient(90deg, rgba(148,158,178,0.05) 0px, rgba(148,158,178,0.05) ${2 * pxPerDay}px, transparent ${2 * pxPerDay}px, transparent ${7 * pxPerDay}px)`,
          backgroundPosition: `${satOffsetDays * pxPerDay}px 0`,
        }
      : {};
  const shortDate = (ms: number) => {
    const d = new Date(ms);
    return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  };

  const goToToday = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, LABEL_W + todayX - el.clientWidth / 2);
  };
  useEffect(() => {
    goToToday();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, tree.length]);

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

  const renderRow = (row: TreeRow, depth: number) => {
    const sel =
      row.node.id === selectedId || row.occurrences.some((it) => it.nodeId === selectedId);
    const pad = Math.min(10 + depth * INDENT, LABEL_W - 50);
    const single = row.occurrences.length === 1;
    return (
      <div key={row.key} style={{ display: "flex", width: rowW, height: ROW_H, borderBottom: "1px solid var(--c-surface2)" }}>
        <button
          onClick={() => (row.isGroup ? toggle(row.key) : select(row.node.id))}
          title={row.title + (row.occurrences.length > 1 ? ` (${row.occurrences.length}×)` : "")}
          style={{ width: LABEL_W, flexShrink: 0, position: "sticky", left: 0, zIndex: 2, textAlign: "left", background: sel ? "var(--c-surface2)" : row.isGroup ? "var(--c-surface)" : "var(--c-bg)", border: "none", borderRight: "1px solid var(--c-border)", color: "var(--c-text)", fontWeight: row.isGroup ? 700 : 400, fontSize: row.isGroup ? 11.5 : 11, padding: `0 8px 0 ${pad}px`, cursor: "pointer", display: "flex", alignItems: "center", gap: 5, overflow: "hidden" }}
        >
          {row.isGroup && (
            <span style={{ flexShrink: 0, display: "inline-block", transform: collapsed.has(row.key) ? "none" : "rotate(90deg)", transition: "transform 0.12s" }}>▸</span>
          )}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.title}</span>
          {row.occurrences.length > 1 && <span style={{ color: "var(--c-text-dim)", flexShrink: 0 }}>×{row.occurrences.length}</span>}
          {/* Right-aligned start date on leaf rows — lets the outline rail be
              scanned as a dated task list without chasing each bar. */}
          {!row.isGroup && (
            <span style={{ marginLeft: "auto", flexShrink: 0, fontSize: 9.5, color: "var(--c-text-dim)", fontVariantNumeric: "tabular-nums" }}>
              {shortDate(row.rollupStart)}
            </span>
          )}
        </button>
        <div style={{ width: trackW, flexShrink: 0, position: "relative", ...weekendBg }}>
          {showToday && <div style={{ position: "absolute", left: todayX, top: 0, bottom: 0, width: 1, background: "rgba(224,164,88,0.4)" }} />}
          {row.isGroup ? (
            // Roll-up: faint dashed span over the group's scheduled descendants.
            (() => {
              const left = pxOf(row.rollupStart);
              const width = Math.max(MIN_BAR, pxOf(row.rollupEnd + DAY_MS) - left);
              return (
                <button
                  onClick={() => select(row.node.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    void archive(row.node);
                  }}
                  title={`${row.title} (group)\nClick to select · right-click to archive the whole subtree`}
                  style={{ position: "absolute", left, width, top: 9, height: 8, background: hexToRgba(row.color, 0.18), border: `1px dashed ${row.color}`, borderRadius: 5, cursor: "pointer", padding: 0 }}
                />
              );
            })()
          ) : (
            <>
              {row.occurrences.map((it) => {
                const left = pxOf(it.dayMs);
                const width = Math.max(MIN_BAR, pxOf(it.endDayMs + DAY_MS) - left);
                const isSel = it.nodeId === selectedId;
                // Put the information ON the bar whenever it fits: time-of-day
                // + ⚑ for deadlines + the title (single rows) or the date
                // (recurring pills, so each occurrence is identifiable). Bars
                // too narrow for text fall back to the flowing label below /
                // the tooltip.
                const inBarText = width >= 56;
                const prefix = `${it.kind === "deadline" ? "⚑ " : ""}${it.timeOfDay ? it.timeOfDay + " " : ""}${it.done ? "✓ " : ""}`;
                return (
                  <button
                    key={it.nodeId}
                    onClick={() => select(it.nodeId)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      void archive(it.node);
                    }}
                    title={`${it.kind === "deadline" ? "⚑ Deadline" : it.kind === "scheduled" ? "⏱ Scheduled" : "🗓 Event"}: ${it.title}\n${shortDate(it.dayMs)}${it.endDayMs > it.dayMs ? " → " + shortDate(it.endDayMs) : ""}${it.timeOfDay ? " @ " + it.timeOfDay + (it.timeOfDayEnd ? "–" + it.timeOfDayEnd : "") : ""}${it.done ? " (done)" : ""}\nClick to select · right-click to archive`}
                    style={{ position: "absolute", left, width, top: 4, height: ROW_H - 9, background: hexToRgba(it.color, isSel ? 0.9 : 0.62), border: isSel ? "1px solid #ffd166" : `1px solid ${it.color}`, borderRadius: 9, cursor: "pointer", overflow: "hidden", padding: inBarText ? "0 7px" : 0, opacity: it.done ? 0.55 : 1, display: "flex", alignItems: "center", justifyContent: "flex-start" }}
                  >
                    {inBarText && (
                      <span style={{ fontSize: 10, fontWeight: 700, color: "var(--c-text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textShadow: "0 1px 2px rgba(0,0,0,0.7)", textDecoration: it.done ? "line-through" : "none" }}>
                        {prefix}
                        {single ? row.title : shortDate(it.dayMs)}
                      </span>
                    )}
                  </button>
                );
              })}
              {/* Flowing label beside the bar — only when the bar itself was
                  too narrow to carry the text (kept out of the bar's hit area). */}
              {single && Math.max(MIN_BAR, pxOf(row.occurrences[0].endDayMs + DAY_MS) - pxOf(row.occurrences[0].dayMs)) < 56 && (
                <span
                  style={{ position: "absolute", left: pxOf(row.occurrences[0].endDayMs + DAY_MS) + 5, top: 6, maxWidth: trackW, fontSize: 10.5, fontWeight: 600, color: "var(--c-text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", pointerEvents: "none", textShadow: "0 1px 2px rgba(0,0,0,0.7)", textDecoration: row.occurrences[0].done ? "line-through" : "none" }}
                >
                  {row.occurrences[0].priority && <span style={{ color: "#ffd166", fontWeight: 800, marginRight: 3 }}>[{row.occurrences[0].priority}]</span>}
                  {row.occurrences[0].kind === "deadline" ? "⚑ " : ""}
                  {row.occurrences[0].timeOfDay ? row.occurrences[0].timeOfDay + " " : ""}
                  {row.title}
                </span>
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, background: "var(--c-bg)" }}>
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
        <button
          onClick={goToToday}
          title="Scroll to today at the current zoom"
          style={{ background: "var(--c-surface2)", color: "var(--c-text)", border: "1px solid var(--c-border)", borderRadius: 6, padding: "2px 10px", fontSize: 11.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
        >
          ⊙ Today
        </button>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: "var(--c-text-dim)" }}>right-click a bar to archive</span>
      </div>

      {flat.length === 0 ? (
        <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--c-text-dim)", fontSize: 14, padding: 24, textAlign: "center" }}>
          No dated tasks yet — give a task a SCHEDULED / DEADLINE / timestamp to see it on the timeline.
        </div>
      ) : (
        <div ref={scrollRef} style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
          <div style={{ display: "flex", width: rowW, height: 24, position: "sticky", top: 0, zIndex: 4 }}>
            <div style={{ width: LABEL_W, flexShrink: 0, position: "sticky", left: 0, zIndex: 5, background: "var(--c-surface)", borderRight: "1px solid var(--c-border)", borderBottom: "1px solid var(--c-border)", fontSize: 10.5, color: "var(--c-text-dim)", padding: "5px 10px" }}>
              Outline
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
          {flat.map(({ row, depth }) => renderRow(row, depth))}
        </div>
      )}
    </div>
  );
}
