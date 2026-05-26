import { useMemo, useRef, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { parseOrgDate, startOfDay } from "../utils/time";

// A horizontal calendar band across the top of the canvas. Shows a month axis,
// a "today" marker, light ticks for task dates, and user-placed milestone pins
// (double-click to add, drag to move, double-click the flag to rename, ✕ to
// remove). Milestones persist per file.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MILESTONE_COLOR = "#c678dd"; // violet

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Date window for the band: spans all relevant dates, snapped to whole months
 *  with a month of padding on each side (min ~3 months). */
function computeRange(dates: number[]): [number, number] {
  const today = startOfDay(new Date()).getTime();
  const all = dates.length ? [...dates, today] : [today];
  const min = new Date(Math.min(...all));
  const max = new Date(Math.max(...all));
  const start = new Date(min.getFullYear(), min.getMonth() - 1, 1).getTime();
  let end = new Date(max.getFullYear(), max.getMonth() + 2, 1).getTime();
  if (end - start < 60 * 86_400_000) end = start + 90 * 86_400_000; // ensure a readable span
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

export default function TimelineBand() {
  const doc = useOrgStore((s) => s.doc);
  const milestones = useOrgStore((s) => s.milestones);
  const addMilestone = useOrgStore((s) => s.addMilestone);
  const updateMilestone = useOrgStore((s) => s.updateMilestone);
  const removeMilestone = useOrgStore((s) => s.removeMilestone);

  const railRef = useRef<HTMLDivElement>(null);
  const dragId = useRef<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const nodeDates = useMemo(() => {
    const out: { ms: number; deadline: boolean }[] = [];
    for (const n of doc?.nodes ?? []) {
      if (n.done) continue;
      const s = parseOrgDate(n.scheduled);
      if (s) out.push({ ms: startOfDay(s).getTime(), deadline: false });
      const d = parseOrgDate(n.deadline);
      if (d) out.push({ ms: startOfDay(d).getTime(), deadline: true });
    }
    return out;
  }, [doc]);

  const [startMs, endMs] = useMemo(() => {
    const ms: number[] = [...nodeDates.map((d) => d.ms)];
    for (const m of milestones) {
      const p = parseOrgDate(m.iso);
      if (p) ms.push(startOfDay(p).getTime());
    }
    return computeRange(ms);
  }, [nodeDates, milestones]);

  const span = Math.max(1, endMs - startMs);
  const pct = (ms: number) => ((ms - startMs) / span) * 100;
  const todayMs = startOfDay(new Date()).getTime();
  const months = monthStarts(startMs, endMs);

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
    else removeMilestone(id); // empty label → discard (e.g. just-added then cancelled)
    setEditing(null);
  };

  const onBandDoubleClick = (e: React.MouseEvent) => {
    const id = addMilestone(isoOf(dateAtClientX(e.clientX)), "");
    beginEdit(id, "");
  };

  const onPinDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    if (editing) return;
    dragId.current = id;
    const move = (ev: PointerEvent) => updateMilestone(id, { iso: isoOf(dateAtClientX(ev.clientX)) });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      dragId.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      ref={railRef}
      onDoubleClick={onBandDoubleClick}
      title="Double-click to add a milestone"
      style={{
        position: "relative",
        height: "100%",
        background: "var(--c-surface)",
        borderBottom: "1px solid var(--c-border)",
        overflow: "hidden",
        userSelect: "none",
      }}
    >
      <div style={{ position: "absolute", top: 6, left: 10, fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: "var(--c-text-dim)", pointerEvents: "none" }}>
        Milestones
      </div>

      {/* Month gridlines + labels */}
      {months.map((m) => {
        const left = pct(m.getTime());
        if (left < -2 || left > 102) return null;
        return (
          <div key={m.getTime()}>
            <div style={{ position: "absolute", left: `${left}%`, top: 0, bottom: 18, width: 1, background: "var(--c-border)", opacity: 0.5 }} />
            <div style={{ position: "absolute", left: `${left}%`, bottom: 2, transform: "translateX(3px)", fontSize: 10, color: "var(--c-text-dim)", whiteSpace: "nowrap" }}>
              {MONTHS[m.getMonth()]}
              {m.getMonth() === 0 ? ` ${m.getFullYear()}` : ""}
            </div>
          </div>
        );
      })}

      {/* Task-date ticks (context) */}
      {nodeDates.map((d, i) => (
        <div
          key={i}
          style={{ position: "absolute", left: `${pct(d.ms)}%`, bottom: 20, width: 5, height: 5, marginLeft: -2.5, borderRadius: 3, background: d.deadline ? "#ff6c6b" : "#51afef", opacity: 0.7 }}
        />
      ))}

      {/* Today marker */}
      {todayMs >= startMs && todayMs <= endMs && (
        <>
          <div style={{ position: "absolute", left: `${pct(todayMs)}%`, top: 0, bottom: 18, width: 2, marginLeft: -1, background: "#e0a458" }} />
          <div style={{ position: "absolute", left: `${pct(todayMs)}%`, top: 4, transform: "translateX(4px)", fontSize: 9, color: "#e0a458", fontWeight: 700 }}>TODAY</div>
        </>
      )}

      {/* Milestone pins */}
      {milestones.map((m) => {
        const d = parseOrgDate(m.iso);
        if (!d) return null;
        const left = pct(startOfDay(d).getTime());
        const isEditing = editing === m.id;
        return (
          <div key={m.id} style={{ position: "absolute", left: `${left}%`, top: 22, bottom: 18, width: 0 }}>
            {/* stem */}
            <div style={{ position: "absolute", top: 18, bottom: 0, left: 0, width: 2, marginLeft: -1, background: MILESTONE_COLOR, opacity: 0.8 }} />
            {/* flag */}
            <div
              onPointerDown={(e) => onPinDown(e, m.id)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                beginEdit(m.id, m.label);
              }}
              title={`${m.label} · ${m.iso} (drag to move, double-click to rename)`}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                transform: "translateX(-50%)",
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "1px 5px",
                background: MILESTONE_COLOR,
                color: "#1c1c1e",
                borderRadius: 4,
                fontSize: 10.5,
                fontWeight: 700,
                whiteSpace: "nowrap",
                cursor: dragId.current === m.id ? "grabbing" : "grab",
                boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
              }}
            >
              <span>⚑</span>
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
            {/* date label under the flag */}
            <div style={{ position: "absolute", top: 18, left: 0, transform: "translateX(-50%)", fontSize: 8.5, color: MILESTONE_COLOR, whiteSpace: "nowrap" }}>
              {d.getDate()} {MONTHS[d.getMonth()]}
            </div>
          </div>
        );
      })}

      {milestones.length === 0 && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--c-text-dim)", fontSize: 12, pointerEvents: "none" }}>
          Double-click anywhere on this band to add a milestone date
        </div>
      )}
    </div>
  );
}
