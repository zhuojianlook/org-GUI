import { useEffect, useMemo, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { parseOrgDate, startOfDay } from "../utils/time";
import type { OrgNode } from "../api/org";

const MS_DAY = 86_400_000;
const HOLD_STATES = new Set(["HOLD", "WAIT"]);

// Follow-up timestamps are a workflow aid (a "you nudged this on date X" note),
// stored per file in localStorage so they never touch the org file or the
// task's hold status. Keyed by the node's org ID when it has one, else its
// title (stable enough for a parked task).
const FOLLOWUP_KEY = (file: string | null) => `org-gui:followup:${file ?? ""}`;
function loadFollowups(file: string | null): Record<string, string> {
  if (!file) return {};
  try {
    const raw = localStorage.getItem(FOLLOWUP_KEY(file));
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}
function saveFollowups(file: string | null, m: Record<string, string>) {
  if (!file) return;
  try {
    localStorage.setItem(FOLLOWUP_KEY(file), JSON.stringify(m));
  } catch {
    /* non-fatal */
  }
}
const nodeKey = (n: OrgNode) => n.orgId || `t:${n.title ?? ""}`;
function todayIso(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

/**
 * "On Hold (KIV)" panel — every parked task (HOLD / WAIT) gathered in one
 * place so nothing falls through the cracks. Each row has a "Followed up"
 * toggle that records the date you last chased it (and shows how many days
 * ago) WITHOUT changing the hold status. A task leaves this list the moment
 * its TODO state moves off HOLD/WAIT.
 */
export default function OnHoldPanel() {
  const doc = useOrgStore((s) => s.doc);
  const file = useOrgStore((s) => s.file);
  const select = useOrgStore((s) => s.select);
  const flashNode = useOrgStore((s) => s.flashNode);

  const [followups, setFollowups] = useState<Record<string, string>>(() => loadFollowups(file));
  useEffect(() => setFollowups(loadFollowups(file)), [file]);

  const held = useMemo(
    () => (doc?.nodes ?? []).filter((n) => !n.done && n.todo != null && HOLD_STATES.has(n.todo)),
    [doc],
  );

  const markFollowedUp = (n: OrgNode) => {
    const next = { ...followups, [nodeKey(n)]: todayIso() };
    saveFollowups(file, next);
    setFollowups(next);
  };
  const clearFollowUp = (n: OrgNode) => {
    const next = { ...followups };
    delete next[nodeKey(n)];
    saveFollowups(file, next);
    setFollowups(next);
  };

  const focus = (id: string) => {
    select(id);
    flashNode(id);
    window.dispatchEvent(new CustomEvent("orggui:focusNode", { detail: { id } }));
  };

  const daysAgoLabel = (iso: string): string => {
    const d = parseOrgDate(iso);
    if (!d) return "";
    const days = Math.round((startOfDay(new Date()).getTime() - startOfDay(d).getTime()) / MS_DAY);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    return `${days}d ago`;
  };

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
        gap: 12,
      }}
    >
      <div>
        <div style={{ fontWeight: 700, fontSize: 15 }}>⏸ On Hold (KIV)</div>
        <div style={{ color: "var(--c-text-dim)", fontSize: 12, marginTop: 2 }}>
          Parked tasks (HOLD / WAIT) · {held.length}
        </div>
      </div>

      {held.length === 0 ? (
        <div style={{ color: "var(--c-text-dim)", fontSize: 12.5, textAlign: "center", marginTop: 8 }}>
          Nothing on hold. Set a task to HOLD or WAIT to park it here.
        </div>
      ) : (
        held.map((n) => {
          const fu = followups[nodeKey(n)];
          return (
            <div
              key={n.id}
              style={{
                border: "1px solid var(--c-border)",
                borderRadius: 8,
                padding: "8px 10px",
                display: "flex",
                flexDirection: "column",
                gap: 7,
                background: "var(--c-bg)",
              }}
            >
              <button
                onClick={() => focus(n.id)}
                title="Click to find this task on the canvas"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  width: "100%",
                  textAlign: "left",
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  color: "var(--c-text)",
                  fontSize: 13,
                }}
              >
                <span
                  style={{
                    fontWeight: 700,
                    fontSize: 9.5,
                    color: "#c9a227",
                    border: "1px solid #c9a227",
                    borderRadius: 4,
                    padding: "0 4px",
                    flexShrink: 0,
                  }}
                >
                  {n.todo}
                </span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {n.title ?? "(untitled)"}
                </span>
              </button>

              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, color: fu ? "var(--c-text-dim)" : "#e0a458", flex: 1 }}>
                  {fu ? `Followed up ${daysAgoLabel(fu)}` : "Not followed up yet"}
                </span>
                <button
                  onClick={() => markFollowedUp(n)}
                  title="Record that you followed up today (does not change the hold status)"
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    padding: "3px 9px",
                    borderRadius: 6,
                    border: "1px solid var(--c-accent)",
                    background: "var(--c-accent)",
                    color: "#fff",
                    cursor: "pointer",
                  }}
                >
                  ✓ Followed up
                </button>
                {fu && (
                  <button
                    onClick={() => clearFollowUp(n)}
                    title="Clear the follow-up note"
                    style={{
                      fontSize: 11,
                      padding: "3px 7px",
                      borderRadius: 6,
                      border: "1px solid var(--c-border)",
                      background: "transparent",
                      color: "var(--c-text-dim)",
                      cursor: "pointer",
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
