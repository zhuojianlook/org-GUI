import { useMemo } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { parseOrgDate, startOfDay } from "../utils/time";
import type { OrgDoc, OrgNode } from "../api/org";
import { levelColor } from "./OrgNode";

// A read-only "org agenda" built from the loaded document: every not-done entry
// that carries a SCHEDULED / DEADLINE / plain timestamp, grouped by day
// (Overdue, Today, then upcoming dates), plus undated TODOs at the bottom.

type Kind = "deadline" | "scheduled" | "timestamp";
interface Item {
  node: OrgNode;
  date: Date;
  iso: string;
  kind: Kind;
  hasTime: boolean;
}

const MS_DAY = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const KIND_META: Record<Kind, { icon: string; color: string; label: string }> = {
  deadline: { icon: "⚑", color: "#ff6c6b", label: "Deadline" },
  scheduled: { icon: "⏱", color: "#51afef", label: "Scheduled" },
  timestamp: { icon: "◷", color: "#5fb3a1", label: "Timestamp" },
};

function timeOf(iso: string): string {
  return iso.includes("T") ? iso.slice(11, 16) : "";
}

function dayLabel(dayMs: number, todayMs: number): string {
  const diff = Math.round((dayMs - todayMs) / MS_DAY);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  const d = new Date(dayMs);
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

interface DayGroup {
  dayMs: number;
  items: Item[];
}

function buildAgenda(doc: OrgDoc | null) {
  const dated: Item[] = [];
  const unscheduled: OrgNode[] = [];
  if (doc) {
    for (const n of doc.nodes) {
      if (n.done) continue;
      let any = false;
      const push = (iso: string | null, kind: Kind) => {
        const dt = parseOrgDate(iso);
        if (dt && iso) {
          dated.push({ node: n, date: dt, iso, kind, hasTime: iso.includes("T") });
          any = true;
        }
      };
      push(n.deadline, "deadline");
      push(n.scheduled, "scheduled");
      if (!n.scheduled && !n.deadline) push(n.timestamp, "timestamp");
      if (!any && n.todo) unscheduled.push(n);
    }
  }
  dated.sort((a, b) => a.date.getTime() - b.date.getTime() || a.kind.localeCompare(b.kind));

  const todayMs = startOfDay(new Date()).getTime();
  const overdue: Item[] = [];
  const byDay = new Map<number, Item[]>();
  for (const it of dated) {
    const dayMs = startOfDay(it.date).getTime();
    if (dayMs < todayMs) overdue.push(it);
    else (byDay.get(dayMs) ?? byDay.set(dayMs, []).get(dayMs)!).push(it);
  }
  const days: DayGroup[] = [...byDay.keys()].sort((a, b) => a - b).map((dayMs) => ({ dayMs, items: byDay.get(dayMs)! }));
  return { overdue, days, unscheduled, todayMs };
}

export default function AgendaPanel() {
  const doc = useOrgStore((s) => s.doc);
  const select = useOrgStore((s) => s.select);
  const selectedId = useOrgStore((s) => s.selectedId);
  const editInEmacs = useOrgStore((s) => s.editInEmacs);

  const { overdue, days, unscheduled, todayMs } = useMemo(() => buildAgenda(doc), [doc]);

  const Row = ({ it, overdueRow }: { it: Item; overdueRow?: boolean }) => {
    const n = it.node;
    const meta = KIND_META[it.kind];
    const t = timeOf(it.iso);
    const daysOver = overdueRow ? Math.round((todayMs - startOfDay(it.date).getTime()) / MS_DAY) : 0;
    return (
      <div
        onClick={() => select(n.id)}
        onDoubleClick={() => editInEmacs(n)}
        title="Click to select · double-click to edit in Emacs"
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 10,
          padding: "5px 10px",
          borderRadius: 6,
          cursor: "pointer",
          background: n.id === selectedId ? "var(--c-surface2)" : "transparent",
          borderLeft: `3px solid ${meta.color}`,
        }}
      >
        <span style={{ width: 44, flexShrink: 0, fontSize: 11, color: "var(--c-text-dim)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
          {t || (overdueRow ? `−${daysOver}d` : "")}
        </span>
        <span style={{ color: meta.color, flexShrink: 0 }} title={meta.label}>
          {meta.icon}
        </span>
        {n.todo && (
          <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, color: n.done ? "#98be65" : "#ff6c6b" }}>{n.todo}</span>
        )}
        {n.priority && <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, color: "#da8548" }}>[#{n.priority}]</span>}
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: levelColor(n.level) }}>
          {n.title ?? "(untitled)"}
        </span>
        {n.tagsAll?.length > 0 && (
          <span style={{ flexShrink: 0, fontSize: 10, color: "#83898d" }}>:{n.tagsAll.join(":")}:</span>
        )}
      </div>
    );
  };

  const Header = ({ children, accent }: { children: React.ReactNode; accent?: string }) => (
    <div
      style={{
        fontSize: 12,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        color: accent ?? "var(--c-text)",
        padding: "12px 10px 4px",
        borderBottom: "1px solid var(--c-border)",
        marginBottom: 2,
      }}
    >
      {children}
    </div>
  );

  const empty = overdue.length === 0 && days.length === 0 && unscheduled.length === 0;

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "8px 16px 24px", background: "var(--c-bg)" }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <div style={{ fontSize: 18, fontWeight: 700, padding: "8px 10px", color: "var(--c-text)" }}>
          Agenda {doc?.title ? <span style={{ fontSize: 13, fontWeight: 400, color: "var(--c-text-dim)" }}>· {doc.title}</span> : null}
        </div>

        {empty && <div style={{ padding: 24, color: "var(--c-text-dim)", textAlign: "center" }}>Nothing scheduled. Add SCHEDULED or DEADLINE dates to see them here.</div>}

        {overdue.length > 0 && (
          <section>
            <Header accent="#ff6c6b">Overdue ({overdue.length})</Header>
            {overdue.map((it, i) => (
              <Row key={i} it={it} overdueRow />
            ))}
          </section>
        )}

        {days.map((g) => (
          <section key={g.dayMs}>
            <Header accent={g.dayMs === todayMs ? "#e0a458" : undefined}>{dayLabel(g.dayMs, todayMs)}</Header>
            {g.items.map((it, i) => (
              <Row key={i} it={it} />
            ))}
          </section>
        ))}

        {unscheduled.length > 0 && (
          <section>
            <Header accent="var(--c-text-dim)">Unscheduled TODOs ({unscheduled.length})</Header>
            {unscheduled.map((n) => (
              <div
                key={n.id}
                onClick={() => select(n.id)}
                onDoubleClick={() => editInEmacs(n)}
                title="Click to select · double-click to edit in Emacs"
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 10,
                  padding: "5px 10px",
                  borderRadius: 6,
                  cursor: "pointer",
                  background: n.id === selectedId ? "var(--c-surface2)" : "transparent",
                  borderLeft: "3px solid var(--c-border)",
                }}
              >
                <span style={{ width: 44, flexShrink: 0 }} />
                {n.todo && <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, color: "#ff6c6b" }}>{n.todo}</span>}
                {n.priority && <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, color: "#da8548" }}>[#{n.priority}]</span>}
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: levelColor(n.level) }}>
                  {n.title ?? "(untitled)"}
                </span>
                {n.tagsAll?.length > 0 && <span style={{ flexShrink: 0, fontSize: 10, color: "#83898d" }}>:{n.tagsAll.join(":")}:</span>}
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
