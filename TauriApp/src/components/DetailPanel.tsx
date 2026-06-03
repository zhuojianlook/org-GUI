import { useEffect, useState } from "react";
import { useOrgStore, gcalCalendarTagSet } from "../store/useOrgStore";
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
  const setNodeSpan = useOrgStore((s) => s.setNodeSpan);
  const tagColors = useOrgStore((s) => s.tagColors);

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
      {/* Span / duration. The start mirrors the SCHEDULED date when the node
          is scheduled (a same-day span IS the scheduled block); otherwise it
          reads from a plain timestamp range. The bridge routes the write:
          same-day → SCHEDULED time-range, multi-day → timestamp range. */}
      <SpanField
        startIso={node.scheduled ?? node.timestamp}
        endIso={node.scheduledEnd ?? node.timestampEnd}
        onCommit={(s, e) => setNodeSpan(node, s, e)}
        onClear={() => setNodeSpan(node, "", "")}
      />

      {/* Tags */}
      <div>
        <Lbl>Tags</Lbl>
        {/* Chips: × removes your own tags. Calendar tags (from a synced Google
            calendar) and inherited tags (from a parent heading) are locked. */}
        {(() => {
          const calSet = gcalCalendarTagSet();
          const own = node.tags;
          const inherited = node.tagsAll.filter((t) => !own.includes(t));
          if (own.length === 0 && inherited.length === 0) return null;
          const removeTag = (t: string) =>
            edit(setTags, node, own.filter((x) => x !== t).join(" "));
          const chip = (
            t: string,
            opts: { removable?: boolean; locked?: "calendar" | "inherited" },
          ) => {
            const c = tagColors[t];
            return (
              <span
                key={`${opts.locked ?? "own"}-${t}`}
                title={
                  opts.locked === "calendar"
                    ? "From a Google calendar — can't be removed here"
                    : opts.locked === "inherited"
                      ? "Inherited from a parent heading"
                      : undefined
                }
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "1px 4px 1px 7px",
                  borderRadius: 10,
                  fontSize: 11,
                  fontWeight: 600,
                  background: c ? hexA(c, 0.22) : "var(--c-surface2)",
                  border: `1px solid ${c ? hexA(c, 0.6) : "var(--c-border)"}`,
                  color: "var(--c-text)",
                  opacity: opts.locked === "inherited" ? 0.6 : 1,
                }}
              >
                {opts.locked === "calendar" && <span aria-hidden>📅</span>}
                {opts.locked === "inherited" && <span aria-hidden>↑</span>}
                {t}
                {opts.removable && (
                  <button
                    onClick={() => removeTag(t)}
                    title={`Remove “${t}”`}
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--c-text-dim)",
                      cursor: "pointer",
                      fontSize: 13,
                      lineHeight: 1,
                      padding: "0 1px",
                    }}
                  >
                    ×
                  </button>
                )}
              </span>
            );
          };
          return (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 6 }}>
              {own.map((t) => chip(t, { removable: true }))}
              {inherited.map((t) =>
                chip(t, { locked: calSet.has(t) ? "calendar" : "inherited" }),
              )}
            </div>
          );
        })()}
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
          placeholder="add tags (space-separated)…"
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
          <TimeInput
            value={sTime}
            disabled={!sDate}
            onCommit={(v) => {
              setSTime(v);
              commit(sDate, v, eDate, eTime);
            }}
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
            min={sDate || undefined}
          />
          <TimeInput
            value={eTime}
            disabled={!eDate}
            onCommit={(v) => {
              setETime(v);
              commit(sDate, sTime, eDate, v);
            }}
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

/** Robust time entry: a plain text field that accepts loose input and
 *  normalizes it to HH:MM on blur / Enter. Native <input type="time"> is
 *  flaky in WKWebView; this lets you type "9", "930", "9:5", "1430", etc.
 *  Empty stays empty (no time). */
function normalizeTime(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  // "14:30", "9:5", "9.30", "9 30"
  let m = t.match(/^(\d{1,2})[:.\s]?(\d{1,2})$/);
  if (m) {
    const h = Math.min(23, parseInt(m[1], 10));
    const min = Math.min(59, parseInt(m[2], 10));
    return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }
  // "1430" / "930" / "9"
  m = t.match(/^(\d{1,4})$/);
  if (m) {
    const digits = m[1];
    let h: number;
    let min: number;
    if (digits.length <= 2) {
      h = parseInt(digits, 10);
      min = 0;
    } else {
      const split = digits.length === 3 ? 1 : 2;
      h = parseInt(digits.slice(0, split), 10);
      min = parseInt(digits.slice(split), 10);
    }
    if (h > 23 || min > 59) return "";
    return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }
  return "";
}

function TimeInput({
  value,
  disabled,
  onCommit,
}: {
  value: string;
  disabled?: boolean;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const flush = () => {
    const norm = normalizeTime(draft);
    setDraft(norm);
    if (norm !== value) onCommit(norm);
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      value={draft}
      placeholder="HH:MM"
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={flush}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      style={{ ...input, width: 78, textAlign: "center", fontVariantNumeric: "tabular-nums" }}
      title="Type a time (e.g. 9, 930, 14:30) — blank for none"
    />
  );
}

/** hex (#rrggbb) → rgba string at ALPHA; passthrough for non-hex. */
function hexA(hex: string, alpha: number): string {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`;
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
