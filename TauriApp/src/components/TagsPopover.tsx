import { useEffect, useMemo, useRef } from "react";
import { useOrgStore } from "../store/useOrgStore";

interface Props {
  onClose: () => void;
  /** Anchor coords (top-right of toolbar button) so the popover lines up. */
  anchorRect: DOMRect | null;
}

/**
 * Popover listing every tag in the doc with:
 *  - a colour swatch (label-input picker) — colour persists per file and
 *    is used to tint matching nodes' backgrounds in the graph.
 *  - a filter radio — when selected, non-matching nodes are dimmed + blurred
 *    in the graph so the tagged set pops.
 *
 * Anchored just below the toolbar's 🏷 Tags button. Closes on outside click
 * or Escape.
 */
export default function TagsPopover({ onClose, anchorRect }: Props) {
  const doc = useOrgStore((s) => s.doc);
  const tagColors = useOrgStore((s) => s.tagColors);
  const tagFilter = useOrgStore((s) => s.tagFilter);
  const setTagColor = useOrgStore((s) => s.setTagColor);
  const setTagFilter = useOrgStore((s) => s.setTagFilter);

  const ref = useRef<HTMLDivElement>(null);

  // Outside-click / Escape close. Use mousedown so the close fires before any
  // click handler under the cursor — avoids re-toggling the toolbar button.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // De-dupe every tag that appears across all nodes (local + inherited).
  const allTags = useMemo(() => {
    if (!doc) return [];
    const s = new Set<string>();
    for (const n of doc.nodes) {
      for (const t of n.tags ?? []) s.add(t);
      for (const t of n.tagsAll ?? []) s.add(t);
    }
    return [...s].sort();
  }, [doc]);

  const WIDTH = 260;
  const HEIGHT_MAX = 360;
  // Position just under the anchor button; clamp to viewport.
  const top = anchorRect ? anchorRect.bottom + 6 : 60;
  const rawLeft = anchorRect ? anchorRect.right - WIDTH : 16;
  const left = Math.min(Math.max(rawLeft, 8), window.innerWidth - WIDTH - 8);

  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        left,
        top,
        width: WIDTH,
        maxHeight: HEIGHT_MAX,
        zIndex: 10000,
        background: "var(--c-surface)",
        border: "1px solid var(--c-border)",
        borderRadius: 8,
        padding: 8,
        boxShadow: "0 8px 28px rgba(0,0,0,0.55)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "2px 4px 4px 4px", borderBottom: "1px solid var(--c-border)" }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: "var(--c-text-dim)" }}>
          Tags
        </span>
        <button
          onClick={() => setTagFilter(null)}
          disabled={tagFilter === null}
          title="Show every task again (clear the tag filter)"
          style={{
            background: "transparent",
            border: "1px solid var(--c-border)",
            color: tagFilter === null ? "var(--c-text-dim)" : "var(--c-text)",
            borderRadius: 4,
            padding: "2px 8px",
            fontSize: 11,
            cursor: tagFilter === null ? "default" : "pointer",
            opacity: tagFilter === null ? 0.45 : 1,
          }}
        >
          All
        </button>
      </div>

      {allTags.length === 0 ? (
        <div style={{ padding: 14, fontSize: 12, color: "var(--c-text-dim)", textAlign: "center" }}>
          No tags yet. Add tags to a heading (e.g. <code>:work:</code>) and they'll appear here.
        </div>
      ) : (
        <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
          {allTags.map((tag) => {
            const color = tagColors[tag];
            const isFiltered = tagFilter === tag;
            return (
              <div
                key={tag}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "4px 6px",
                  borderRadius: 4,
                  background: isFiltered ? "var(--c-surface2)" : "transparent",
                }}
              >
                {/* Label-input picker (clicking the swatch opens the OS picker via
                    the associated invisible <input type="color">). */}
                <label
                  title={color ? `Click to change colour for :${tag}:` : `Click to assign a colour to :${tag}:`}
                  style={{
                    position: "relative",
                    width: 18,
                    height: 18,
                    flexShrink: 0,
                    borderRadius: 4,
                    background: color ?? "transparent",
                    border: `1px solid ${color ? "rgba(255,255,255,0.15)" : "var(--c-border)"}`,
                    cursor: "pointer",
                    overflow: "hidden",
                  }}
                >
                  {!color && (
                    <span aria-hidden style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "var(--c-text-dim)", lineHeight: 1 }}>
                      ?
                    </span>
                  )}
                  <input
                    type="color"
                    value={color ?? "#5a7fa8"}
                    onChange={(e) => setTagColor(tag, e.target.value)}
                    style={{
                      position: "absolute",
                      inset: 0,
                      width: "100%",
                      height: "100%",
                      opacity: 0,
                      cursor: "pointer",
                      border: "none",
                      padding: 0,
                      margin: 0,
                      background: "transparent",
                    }}
                  />
                </label>
                {color && (
                  <button
                    onClick={() => setTagColor(tag, null)}
                    title="Remove colour"
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "var(--c-text-dim)",
                      padding: 0,
                      cursor: "pointer",
                      fontSize: 11,
                    }}
                  >
                    ✕
                  </button>
                )}
                <span
                  style={{
                    flex: 1,
                    fontSize: 12.5,
                    fontFamily: "ui-monospace, monospace",
                    color: "var(--c-text)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={`:${tag}:`}
                >
                  :{tag}:
                </span>
                <button
                  onClick={() => setTagFilter(isFiltered ? null : tag)}
                  title={isFiltered ? "Stop filtering — show all tasks" : `Show only :${tag}: tasks, fade everything else`}
                  style={{
                    background: isFiltered ? "var(--c-accent)" : "transparent",
                    color: isFiltered ? "#fff" : "var(--c-text-dim)",
                    border: "1px solid var(--c-border)",
                    borderRadius: 4,
                    padding: "2px 8px",
                    fontSize: 10.5,
                    fontWeight: 600,
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  {isFiltered ? "✓ filter" : "filter"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
