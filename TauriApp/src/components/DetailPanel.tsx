import { useEffect, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import {
  demote,
  moveDown,
  moveUp,
  promote,
  setDeadline,
  setPriority,
  setScheduled,
  setTags,
  setTitle,
  setTodo,
  incompleteDeps,
} from "../api/org";
import { levelColor } from "./OrgNode";

export default function DetailPanel() {
  const doc = useOrgStore((s) => s.doc);
  const selectedId = useOrgStore((s) => s.selectedId);
  const select = useOrgStore((s) => s.select);
  const edit = useOrgStore((s) => s.edit);
  const saving = useOrgStore((s) => s.saving);
  const addHeading = useOrgStore((s) => s.addHeading);
  const removeNode = useOrgStore((s) => s.removeNode);
  const start = useOrgStore((s) => s.start);
  const scheduleNode = useOrgStore((s) => s.scheduleNode);
  const setNodeRange = useOrgStore((s) => s.setNodeRange);

  const node = doc?.nodes.find((n) => n.id === selectedId);

  const [titleDraft, setTitleDraft] = useState("");
  const [tagsDraft, setTagsDraft] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  useEffect(() => {
    setTitleDraft(node?.title ?? "");
    setTagsDraft(node?.tags.join(" ") ?? "");
    setConfirmDel(false);
  }, [node?.id, node?.title, node?.tags]);

  if (!node || !doc) return null;
  const accent = levelColor(node.level);
  const dateVal = (s: string | null) => (s ? s.slice(0, 10) : "");

  return (
    <div
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "var(--c-text-dim)" }}>
          Level {node.level}
          {node.category ? ` · ${node.category}` : ""}
          {saving && <span style={{ color: "var(--c-amber)" }}> · saving…</span>}
        </span>
        <button
          onClick={() => select(null)}
          style={{ background: "none", border: "none", color: "var(--c-text-dim)", cursor: "pointer" }}
        >
          ✕
        </button>
      </div>

      {/* Title */}
      <div>
        <Lbl>Title</Lbl>
        <input
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={() => {
            if (titleDraft !== node.title) edit(setTitle, node, titleDraft);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          style={{ ...input, boxShadow: `inset 4px 0 0 ${accent}`, fontWeight: 600 }}
        />
      </div>

      {/* TODO + priority */}
      <div style={{ display: "flex", gap: 8 }}>
        <div style={{ flex: 1 }}>
          <Lbl>State</Lbl>
          <select
            value={node.todo ?? ""}
            onChange={(e) => edit(setTodo, node, e.target.value)}
            style={input}
          >
            <option value="">(none)</option>
            {doc.todoKeywords.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <div style={{ width: 90 }}>
          <Lbl>Priority</Lbl>
          <select
            value={node.priority ?? ""}
            onChange={(e) => edit(setPriority, node, e.target.value)}
            style={input}
          >
            <option value="">—</option>
            {["A", "B", "C"].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Start task → STRT + schedule today (only for TODO tasks; blocked when
          the node has prerequisites that aren't done yet). */}
      {node.todo === "TODO" &&
        (() => {
          const blockers = incompleteDeps(node, doc);
          if (blockers.length) {
            return (
              <button
                disabled
                title={`Blocked — finish first: ${blockers.map((b) => b.title ?? "untitled").join(", ")}`}
                style={{
                  background: "var(--c-surface2)",
                  color: "var(--c-text-dim)",
                  border: "1px dashed var(--c-text-dim)",
                  borderRadius: 6,
                  padding: "8px 12px",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "not-allowed",
                }}
              >
                🔒 Blocked by {blockers.length} prerequisite{blockers.length > 1 ? "s" : ""}
              </button>
            );
          }
          return (
            <button
              onClick={() => start(node)}
              style={{
                background: "var(--c-accent)",
                color: "#fff",
                border: "none",
                borderRadius: 6,
                padding: "8px 12px",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
              title="Set STRT and schedule today"
            >
              ▶ Start task
            </button>
          );
        })()}

      {/* Scheduled */}
      <DateField
        label="Scheduled"
        value={dateVal(node.scheduled)}
        onChange={(v) => scheduleNode(node, v, "scheduled")}
        onClear={() => edit(setScheduled, node, "")}
      />
      {/* Deadline */}
      <DateField
        label="Deadline"
        value={dateVal(node.deadline)}
        onChange={(v) => edit(setDeadline, node, v)}
        onClear={() => edit(setDeadline, node, "")}
      />
      {/* Span / duration — a plain active-timestamp range. Same-day with
          times → vertical bar on the timeline; multi-day → horizontal bar. */}
      <SpanField
        startIso={node.timestamp}
        endIso={node.timestampEnd}
        onCommit={(s, e) => setNodeRange(node, s, e)}
        onClear={() => setNodeRange(node, "", "")}
      />

      {/* Tags */}
      <div>
        <Lbl>Tags (space-separated)</Lbl>
        <input
          value={tagsDraft}
          onChange={(e) => setTagsDraft(e.target.value)}
          onBlur={() => {
            if (tagsDraft !== node.tags.join(" ")) edit(setTags, node, tagsDraft);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          style={input}
          placeholder="wetlab urgent"
        />
      </div>

      {/* Shift / promote (org M-up/M-down, M-S-left/right) */}
      <div>
        <Lbl>Move</Lbl>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => edit(moveUp, node, "")} style={actionBtn} title="Move subtree up">↑</button>
          <button onClick={() => edit(moveDown, node, "")} style={actionBtn} title="Move subtree down">↓</button>
          <button onClick={() => edit(promote, node, "")} style={actionBtn} title="Promote (←)">⇤</button>
          <button onClick={() => edit(demote, node, "")} style={actionBtn} title="Demote (→)">⇥</button>
        </div>
      </div>

      {/* Structure actions */}
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button onClick={() => addHeading(node.begin, "New heading")} style={actionBtn}>
          + Add child
        </button>
        {confirmDel ? (
          <button
            onClick={() => removeNode(node)}
            style={{ ...actionBtn, background: "var(--c-red)", color: "#000", borderColor: "var(--c-red)" }}
          >
            Click to confirm delete
          </button>
        ) : (
          <button
            onClick={() => setConfirmDel(true)}
            style={{ ...actionBtn, color: "var(--c-red)", borderColor: "var(--c-red)" }}
          >
            Delete
          </button>
        )}
      </div>

      {node.closed && (
        <div>
          <Lbl>Closed</Lbl>
          <div style={{ fontSize: 13 }}>{node.closed}</div>
        </div>
      )}

      {node.body && (
        <div>
          <Lbl>Body</Lbl>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              fontSize: 12,
              background: "var(--c-bg)",
              borderRadius: 6,
              padding: 8,
              margin: 0,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            }}
          >
            {node.body}
          </pre>
        </div>
      )}
    </div>
  );
}

function todayStr(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function DateField({
  label,
  value,
  onChange,
  onClear,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onClear: () => void;
}) {
  return (
    <div>
      <Lbl>{label}</Lbl>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          type="date"
          value={value}
          onChange={(e) => e.target.value && onChange(e.target.value)}
          style={{ ...input, flex: 1 }}
        />
        {value && (
          <button onClick={onClear} style={clearBtn} title={`Clear ${label.toLowerCase()}`}>
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

/** Editor for a node's duration/span (a plain active-timestamp range).
 *  Start + end, each a date and an optional time. Leaving the end blank
 *  makes it a single timestamp; clearing the start removes the span. */
function SpanField({
  startIso,
  endIso,
  onCommit,
  onClear,
}: {
  startIso: string | null;
  endIso: string | null;
  onCommit: (start: string, end: string) => void;
  onClear: () => void;
}) {
  const isoDate = (s: string | null) => (s ? s.slice(0, 10) : "");
  const isoTime = (s: string | null) => (s && s.includes("T") ? s.slice(11, 16) : "");

  const [sDate, setSDate] = useState(isoDate(startIso));
  const [sTime, setSTime] = useState(isoTime(startIso));
  const [eDate, setEDate] = useState(isoDate(endIso));
  const [eTime, setETime] = useState(isoTime(endIso));

  // Resync the inputs whenever the underlying node values change (e.g. after
  // an edit round-trips, or a different node is selected).
  useEffect(() => {
    setSDate(isoDate(startIso));
    setSTime(isoTime(startIso));
    setEDate(isoDate(endIso));
    setETime(isoTime(endIso));
  }, [startIso, endIso]);

  const commit = (
    sd: string,
    st: string,
    ed: string,
    et: string,
  ) => {
    if (!sd) {
      onClear();
      return;
    }
    const startStr = st ? `${sd} ${st}` : sd;
    const endStr = ed ? (et ? `${ed} ${et}` : ed) : "";
    onCommit(startStr, endStr);
  };

  const has = !!startIso;
  return (
    <div>
      <Lbl>Span (start → end)</Lbl>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ width: 30, fontSize: 11, color: "var(--c-text-dim)" }}>From</span>
          <input
            type="date"
            value={sDate}
            onChange={(e) => {
              setSDate(e.target.value);
              commit(e.target.value, sTime, eDate, eTime);
            }}
            style={{ ...input, flex: 1 }}
          />
          <input
            type="time"
            value={sTime}
            onChange={(e) => {
              setSTime(e.target.value);
              commit(sDate, e.target.value, eDate, eTime);
            }}
            style={{ ...input, width: 92 }}
            disabled={!sDate}
          />
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ width: 30, fontSize: 11, color: "var(--c-text-dim)" }}>To</span>
          <input
            type="date"
            value={eDate}
            onChange={(e) => {
              setEDate(e.target.value);
              commit(sDate, sTime, e.target.value, eTime);
            }}
            style={{ ...input, flex: 1 }}
            disabled={!sDate}
          />
          <input
            type="time"
            value={eTime}
            onChange={(e) => {
              setETime(e.target.value);
              commit(sDate, sTime, eDate, e.target.value);
            }}
            style={{ ...input, width: 92 }}
            disabled={!eDate}
          />
          {has && (
            <button onClick={onClear} style={clearBtn} title="Clear span">
              ✕
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Lbl({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        color: "var(--c-text-dim)",
        marginBottom: 4,
      }}
    >
      {children}
    </div>
  );
}

const input: React.CSSProperties = {
  width: "100%",
  background: "var(--c-bg)",
  color: "var(--c-text)",
  border: "1px solid var(--c-border)",
  borderRadius: 6,
  padding: "6px 8px",
  fontSize: 13,
};

const clearBtn: React.CSSProperties = {
  background: "var(--c-surface2)",
  color: "var(--c-text-dim)",
  border: "1px solid var(--c-border)",
  borderRadius: 6,
  padding: "0 10px",
  cursor: "pointer",
};

const actionBtn: React.CSSProperties = {
  flex: 1,
  background: "var(--c-surface2)",
  color: "var(--c-text)",
  border: "1px solid var(--c-border)",
  borderRadius: 6,
  padding: "6px 8px",
  fontSize: 12,
  cursor: "pointer",
};
