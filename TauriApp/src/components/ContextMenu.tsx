import { useEffect, useMemo, useRef, useState } from "react";
import { useOrgStore, gcalCalendarTagSet } from "../store/useOrgStore";
import { setDeadlineColor, setTags } from "../api/org";
import { nodeStableKey } from "../utils/layout";

interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  divider?: boolean; // when true, render a separator BEFORE this item
  /** Optional preview swatch shown beside the label. */
  swatch?: string;
  /** When true, clicking this item does NOT close the menu (used by the
   *  "Add tag…" item which switches the menu into a sub-view). */
  keepOpen?: boolean;
}

const DEADLINE_PRESETS: { label: string; color: string }[] = [
  { label: "Red (default)", color: "#ff6c6b" },
  { label: "Amber", color: "#e0a458" },
  { label: "Green", color: "#98be65" },
  { label: "Blue", color: "#51afef" },
  { label: "Violet", color: "#c678dd" },
  { label: "Teal", color: "#5fb3a1" },
];

/** Open the OS-native color picker via a transient hidden <input type="color">. */
function pickCustomColor(initial: string, onPick: (color: string) => void) {
  const inp = document.createElement("input");
  inp.type = "color";
  inp.value = initial;
  inp.style.position = "fixed";
  inp.style.opacity = "0";
  inp.style.pointerEvents = "none";
  document.body.appendChild(inp);
  inp.addEventListener("change", () => {
    onPick(inp.value);
    inp.remove();
  });
  inp.addEventListener("blur", () => {
    setTimeout(() => inp.remove(), 200);
  });
  inp.click();
}

/**
 * Right-click context menu for nodes in the graph. Mounted at App level,
 * driven by `contextMenu` state in the store: any component can call
 * `openContextMenu(x, y, nodeId)` to surface options for that node.
 */
export default function ContextMenu() {
  const menu = useOrgStore((s) => s.contextMenu);
  const close = useOrgStore((s) => s.closeContextMenu);
  const doc = useOrgStore((s) => s.doc);
  const addHeading = useOrgStore((s) => s.addHeading);
  const addTableChild = useOrgStore((s) => s.addTableChild);
  const editInEmacs = useOrgStore((s) => s.editInEmacs);
  const archive = useOrgStore((s) => s.archive);
  const removeNode = useOrgStore((s) => s.removeNode);
  const toggleExpand = useOrgStore((s) => s.toggleExpand);
  const expanded = useOrgStore((s) => s.expanded);
  const select = useOrgStore((s) => s.select);
  const edit = useOrgStore((s) => s.edit);
  const applyTagToNode = useOrgStore((s) => s.applyTagToNode);
  const tagColors = useOrgStore((s) => s.tagColors);

  // The menu toggles between "main" actions and the "tag picker" sub-view so
  // single-node tagging is discoverable without the Cmd-click bulk gesture.
  const [mode, setMode] = useState<"main" | "tag">("main");
  const [tagDraft, setTagDraft] = useState("");
  useEffect(() => {
    // Reset to main view + draft any time the menu reopens on a different node.
    if (menu) {
      setMode("main");
      setTagDraft("");
    }
  }, [menu?.nodeId, menu]);

  const node = useMemo(() => {
    if (!menu || !doc) return null;
    return doc.nodes.find((n) => n.id === menu.nodeId) ?? null;
  }, [menu, doc]);

  const menuRef = useRef<HTMLDivElement>(null);

  // Close on any outside click or Escape. We listen on the *capture* phase of
  // pointerdown so React Flow / our own wrapRef capture handlers can't swallow
  // the event before we see it (which was what made canvas clicks not close
  // the menu). The target check skips clicks inside the menu itself.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, close]);

  // The tag-picker view's data lists are declared as hooks here so they're
  // called on EVERY render — even when the menu is closed — to keep React's
  // hooks order stable. Without this, opening the menu mid-session would
  // suddenly invoke new useMemo calls and React would freeze the tree with
  // the "rendered fewer hooks than expected" error (which is what produced
  // the grey-screen lock-up on right-click).
  const knownTags = useMemo(() => {
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
  const filteredTags = useMemo(() => {
    const q = tagDraft.trim().toLowerCase();
    if (!q) return knownTags;
    return knownTags.filter((t) => t.toLowerCase().includes(q));
  }, [knownTags, tagDraft]);

  if (!menu || !node) return null;

  const isExpanded = expanded.has(nodeStableKey(node));
  const hasDeadline = !!node.deadline;
  const items: MenuItem[] = [
    {
      label: "+ Add child heading",
      onClick: () => addHeading(node.begin, "New heading"),
    },
    {
      label: "+ Add table (as child)",
      onClick: () => addTableChild(node),
    },
    {
      label: isExpanded ? "▾ Collapse subtree" : "▸ Expand subtree",
      onClick: () => toggleExpand(node.id),
      divider: true,
    },
    {
      label: "✎ Edit in Emacs",
      onClick: () => editInEmacs(node),
    },
    {
      label: "◎ Focus / select",
      onClick: () => select(node.id),
    },
    {
      label: "🏷 Add / remove tags…",
      onClick: () => setMode("tag"),
      keepOpen: true,
      divider: true,
    },
    // Deadline-color presets: only meaningful when the node actually has a
    // deadline. Each preset is a one-click swap; "Custom…" opens the native
    // color picker. "Clear" wipes the property back to defaults.
    ...(hasDeadline
      ? ([
          { label: "── Deadline color ──", onClick: () => {}, disabled: true, divider: true },
          ...DEADLINE_PRESETS.map((p) => ({
            label: p.label,
            swatch: p.color,
            onClick: () => edit(setDeadlineColor, node, p.color),
          })),
          {
            label: "Custom…",
            onClick: () =>
              pickCustomColor(node.deadlineColor ?? "#ff6c6b", (c) =>
                edit(setDeadlineColor, node, c),
              ),
          },
          {
            label: "Clear (use default)",
            onClick: () => edit(setDeadlineColor, node, ""),
            disabled: !node.deadlineColor,
          },
        ] as MenuItem[])
      : []),
    {
      label: "⤓ Archive subtree",
      onClick: () => archive(node),
      divider: true,
    },
    {
      label: "✕ Delete subtree",
      onClick: () => removeNode(node),
      danger: true,
    },
  ];

  const applyTag = async (tag: string) => {
    const t = tag.trim().replace(/^:|:$/g, "");
    if (!t) return;
    await applyTagToNode(node, t);
    close();
  };

  // Remove one of the node's OWN tags. Calendar-derived tags (📅) aren't real
  // org tags on the heading, so they never appear here; inherited tags live on
  // an ancestor and can't be removed from this node.
  const removeTag = (t: string) => {
    if (!node) return;
    const remaining = (node.tags ?? []).filter((x) => x !== t);
    void edit(setTags, node, remaining.join(" "));
  };
  const calTagSet = gcalCalendarTagSet();
  const ownTags = node.tags ?? [];

  // Keep the menu fully on-screen even when triggered near the right/bottom edges.
  const WIDTH = 220;
  const HEIGHT = mode === "tag" ? 320 : items.length * 30 + 12;
  const left = Math.min(menu.x, window.innerWidth - WIDTH - 8);
  const top = Math.min(menu.y, window.innerHeight - HEIGHT - 8);

  return (
    <div
      ref={menuRef}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        left,
        top,
        minWidth: WIDTH,
        zIndex: 10001,
        background: "var(--c-surface)",
        border: "1px solid var(--c-border)",
        borderRadius: 8,
        padding: 4,
        boxShadow: "0 8px 28px rgba(0,0,0,0.55)",
      }}
    >
      {mode === "tag" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: 4, width: WIDTH }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setMode("main");
                setTagDraft("");
              }}
              title="Back"
              style={{
                background: "transparent",
                border: "1px solid var(--c-border)",
                borderRadius: 4,
                padding: "2px 6px",
                fontSize: 11,
                color: "var(--c-text-dim)",
                cursor: "pointer",
              }}
            >
              ‹
            </button>
            <span style={{ fontSize: 10.5, letterSpacing: 0.5, textTransform: "uppercase", color: "var(--c-text-dim)", fontWeight: 700 }}>
              Tags on this node
            </span>
          </div>
          {/* Current own tags, each removable with ×. (Calendar 📅 tags aren't
              real heading tags, so they never show up here.) */}
          {ownTags.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {ownTags.map((t) => {
                const locked = calTagSet.has(t);
                const c = tagColors[t];
                return (
                  <span
                    key={`own-${t}`}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 3,
                      padding: "1px 4px 1px 6px",
                      borderRadius: 9,
                      fontSize: 11,
                      fontWeight: 600,
                      fontFamily: "ui-monospace, monospace",
                      background: c ? `${c}33` : "var(--c-surface2)",
                      border: `1px solid ${c ? `${c}99` : "var(--c-border)"}`,
                      color: "var(--c-text)",
                    }}
                  >
                    {locked && <span aria-hidden>📅</span>}
                    {t}
                    {!locked && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeTag(t);
                        }}
                        title={`Remove :${t}:`}
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
              })}
            </div>
          )}
          <span style={{ fontSize: 10, letterSpacing: 0.4, textTransform: "uppercase", color: "var(--c-text-dim)", fontWeight: 700, marginTop: 2 }}>
            Add a tag
          </span>
          <input
            autoFocus
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyTag(tagDraft);
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setMode("main");
                setTagDraft("");
              }
            }}
            placeholder="filter / type new tag"
            style={{
              background: "var(--c-bg)",
              color: "var(--c-text)",
              border: "1px solid var(--c-border)",
              borderRadius: 4,
              padding: "4px 6px",
              fontSize: 12,
              fontFamily: "ui-monospace, monospace",
              outline: "none",
            }}
          />
          <div style={{ maxHeight: 180, overflowY: "auto", display: "flex", flexDirection: "column", gap: 1 }}>
            {filteredTags.length === 0 ? (
              <div style={{ padding: "8px 6px", fontSize: 11, color: "var(--c-text-dim)" }}>
                {tagDraft.trim()
                  ? `Press Enter to create :${tagDraft.trim().replace(/^:|:$/g, "")}: and apply`
                  : "No tags yet — type one and press Enter."}
              </div>
            ) : (
              filteredTags.map((t) => {
                const already = (node.tagsAll ?? []).includes(t);
                return (
                  <button
                    key={t}
                    disabled={already}
                    onClick={(e) => {
                      e.stopPropagation();
                      applyTag(t);
                    }}
                    title={already ? `This node already has :${t}:` : `Apply :${t}: to this node`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      textAlign: "left",
                      background: "transparent",
                      border: "none",
                      padding: "4px 6px",
                      borderRadius: 4,
                      fontSize: 12,
                      fontFamily: "ui-monospace, monospace",
                      color: already ? "var(--c-text-dim)" : "var(--c-text)",
                      cursor: already ? "not-allowed" : "pointer",
                      opacity: already ? 0.5 : 1,
                    }}
                    onMouseEnter={(e) => {
                      if (!already) e.currentTarget.style.background = "var(--c-surface2)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 2,
                        background: tagColors[t] ?? "var(--c-border)",
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      :{t}:
                    </span>
                    {already && <span style={{ fontSize: 10 }}>✓</span>}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
      {/* Current removable tags — shown right in the MAIN menu so removing a tag
          is one click (no need to dig into the "Add tag…" sub-view). Calendar
          📅 tags aren't real heading tags and can't be removed here. */}
      {mode === "main" && ownTags.filter((t) => !calTagSet.has(t)).length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 4,
            padding: "6px 8px",
            marginBottom: 2,
            borderBottom: "1px solid var(--c-border)",
          }}
        >
          {ownTags
            .filter((t) => !calTagSet.has(t))
            .map((t) => {
              const c = tagColors[t];
              return (
                <span
                  key={`m-own-${t}`}
                  title={`Click × to remove :${t}:`}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 3,
                    padding: "1px 3px 1px 6px",
                    borderRadius: 9,
                    fontSize: 11,
                    fontWeight: 600,
                    fontFamily: "ui-monospace, monospace",
                    background: c ? `${c}33` : "var(--c-surface2)",
                    border: `1px solid ${c ? `${c}99` : "var(--c-border)"}`,
                    color: "var(--c-text)",
                  }}
                >
                  {t}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeTag(t);
                    }}
                    title={`Remove :${t}:`}
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
                </span>
              );
            })}
        </div>
      )}
      {mode === "main" && items.map((it, i) => (
        <div key={i}>
          {it.divider && i > 0 && (
            <div style={{ height: 1, background: "var(--c-border)", margin: "4px 0", opacity: 0.5 }} />
          )}
          <button
            disabled={it.disabled}
            onClick={(e) => {
              e.stopPropagation();
              it.onClick();
              if (!it.keepOpen) close();
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              textAlign: "left",
              background: "transparent",
              border: "none",
              padding: "6px 10px",
              borderRadius: 4,
              fontSize: 13,
              fontFamily: "inherit",
              color: it.danger ? "var(--c-red)" : "var(--c-text)",
              cursor: it.disabled ? "not-allowed" : "pointer",
              opacity: it.disabled ? 0.45 : 1,
            }}
            onMouseEnter={(e) => {
              if (!it.disabled) e.currentTarget.style.background = "var(--c-surface2)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            {it.swatch && (
              <span
                aria-hidden
                style={{
                  display: "inline-block",
                  width: 12,
                  height: 12,
                  borderRadius: 3,
                  background: it.swatch,
                  border: "1px solid rgba(255,255,255,0.15)",
                  flexShrink: 0,
                }}
              />
            )}
            <span style={{ flex: 1 }}>{it.label}</span>
          </button>
        </div>
      ))}
    </div>
  );
}
