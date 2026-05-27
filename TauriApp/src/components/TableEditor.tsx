import { useEffect, useRef, useState } from "react";
import type { OrgNode as OrgNodeT } from "../api/org";
import { useOrgStore } from "../store/useOrgStore";
import {
  TableBlock,
  replaceTableInBody,
  serializeTable,
  withCellEdited,
  withColumnInserted,
  withColumnRemoved,
  withRowInserted,
  withRowRemoved,
} from "../utils/orgTable";

interface Props {
  node: OrgNodeT;
  block: TableBlock;
}

/**
 * Inline HTML table editor for an org-mode table embedded in a node's body.
 * Local state mirrors the parsed BLOCK; cell changes commit on blur (so each
 * keystroke doesn't fire a bridge round-trip). External doc updates re-sync
 * only when no cell currently has keyboard focus, so the user's in-progress
 * typing isn't clobbered by their own previous commit landing.
 */
export default function TableEditor({ node, block }: Props) {
  const setBody = useOrgStore((s) => s.setBody);

  const [rows, setRows] = useState<string[][]>(block.rows);
  const [hasHeader, setHasHeader] = useState(block.hasHeader);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setRows(block.rows);
      setHasHeader(block.hasHeader);
    }
  }, [block]);

  const commit = (nextRows: string[][], nextHasHeader = hasHeader) => {
    setRows(nextRows);
    setHasHeader(nextHasHeader);
    const text = serializeTable(nextRows, nextHasHeader);
    const body = replaceTableInBody(node.body ?? "", block, text);
    setBody(node, body);
  };

  const commitCell = (ri: number, ci: number, value: string) => {
    if (rows[ri][ci] === value) return;
    commit(withCellEdited(rows, ri, ci, value), hasHeader);
  };

  const colCount = Math.max(...rows.map((r) => r.length), 1);

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={{ marginTop: 4, marginBottom: 2 }}
    >
      <table
        style={{
          borderCollapse: "collapse",
          fontSize: 11.5,
          color: "var(--c-text)",
          background: "var(--c-bg)",
          border: "1px solid var(--c-border)",
          tableLayout: "fixed",
          width: "100%",
        }}
      >
        <tbody>
          {rows.map((row, ri) => {
            const isHeader = hasHeader && ri === 0;
            return (
              <tr key={ri} style={{ background: isHeader ? "var(--c-surface2)" : "transparent" }}>
                {Array.from({ length: colCount }).map((_, ci) => {
                  const value = row[ci] ?? "";
                  return (
                    <td
                      key={ci}
                      style={{
                        border: "1px solid var(--c-border)",
                        padding: 0,
                        verticalAlign: "top",
                      }}
                    >
                      <input
                        value={value}
                        onFocus={() => {
                          focusedRef.current = true;
                        }}
                        onChange={(e) => {
                          setRows((rs) => withCellEdited(rs, ri, ci, e.target.value));
                        }}
                        onBlur={(e) => {
                          focusedRef.current = false;
                          commitCell(ri, ci, e.target.value);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            (e.target as HTMLInputElement).blur();
                          }
                        }}
                        style={{
                          width: "100%",
                          boxSizing: "border-box",
                          background: "transparent",
                          border: "none",
                          outline: "none",
                          padding: "3px 6px",
                          color: "inherit",
                          fontFamily: "inherit",
                          fontWeight: isHeader ? 700 : 400,
                          fontSize: "inherit",
                        }}
                      />
                    </td>
                  );
                })}
                <td
                  style={{
                    width: 22,
                    border: "1px solid var(--c-border)",
                    background: "var(--c-surface)",
                    padding: 0,
                    textAlign: "center",
                  }}
                >
                  <button
                    onClick={() => commit(withRowRemoved(rows, ri))}
                    title="Remove this row"
                    style={tableActionBtn}
                    disabled={rows.length <= 1}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            );
          })}
          {/* Column-remove row (one ✕ per data column) */}
          <tr>
            {Array.from({ length: colCount }).map((_, ci) => (
              <td
                key={ci}
                style={{
                  border: "1px solid var(--c-border)",
                  background: "var(--c-surface)",
                  padding: 0,
                  textAlign: "center",
                }}
              >
                <button
                  onClick={() => commit(withColumnRemoved(rows, ci))}
                  title="Remove this column"
                  style={tableActionBtn}
                  disabled={colCount <= 1}
                >
                  ✕
                </button>
              </td>
            ))}
            <td style={{ border: "1px solid var(--c-border)", background: "var(--c-surface)" }} />
          </tr>
        </tbody>
      </table>

      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        <button onClick={() => commit(withRowInserted(rows, rows.length))} style={addBtn} title="Append row">
          + row
        </button>
        <button onClick={() => commit(withColumnInserted(rows, colCount))} style={addBtn} title="Append column">
          + col
        </button>
        <button
          onClick={() => commit(rows, !hasHeader)}
          style={{ ...addBtn, opacity: hasHeader ? 1 : 0.65 }}
          title="Toggle a separator after the first row (header style)"
        >
          {hasHeader ? "✓ header" : "header"}
        </button>
      </div>
    </div>
  );
}

const tableActionBtn: React.CSSProperties = {
  width: "100%",
  height: 18,
  background: "transparent",
  border: "none",
  color: "var(--c-text-dim)",
  cursor: "pointer",
  padding: 0,
  fontSize: 10,
  lineHeight: 1,
};

const addBtn: React.CSSProperties = {
  background: "var(--c-surface2)",
  color: "var(--c-text)",
  border: "1px solid var(--c-border)",
  borderRadius: 4,
  padding: "2px 8px",
  fontSize: 11,
  cursor: "pointer",
  fontFamily: "inherit",
};
