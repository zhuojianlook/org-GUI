import { useMemo, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";

/**
 * Floating "selection bar" that appears at the bottom of the canvas when the
 * user has Cmd/Ctrl-clicked one or more nodes. Lets them apply an existing
 * tag, type a new one, or clear the selection in one shot — much faster than
 * tagging nodes one at a time in Emacs.
 */
export default function SelectionBar() {
  const doc = useOrgStore((s) => s.doc);
  const tagColors = useOrgStore((s) => s.tagColors);
  const multiSelected = useOrgStore((s) => s.multiSelected);
  const clearMultiSelected = useOrgStore((s) => s.clearMultiSelected);
  const applyTagToSelection = useOrgStore((s) => s.applyTagToSelection);
  const saving = useOrgStore((s) => s.saving);

  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState("");

  // De-duped list of every tag the user might want to apply: real tags from
  // any node PLUS orphan tags defined in the colour map (i.e. user typed them
  // in the Tags popover but never attached them yet).
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

  if (multiSelected.size === 0) return null;

  const apply = async (tag: string) => {
    const t = tag.trim();
    if (!t) return;
    setPicking(false);
    setDraft("");
    await applyTagToSelection(t);
    // Keep the selection so the user can keep applying tags to the same group.
  };

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 14px",
        background: "var(--c-surface)",
        border: "1px solid var(--c-amber)",
        borderRadius: 999,
        boxShadow: "0 6px 24px rgba(0,0,0,0.5)",
        fontSize: 13,
        color: "var(--c-text)",
      }}
    >
      <span style={{ fontWeight: 700, color: "var(--c-amber)" }}>
        {multiSelected.size}
      </span>
      <span style={{ color: "var(--c-text-dim)" }}>selected</span>
      <div style={{ width: 1, height: 18, background: "var(--c-border)" }} />

      {picking ? (
        <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 6 }}>
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") apply(draft);
              if (e.key === "Escape") {
                setPicking(false);
                setDraft("");
              }
            }}
            placeholder="tag name"
            style={{
              padding: "3px 8px",
              borderRadius: 4,
              border: "1px solid var(--c-border)",
              background: "var(--c-bg)",
              color: "var(--c-text)",
              fontFamily: "ui-monospace, monospace",
              fontSize: 12.5,
              width: 140,
            }}
          />
          <button
            onClick={() => apply(draft)}
            disabled={!draft.trim() || saving}
            style={primaryBtn}
          >
            Apply
          </button>
          {allTags.length > 0 && (
            <div
              style={{
                position: "absolute",
                bottom: "calc(100% + 6px)",
                left: 0,
                minWidth: 180,
                maxHeight: 200,
                overflowY: "auto",
                background: "var(--c-surface)",
                border: "1px solid var(--c-border)",
                borderRadius: 6,
                boxShadow: "0 6px 24px rgba(0,0,0,0.5)",
                padding: 4,
                display: "flex",
                flexDirection: "column",
                gap: 1,
              }}
            >
              <div style={{ padding: "4px 8px", fontSize: 10, letterSpacing: 0.5, textTransform: "uppercase", color: "var(--c-text-dim)" }}>
                Existing tags
              </div>
              {allTags
                .filter((t) => !draft || t.toLowerCase().includes(draft.toLowerCase()))
                .map((t) => (
                  <button
                    key={t}
                    onClick={() => apply(t)}
                    style={{
                      textAlign: "left",
                      background: "transparent",
                      border: "none",
                      padding: "4px 8px",
                      borderRadius: 4,
                      cursor: "pointer",
                      fontSize: 12.5,
                      color: "var(--c-text)",
                      fontFamily: "ui-monospace, monospace",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--c-surface2)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    :{t}:
                  </button>
                ))}
            </div>
          )}
        </div>
      ) : (
        <button onClick={() => setPicking(true)} style={primaryBtn} disabled={saving}>
          🏷 Apply tag…
        </button>
      )}

      <button
        onClick={() => {
          clearMultiSelected();
          setPicking(false);
          setDraft("");
        }}
        style={ghostBtn}
        title="Clear selection"
      >
        ✕ Clear
      </button>
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  background: "var(--c-amber)",
  color: "#1c1c1e",
  border: "none",
  borderRadius: 4,
  padding: "4px 12px",
  fontSize: 12.5,
  fontWeight: 700,
  cursor: "pointer",
  fontFamily: "inherit",
};

const ghostBtn: React.CSSProperties = {
  background: "transparent",
  color: "var(--c-text-dim)",
  border: "1px solid var(--c-border)",
  borderRadius: 4,
  padding: "4px 10px",
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "inherit",
};
