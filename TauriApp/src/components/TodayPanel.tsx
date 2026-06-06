import { useMemo, useRef, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { parseOrgDate, startOfDay } from "../utils/time";
import type { OrgNode } from "../api/org";

const MS_DAY = 86_400_000;

function todayIso(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(
    t.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * "Today" panel — a focused view of what needs attention now.
 *
 *  - Drag a node from the canvas onto the drop zone to SCHEDULE it for today
 *    (detected in TimelineGraph.onNodeDragStop via `data-today-dropzone`).
 *  - Each row has an × to UNSCHEDULE it (clears SCHEDULED).
 *  - Overdue rows show how many days late they are, and can be DRAGGED onto the
 *    "Scheduled today" section to reschedule them to today.
 *
 * The in-panel drag uses POINTER events (not HTML5 drag-and-drop): the Tauri
 * webview intercepts native drag-drop at the OS level, so ondragover/ondrop
 * never fire — the rest of the app drags with pointer events for the same
 * reason.
 */
export default function TodayPanel() {
  const doc = useOrgStore((s) => s.doc);
  const select = useOrgStore((s) => s.select);
  const flashNode = useOrgStore((s) => s.flashNode);
  const scheduleNode = useOrgStore((s) => s.scheduleNode);
  const dropActive = useOrgStore((s) => s.todayDropActive);

  // Bounding box of the "Scheduled today" section, used as the drop target.
  const schedRef = useRef<HTMLDivElement>(null);
  // Set once a drag passes the movement threshold; drives the floating chip and
  // reveals the drop area even when it's empty. `over` = cursor inside it.
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; title: string; over: boolean } | null>(null);
  // True for the instant after a drag so the row's click (focus) is suppressed.
  const justDraggedRef = useRef(false);

  const { overdue, scheduledToday, dueToday } = useMemo(() => {
    const todayMs = startOfDay(new Date()).getTime();
    const tomorrowMs = todayMs + MS_DAY;
    const dayMs = (iso: string | null | undefined): number | null => {
      const d = parseOrgDate(iso);
      return d ? startOfDay(d).getTime() : null;
    };
    const overdue: { n: OrgNode; days: number }[] = [];
    const scheduledToday: OrgNode[] = [];
    const dueToday: OrgNode[] = [];
    for (const n of doc?.nodes ?? []) {
      if (n.done || !n.todo) continue;
      const sMs = dayMs(n.scheduled);
      const dMs = dayMs(n.deadline);
      const pastMs = [sMs, dMs].filter((m): m is number => m != null && m < todayMs);
      if (pastMs.length) {
        const days = Math.round((todayMs - Math.min(...pastMs)) / MS_DAY);
        overdue.push({ n, days });
        continue;
      }
      if (sMs != null && sMs >= todayMs && sMs < tomorrowMs) scheduledToday.push(n);
      if (dMs != null && dMs >= todayMs && dMs < tomorrowMs) dueToday.push(n);
    }
    overdue.sort((a, b) => b.days - a.days);
    return { overdue, scheduledToday, dueToday };
  }, [doc]);

  const focus = (id: string) => {
    select(id);
    flashNode(id);
    window.dispatchEvent(new CustomEvent("orggui:focusNode", { detail: { id } }));
  };

  // Pointer-drag an overdue row. On release over the "Scheduled today" box,
  // reschedule the task to today.
  const startOverdueDrag = (e: React.PointerEvent, n: OrgNode) => {
    if (e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    const overSched = (x: number, y: number) => {
      const r = schedRef.current?.getBoundingClientRect();
      return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 5) moved = true;
      if (moved) {
        setDrag({ id: n.id, x: ev.clientX, y: ev.clientY, title: n.title ?? "(untitled)", over: overSched(ev.clientX, ev.clientY) });
      }
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (moved) {
        justDraggedRef.current = true;
        if (overSched(ev.clientX, ev.clientY)) void scheduleNode(n, todayIso(), "scheduled");
      }
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const total = overdue.length + scheduledToday.length + dueToday.length;

  const Row = ({
    n,
    overdueDays,
    draggable,
  }: {
    n: OrgNode;
    overdueDays?: number;
    draggable?: boolean;
  }) => {
    const started = n.todo === "STRT";
    return (
      <div
        role="button"
        tabIndex={0}
        onPointerDown={draggable ? (e) => startOverdueDrag(e, n) : undefined}
        onClick={() => {
          if (justDraggedRef.current) {
            justDraggedRef.current = false;
            return;
          }
          focus(n.id);
        }}
        title={
          draggable
            ? "Drag onto 'Scheduled today' to reschedule · click to find on canvas"
            : "Click to find this task on the canvas"
        }
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          width: "100%",
          textAlign: "left",
          background: "var(--c-bg)",
          border: "1px solid var(--c-border)",
          borderRadius: 6,
          padding: "6px 8px",
          cursor: draggable ? "grab" : "pointer",
          color: "var(--c-text)",
          fontSize: 12.5,
          boxSizing: "border-box",
          userSelect: "none",
        }}
      >
        <span
          aria-hidden
          style={{ color: started ? "#98be65" : "#e0a458", fontSize: 11, flexShrink: 0 }}
        >
          {started ? "▶" : "○"}
        </span>
        <span
          style={{
            fontWeight: 700,
            fontSize: 10,
            color: "var(--c-text-dim)",
            flexShrink: 0,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {n.todo}
        </span>
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {n.title ?? "(untitled)"}
        </span>
        {overdueDays != null && (
          <span
            style={{
              flexShrink: 0,
              fontSize: 10,
              fontWeight: 700,
              color: "#ff5f56",
              background: "color-mix(in srgb, #ff5f56 16%, transparent)",
              border: "1px solid color-mix(in srgb, #ff5f56 45%, transparent)",
              borderRadius: 8,
              padding: "0 5px",
              whiteSpace: "nowrap",
            }}
          >
            {overdueDays}d overdue
          </span>
        )}
        {/* × — unschedule (clear SCHEDULED) so it leaves the Today view. */}
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            void scheduleNode(n, "", "scheduled");
          }}
          title="Unschedule (remove its scheduled date)"
          style={{
            flexShrink: 0,
            width: 18,
            height: 18,
            lineHeight: "16px",
            textAlign: "center",
            borderRadius: 4,
            border: "1px solid var(--c-border)",
            background: "transparent",
            color: "var(--c-text-dim)",
            cursor: "pointer",
            fontSize: 13,
            padding: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "color-mix(in srgb, #ff5f56 22%, transparent)";
            e.currentTarget.style.color = "#ff5f56";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--c-text-dim)";
          }}
        >
          ×
        </button>
      </div>
    );
  };

  const SectionHeader = ({ title, color, count }: { title: string; color: string; count: number }) => (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.4,
        textTransform: "uppercase",
        color,
      }}
    >
      {title} ({count})
    </div>
  );

  return (
    <div
      data-today-panel
      style={{
        width: 340,
        flexShrink: 0,
        background: "var(--c-surface)",
        borderLeft: "1px solid var(--c-border)",
        padding: 16,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div>
        <div style={{ fontWeight: 700, fontSize: 15 }}>📅 Today</div>
        <div style={{ color: "var(--c-text-dim)", fontSize: 12, marginTop: 2 }}>
          {new Date().toLocaleDateString(undefined, {
            weekday: "long",
            month: "short",
            day: "numeric",
          })}
        </div>
      </div>

      {/* Drop target — drag a node from the canvas and release here to schedule
          it for today (handled in TimelineGraph.onNodeDragStop). */}
      <div
        data-today-dropzone
        style={{
          border: `2px dashed var(--c-accent)`,
          borderRadius: 8,
          padding: "14px 12px",
          textAlign: "center",
          color: dropActive ? "var(--c-text)" : "var(--c-text-dim)",
          fontSize: 12,
          background: dropActive
            ? "color-mix(in srgb, var(--c-accent) 28%, transparent)"
            : "color-mix(in srgb, var(--c-accent) 8%, transparent)",
          boxShadow: dropActive ? "0 0 0 3px color-mix(in srgb, var(--c-accent) 35%, transparent)" : "none",
          transform: dropActive ? "scale(1.02)" : "none",
          transition: "background 0.1s, box-shadow 0.1s, transform 0.1s, color 0.1s",
          lineHeight: 1.4,
        }}
      >
        {dropActive ? (
          <span style={{ fontWeight: 700 }}>⤵ Release to schedule for today</span>
        ) : (
          <>
            ⬇ Drag a task from the canvas here
            <br />
            to schedule it for <b style={{ color: "var(--c-text)" }}>today</b>
          </>
        )}
      </div>

      {total === 0 ? (
        <div style={{ color: "var(--c-text-dim)", fontSize: 12.5, textAlign: "center", marginTop: 8 }}>
          Nothing scheduled or due today, and nothing overdue. 🎉
        </div>
      ) : (
        <>
          {overdue.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <SectionHeader title="Overdue" color="#ff5f56" count={overdue.length} />
              {overdue.map(({ n, days }) => (
                <Row key={n.id} n={n} overdueDays={days} draggable />
              ))}
            </div>
          )}

          {/* "Scheduled today" — also the DROP TARGET for overdue rows. Rendered
              even when empty while a drag is in progress so there's always
              somewhere to drop. */}
          {(scheduledToday.length > 0 || drag != null) && (
            <div
              ref={schedRef}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                borderRadius: 8,
                padding: drag?.over ? 6 : 0,
                margin: drag?.over ? -6 : 0,
                background: drag?.over
                  ? "color-mix(in srgb, #e0a458 18%, transparent)"
                  : "transparent",
                boxShadow: drag?.over ? "0 0 0 2px color-mix(in srgb, #e0a458 60%, transparent)" : "none",
                transition: "background 0.1s, box-shadow 0.1s",
              }}
            >
              <SectionHeader title="Scheduled today" color="#e0a458" count={scheduledToday.length} />
              {scheduledToday.map((n) => (
                <Row key={n.id} n={n} />
              ))}
              {drag != null && (
                <div
                  style={{
                    border: "1.5px dashed color-mix(in srgb, #e0a458 70%, transparent)",
                    borderRadius: 6,
                    padding: "8px",
                    textAlign: "center",
                    fontSize: 11,
                    color: drag.over ? "var(--c-text)" : "var(--c-text-dim)",
                  }}
                >
                  ⤵ Drop here to reschedule to today
                </div>
              )}
            </div>
          )}

          {dueToday.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <SectionHeader title="Due today" color="#5fb3a1" count={dueToday.length} />
              {dueToday.map((n) => (
                <Row key={n.id} n={n} />
              ))}
            </div>
          )}
        </>
      )}

      {/* Floating chip that follows the cursor while dragging an overdue row. */}
      {drag != null && (
        <div
          style={{
            position: "fixed",
            left: drag.x + 12,
            top: drag.y + 8,
            zIndex: 10060,
            pointerEvents: "none",
            maxWidth: 220,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            background: "var(--c-surface)",
            border: `1px solid ${drag.over ? "#e0a458" : "var(--c-border)"}`,
            borderRadius: 6,
            padding: "4px 8px",
            fontSize: 12,
            color: "var(--c-text)",
            boxShadow: "0 4px 14px rgba(0,0,0,0.5)",
          }}
        >
          {drag.over ? "⤵ " : "↦ "}
          {drag.title}
        </div>
      )}
    </div>
  );
}
