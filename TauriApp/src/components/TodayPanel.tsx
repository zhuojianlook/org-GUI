import { useMemo } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { parseOrgDate, startOfDay } from "../utils/time";
import type { OrgNode } from "../api/org";

const MS_DAY = 86_400_000;

/**
 * "Today" panel — a focused view of what needs attention now, plus a drop
 * target for scheduling. Drag any node from the canvas onto the drop zone and
 * release to set its SCHEDULED date to today (the drop is detected in
 * TimelineGraph's onNodeDragStop via the `data-today-dropzone` marker).
 *
 * Lists overdue tasks (red), tasks scheduled for today (orange = not started,
 * green = started), and tasks due today — mirroring the canvas node flash.
 */
export default function TodayPanel() {
  const doc = useOrgStore((s) => s.doc);
  const select = useOrgStore((s) => s.select);
  const flashNode = useOrgStore((s) => s.flashNode);
  const dropActive = useOrgStore((s) => s.todayDropActive);

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

  const total = overdue.length + scheduledToday.length + dueToday.length;

  const Row = ({ n, suffix }: { n: OrgNode; suffix?: string }) => {
    const started = n.todo === "STRT";
    return (
      <button
        onClick={() => focus(n.id)}
        title="Click to find this task on the canvas"
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
          cursor: "pointer",
          color: "var(--c-text)",
          fontSize: 12.5,
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
        {suffix && (
          <span style={{ fontSize: 10, color: "var(--c-text-dim)", flexShrink: 0 }}>{suffix}</span>
        )}
      </button>
    );
  };

  const Section = ({
    title,
    color,
    children,
    count,
  }: {
    title: string;
    color: string;
    count: number;
    children: React.ReactNode;
  }) => {
    if (count === 0) return null;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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
        {children}
      </div>
    );
  };

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
          <Section title="Overdue" color="#ff5f56" count={overdue.length}>
            {overdue.map(({ n, days }) => (
              <Row key={n.id} n={n} suffix={`${days}d`} />
            ))}
          </Section>
          <Section title="Scheduled today" color="#e0a458" count={scheduledToday.length}>
            {scheduledToday.map((n) => (
              <Row key={n.id} n={n} />
            ))}
          </Section>
          <Section title="Due today" color="#5fb3a1" count={dueToday.length}>
            {dueToday.map((n) => (
              <Row key={n.id} n={n} suffix="due" />
            ))}
          </Section>
        </>
      )}
    </div>
  );
}
