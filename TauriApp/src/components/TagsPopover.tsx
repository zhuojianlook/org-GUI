import { useEffect, useMemo, useRef, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";

const DEFAULT_TAG_COLOURS = [
  "#5a7fa8", // accent blue
  "#e0a458", // amber
  "#63a66a", // green
  "#c678dd", // violet
  "#5fb3a1", // teal
  "#ff6c6b", // red
];

interface Props {
  onClose: () => void;
  /** Anchor coords (top-right of toolbar button) so the popover lines up. */
  anchorRect: DOMRect | null;
  /** Optional DOM node of the toggle button so capture-phase outside-click
   *  detection can ignore clicks on it (the button's own onClick already
   *  toggles the popover; without this exclusion the close fires first and
   *  the toggle then re-opens it). */
  anchorEl?: HTMLElement | null;
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
export default function TagsPopover({ onClose, anchorRect, anchorEl }: Props) {
  const doc = useOrgStore((s) => s.doc);
  const tagColors = useOrgStore((s) => s.tagColors);
  const tagFilter = useOrgStore((s) => s.tagFilter);
  const tagAuraEnabled = useOrgStore((s) => s.tagAuraEnabled);
  const setTagColor = useOrgStore((s) => s.setTagColor);
  const setTagFilter = useOrgStore((s) => s.setTagFilter);
  const setTagAuraEnabled = useOrgStore((s) => s.setTagAuraEnabled);

  const ref = useRef<HTMLDivElement>(null);

  // Outside-click / Escape close. Use capture-phase pointerdown so the event
  // can't be swallowed by React Flow's own capture-phase handler before it
  // reaches us — that was what made canvas clicks fail to close the popover.
  // The target check skips clicks inside the popover itself.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current && ref.current.contains(t)) return;
      // Skip closes that originate on the toolbar toggle button — its own
      // onClick will close the popover; without this guard the close fires
      // here first and the button's onClick then reopens it.
      if (anchorEl && anchorEl.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, anchorEl]);

  // De-dupe every tag visible to the popover: tags carried by any node PLUS
  // orphan tags the user has defined in the colour map but not yet assigned.
  // That lets "+ new tag" land a fresh definition that survives until it's
  // bulk-applied via the SelectionBar.
  const allTags = useMemo(() => {
    const s = new Set<string>();
    if (doc) {
      for (const n of doc.nodes) {
        for (const t of n.tags ?? []) s.add(t);
        for (const t of n.tagsAll ?? []) s.add(t);
      }
    }
    for (const k of Object.keys(tagColors)) s.add(k);
    return [...s].sort();
  }, [doc, tagColors]);

  // Count nodes carrying each tag, so the user can tell an orphan apart from
  // a tag that's already attached to something.
  const tagCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    if (doc) {
      for (const n of doc.nodes) {
        for (const t of n.tagsAll ?? []) counts[t] = (counts[t] ?? 0) + 1;
      }
    }
    return counts;
  }, [doc]);

  const [newTagDraft, setNewTagDraft] = useState("");
  const createNewTag = () => {
    const raw = newTagDraft.trim().replace(/^:|:$/g, "");
    if (!raw) return;
    // Use a default colour cycling through the palette so the tag shows up
    // in the popover even before the user picks a custom one.
    const idx = Object.keys(tagColors).length % DEFAULT_TAG_COLOURS.length;
    setTagColor(raw, DEFAULT_TAG_COLOURS[idx]);
    setNewTagDraft("");
  };

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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "2px 4px 4px 4px", borderBottom: "1px solid var(--c-border)", gap: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: "var(--c-text-dim)" }}>
          Tags
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button
            onClick={() => setTagAuraEnabled(!tagAuraEnabled)}
            title={
              tagAuraEnabled
                ? "Disable the glowing aura behind tagged nodes (the filter view still shows it for the active tag)"
                : "Re-enable the glowing aura behind tagged nodes"
            }
            style={{
              background: tagAuraEnabled ? "var(--c-accent)" : "transparent",
              color: tagAuraEnabled ? "#fff" : "var(--c-text-dim)",
              border: "1px solid var(--c-border)",
              borderRadius: 4,
              padding: "2px 8px",
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            ✦ Aura
          </button>
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
      </div>

      {/* Always-visible input so the user can define a tag (with default
          colour) before any node carries it. Multi-select + Apply tag on the
          canvas SelectionBar then attaches it to specific nodes. */}
      <div style={{ display: "flex", gap: 6, padding: "2px 4px" }}>
        <input
          value={newTagDraft}
          onChange={(e) => setNewTagDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") createNewTag();
          }}
          placeholder="new tag name"
          style={{
            flex: 1,
            background: "var(--c-bg)",
            color: "var(--c-text)",
            border: "1px solid var(--c-border)",
            borderRadius: 4,
            padding: "3px 6px",
            fontSize: 12,
            fontFamily: "ui-monospace, monospace",
            outline: "none",
          }}
        />
        <button
          onClick={createNewTag}
          disabled={!newTagDraft.trim()}
          style={{
            background: newTagDraft.trim() ? "var(--c-accent)" : "var(--c-surface2)",
            color: newTagDraft.trim() ? "#fff" : "var(--c-text-dim)",
            border: "1px solid var(--c-border)",
            borderRadius: 4,
            padding: "3px 10px",
            fontSize: 11,
            fontWeight: 700,
            cursor: newTagDraft.trim() ? "pointer" : "not-allowed",
          }}
        >
          + Add
        </button>
      </div>

      {allTags.length === 0 ? (
        <div style={{ padding: 14, fontSize: 12, color: "var(--c-text-dim)", textAlign: "center" }}>
          No tags yet. Type a name above and hit Add, or tag a heading directly with <code>:work:</code>.
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
                  title={`:${tag}: · ${tagCounts[tag] ?? 0} node${tagCounts[tag] === 1 ? "" : "s"}`}
                >
                  :{tag}:
                </span>
                <span
                  style={{
                    fontSize: 10,
                    color: "var(--c-text-dim)",
                    flexShrink: 0,
                    minWidth: 18,
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                  }}
                  title={
                    (tagCounts[tag] ?? 0) === 0
                      ? "Orphan tag — defined but no node carries it. Use Cmd-click + Apply tag on the canvas to assign it."
                      : `${tagCounts[tag]} node${tagCounts[tag] === 1 ? "" : "s"} carry this tag`
                  }
                >
                  {tagCounts[tag] ?? 0}
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
