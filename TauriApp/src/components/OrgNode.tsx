import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useOrgStore } from "../store/useOrgStore";
import { setTodo, incompleteDeps, type OrgNode as OrgNodeT } from "../api/org";
import type { OrgNodeView } from "../utils/layout";
import { parseOrgDate, startOfDay } from "../utils/time";
import { findTableBlocks } from "../utils/orgTable";
import TableEditor from "./TableEditor";

const LEVEL_COLORS = [
  "#51afef", // 1 blue
  "#a9a1e1", // 2 violet
  "#98be65", // 3 green
  "#da8548", // 4 orange
  "#5fb3a1", // 5 teal
  "#c678dd", // 6 magenta
];

export function levelColor(level: number): string {
  return LEVEL_COLORS[(Math.max(1, level) - 1) % LEVEL_COLORS.length];
}

const C_STARS = "#5B6268";
const C_TODO = "#ff6c6b";
const C_DONE = "#98be65";
const C_PRIORITY = "#da8548";
const C_TAG = "#83898d";
const C_COOKIE = "#5fb3a1";
const C_STAMP = "#5fb3a1";
const C_SCHEDULED = "#51afef";
const C_DEADLINE = "#ff6c6b";

interface Span {
  t: string;
  c?: string;
  b?: boolean;
}

function fontifyHeadline(raw: string, levelCol: string, todoKeywords: string[], doneKeywords: string[]): Span[] {
  const spans: Span[] = [];
  let rest = raw;
  const stars = rest.match(/^(\*+)(\s+)/);
  if (stars) {
    spans.push({ t: stars[1], c: C_STARS });
    spans.push({ t: stars[2] });
    rest = rest.slice(stars[0].length);
  }
  let tags = "";
  const tm = rest.match(/(\s+)(:[^\s]+:)\s*$/);
  if (tm) {
    tags = tm[2];
    rest = rest.slice(0, tm.index!);
  }
  const tw = rest.match(/^(\S+)(\s+)?/);
  if (tw && todoKeywords.includes(tw[1])) {
    spans.push({ t: tw[1], c: doneKeywords.includes(tw[1]) ? C_DONE : C_TODO, b: true });
    if (tw[2]) spans.push({ t: tw[2] });
    rest = rest.slice(tw[0].length);
  }
  const pm = rest.match(/^(\[#[A-Za-z0-9]\])(\s+)?/);
  if (pm) {
    spans.push({ t: pm[1], c: C_PRIORITY, b: true });
    if (pm[2]) spans.push({ t: pm[2] });
    rest = rest.slice(pm[0].length);
  }
  const cookieRe = /(\[\d+%\]|\[\d+\/\d+\])/g;
  let last = 0;
  let mm: RegExpExecArray | null;
  while ((mm = cookieRe.exec(rest))) {
    if (mm.index > last) spans.push({ t: rest.slice(last, mm.index), c: levelCol, b: true });
    spans.push({ t: mm[1], c: C_COOKIE });
    last = cookieRe.lastIndex;
  }
  if (last < rest.length) spans.push({ t: rest.slice(last), c: levelCol, b: true });
  if (tags) {
    spans.push({ t: " " });
    spans.push({ t: tags, c: C_TAG });
  }
  return spans;
}

function scheduledSpans(n: OrgNodeT): Span[] {
  if (!n.rawScheduled) return [];
  return [
    { t: "⏱ ", c: C_SCHEDULED },
    { t: n.rawScheduled, c: C_STAMP },
  ];
}

const MS_DAY = 86_400_000;

/** Relative-day deadline badge: "In Nd" / "Today" / "Nd overdue" (flashing).
 *  A node's :DEADLINE_COLOR: property overrides the default colour for all
 *  states; "overdue" still flashes regardless. */
function DeadlineBadge({ n }: { n: OrgNodeT }) {
  if (n.done) return null; // completed: deadline no longer relevant
  const d = parseOrgDate(n.deadline);
  if (!d) return null;
  const days = Math.round((startOfDay(d).getTime() - startOfDay(new Date()).getTime()) / MS_DAY);

  let label: string;
  let color: string;
  let flash = false;
  if (days > 0) {
    label = `In ${days}d`;
    color = days <= 2 ? "#e0a458" : "#5fb3a1";
  } else if (days === 0) {
    label = "Today";
    color = "#e0a458";
  } else {
    label = `${-days}d overdue`;
    color = "#ff6c6b";
    flash = true;
  }
  if (n.deadlineColor) color = n.deadlineColor;

  return (
    <span
      className={flash ? "deadline-flash" : undefined}
      title={`Deadline: ${n.rawDeadline ?? n.deadline}`}
      style={{
        fontSize: 10,
        fontWeight: 700,
        color,
        border: `1px solid ${color}`,
        borderRadius: 4,
        padding: "0 5px",
        whiteSpace: "nowrap",
      }}
    >
      ⚑ {label}
    </span>
  );
}

function renderSpans(spans: Span[]) {
  return spans.map((s, i) => (
    <span key={i} style={{ color: s.c, fontWeight: s.b ? 700 : 400 }}>
      {s.t}
    </span>
  ));
}

// On-node task state control. Shown only for task states (these keywords);
// "Start" sets STRT + schedules today, then it cycles through the states.
const STATE_CYCLE = ["TODO", "STRT", "WAIT", "HOLD", "DONE"];
function stateColor(s: string): string {
  switch (s) {
    case "TODO": return "#98be65"; // start = green
    case "STRT": return "#e0a458"; // amber
    case "WAIT": return "#e0a458";
    case "HOLD": return "#83898d"; // grey
    case "DONE": return "#98be65"; // green
    default: return "#83898d";
  }
}

const pillBase: React.CSSProperties = {
  marginLeft: 8,
  flexShrink: 0,
  fontSize: 10,
  fontWeight: 700,
  lineHeight: "16px",
  padding: "0 7px",
  borderRadius: 10,
  background: "transparent",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

function StateControl({ n }: { n: OrgNodeT }) {
  const edit = useOrgStore((s) => s.edit);
  const start = useOrgStore((s) => s.start);
  const archive = useOrgStore((s) => s.archive);
  const doc = useOrgStore((s) => s.doc);
  const highlightBlockers = useOrgStore((s) => s.highlightBlockers);

  // Done → offer Reopen (back to TODO/Start) and Archive.
  if (n.done) {
    return (
      <>
        <button
          onClick={(e) => {
            e.stopPropagation();
            edit(setTodo, n, "TODO");
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          title="Reopen this task (back to TODO)"
          style={{ ...pillBase, color: "#98be65", border: "1px solid #98be65" }}
        >
          ↩ Reopen
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            archive(n);
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          title="Archive this subtree"
          style={{ ...pillBase, color: "var(--c-text-dim)", border: "1px solid var(--c-border)" }}
        >
          ⤓ Archive
        </button>
      </>
    );
  }

  if (!n.todo || !STATE_CYCLE.includes(n.todo)) return null;

  // Blocked: a TODO with unfinished prerequisites can't be started.
  const blockers = n.todo === "TODO" ? incompleteDeps(n, doc) : [];
  if (blockers.length) {
    const names = blockers.map((b) => b.title ?? "untitled").join(", ");
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          highlightBlockers(n);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        title={`Blocked — click to highlight prerequisite${blockers.length > 1 ? "s" : ""}: ${names}`}
        style={{ ...pillBase, color: "var(--c-text-dim)", border: "1px dashed var(--c-text-dim)", cursor: "pointer", opacity: 0.9 }}
      >
        🔒 Blocked
      </button>
    );
  }

  const next = STATE_CYCLE[(STATE_CYCLE.indexOf(n.todo) + 1) % STATE_CYCLE.length];
  const col = stateColor(n.todo);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (next === "STRT") start(n);
        else edit(setTodo, n, next);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      title={`Click → ${next}`}
      style={{ ...pillBase, color: col, border: `1px solid ${col}` }}
    >
      {n.todo === "TODO" ? "▶ Start" : n.todo}
    </button>
  );
}

const CHECKBOX_RE = /^(\s*)[-+*]\s+\[([ xX-])\]\s?(.*)$/;

// The entry body inside the node: checkbox items stay interactive (click to
// toggle); every other line — paragraphs, non-checkbox list items — shows as
// dimmed text so normal content is visible in the graph, not just headings.
function Body({ n }: { n: OrgNodeT }) {
  const toggleCheckbox = useOrgStore((s) => s.toggleCheckbox);
  if (!n.body) return null;
  // Slice the body around any org tables so we can splice in <TableEditor>
  // blocks. Lines outside tables render as before (checkbox / dimmed text).
  const tables = findTableBlocks(n.body);
  const lines = n.body.split("\n");
  const elements: React.ReactNode[] = [];
  let cb = 0;
  const renderLine = (line: string, i: number): React.ReactNode => {
        const m = line.match(CHECKBOX_RE);
        if (!m) {
          if (line.trim() === "") return <div key={i} style={{ height: 4 }} />;
          return (
            <div key={i} style={{ fontSize: 11.5, lineHeight: "15px", color: "var(--c-text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={line.trim()}>
              {line}
            </div>
          );
        }
        const idx = cb++;
        const c = m[2].toUpperCase();
        const indent = m[1].length;
        const checked = c === "X";
        const mark = checked ? "☑" : c === "-" ? "◪" : "☐";
        const markColor = checked ? C_DONE : c === "-" ? C_PRIORITY : "#7f8388";
        return (
          <button
            key={i}
            onClick={(e) => {
              e.stopPropagation();
              toggleCheckbox(n, idx);
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            title="Toggle checkbox"
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 6,
              background: "transparent",
              border: "none",
              margin: 0,
              padding: 0,
              paddingLeft: indent ? indent * 4 : 0,
              cursor: "pointer",
              textAlign: "left",
              fontFamily: "inherit",
              fontSize: 11.5,
              lineHeight: "15px",
              color: checked ? "var(--c-text-dim)" : "var(--c-text)",
            }}
          >
            <span style={{ color: markColor, fontWeight: 700, flexShrink: 0 }}>{mark}</span>
            <span style={{ textDecoration: checked ? "line-through" : "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {m[3] ||" "}
            </span>
          </button>
        );
  };

  // Walk the body line-by-line, inlining a <TableEditor> whenever the cursor
  // enters a known table block (then skipping past its end-line).
  let i = 0;
  let tIdx = 0;
  while (i < lines.length) {
    if (tIdx < tables.length && i === tables[tIdx].startLine) {
      const block = tables[tIdx];
      elements.push(<TableEditor key={`t${block.startLine}`} node={n} block={block} />);
      i = block.endLine;
      tIdx++;
    } else {
      elements.push(renderLine(lines[i], i));
      i++;
    }
  }

  return (
    <div style={{ paddingLeft: 12, marginTop: 2, display: "flex", flexDirection: "column" }}>
      {elements}
    </div>
  );
}

export default function OrgNode({ data }: NodeProps) {
  const d = data as OrgNodeView;
  const n = d.org;
  const accent = levelColor(n.level);

  const select = useOrgStore((s) => s.select);
  const selectedId = useOrgStore((s) => s.selectedId);
  const toggleExpand = useOrgStore((s) => s.toggleExpand);
  const editInEmacs = useOrgStore((s) => s.editInEmacs);
  const openContextMenu = useOrgStore((s) => s.openContextMenu);
  const dropTargetId = useOrgStore((s) => s.dropTargetId);
  const depMode = useOrgStore((s) => s.depMode);
  const isConnectSource = useOrgStore((s) => s.connectFrom === n.id);
  // null = not the hovered target; true/false = hovered & (in)valid drop
  const connectHoverValid = useOrgStore((s) => (s.connectHover === n.id ? s.connectValid : null));
  // Depth in the active blocker-highlight chain (undefined when not highlighted,
  // 1 = direct blocker, 2 = blocker-of-blocker, …). Drives ring intensity.
  const highlightDepth = useOrgStore((s) => s.highlightDepth.get(n.id));
  const highlightDone = useOrgStore((s) => s.highlightDone.has(n.id));
  const highlighted = highlightDepth !== undefined || highlightDone;
  // Falloff for active blockers: depth 1 -> 1.0, 2 -> 0.65, 3 -> 0.45, 4+ -> 0.30.
  // DONE prereqs always show at full intensity (single solid green ring).
  const highlightIntensity = highlightDone
    ? 1
    : highlightDepth === undefined
      ? 0
      : Math.max(0.3, 1 - 0.25 * (highlightDepth - 1));
  // Gold (#ffd166) for still-blocking, green (#98be65) for already-satisfied.
  const highlightRgb = highlightDone ? "152,190,101" : "255,209,102";
  const flashed = useOrgStore((s) => s.flashId === n.id);
  const doc = useOrgStore((s) => s.doc);
  const todoK = doc?.todoKeywords ?? [];
  const doneK = doc?.doneKeywords ?? [];

  const selected = n.id === selectedId;
  const isDropTarget = n.id === dropTargetId;
  // Connect-drag indicator: blue = the node you're dragging from, green = a
  // valid drop target under the cursor, red = an invalid target (self/sibling).
  const connectColor = isConnectSource
    ? "#51afef"
    : connectHoverValid === true
      ? "#98be65"
      : connectHoverValid === false
        ? "#ff6c6b"
        : null;
  // Only surface the scheduled date once a task is started (Start sets it).
  const started = n.todo === "STRT" || n.todo === "WAIT" || n.todo === "HOLD";
  const sched = started ? scheduledSpans(n) : [];
  const hasPlanning = sched.length > 0 || (!!n.deadline && !n.done);

  return (
    <div
      className={flashed ? "node-flash" : undefined}
      onClick={() => select(n.id)}
      onDoubleClick={() => editInEmacs(n)}
      onContextMenu={(e) => {
        e.preventDefault();
        openContextMenu(e.clientX, e.clientY, n.id);
      }}
      title="Click to select · double-click to open Emacs on this node · right-click for more"
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 12.5,
        lineHeight: 1.5,
        whiteSpace: "pre",
        background: highlighted ? `rgba(${highlightRgb},${0.14 * highlightIntensity})` : isDropTarget ? "rgba(99,166,106,0.18)" : selected ? `${accent}22` : "var(--c-surface)",
        border: `1px solid ${connectColor ?? (highlighted ? `rgba(${highlightRgb},${highlightIntensity})` : isDropTarget ? "var(--c-green)" : selected ? accent : "var(--c-border)")}`,
        borderRadius: 6,
        boxShadow: connectColor
          ? `inset 3px 0 0 ${accent}, 0 0 0 2px ${connectColor}, 0 0 12px ${connectColor}aa`
          : highlighted
            ? `inset 3px 0 0 ${accent}, 0 0 0 2px rgba(${highlightRgb},${highlightIntensity}), 0 0 ${Math.round(16 * highlightIntensity)}px rgba(${highlightRgb},${0.8 * highlightIntensity})`
            : isDropTarget
              ? `inset 3px 0 0 ${accent}, 0 0 0 2px var(--c-green)`
              : selected
                ? `inset 3px 0 0 ${accent}, 0 0 0 2px ${accent}66`
                : `inset 3px 0 0 ${accent}, 0 1px 3px rgba(0,0,0,0.4)`,
        padding: "4px 10px 4px 8px",
        maxWidth: 460,
        opacity: n.done ? 0.45 : 1,
        filter: n.done ? "grayscale(0.7)" : "none",
        cursor: depMode ? "crosshair" : "pointer",
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{ opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: "none", background: "transparent", top: 14 }}
      />

      <div style={{ display: "flex", alignItems: "baseline", overflow: "hidden" }}>
        <span
          onClick={(e) => {
            e.stopPropagation();
            if (d.hasChildren) toggleExpand(n.id);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          style={{
            width: 12,
            flexShrink: 0,
            cursor: d.hasChildren ? "pointer" : "default",
            color: "var(--c-text-dim)",
            userSelect: "none",
          }}
        >
          {d.hasChildren ? (d.expanded ? "▾" : "▸") : " "}
        </span>
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
          {renderSpans(fontifyHeadline(n.raw ?? "", accent, todoK, doneK))}
          {!d.expanded && d.hasChildren && <span style={{ color: C_TAG }}>{`  ⋯${d.childCount}`}</span>}
        </span>
        <StateControl n={n} />
      </div>

      {hasPlanning && (
        <div style={{ paddingLeft: 12, fontSize: 11, display: "flex", alignItems: "center", gap: 8 }}>
          {sched.length > 0 && <span>{renderSpans(sched)}</span>}
          <DeadlineBadge n={n} />
        </div>
      )}

      <Body n={n} />

      <Handle
        type="source"
        position={Position.Bottom}
        style={{ opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: "none", background: "transparent", left: 8, transform: "none" }}
      />
    </div>
  );
}
