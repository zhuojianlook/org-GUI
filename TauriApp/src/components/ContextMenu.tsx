import { useEffect, useMemo } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { setDeadlineColor } from "../api/org";

interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  divider?: boolean; // when true, render a separator BEFORE this item
  /** Optional preview swatch shown beside the label. */
  swatch?: string;
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

  const node = useMemo(() => {
    if (!menu || !doc) return null;
    return doc.nodes.find((n) => n.id === menu.nodeId) ?? null;
  }, [menu, doc]);

  // Any click anywhere (or Escape) closes the menu.
  useEffect(() => {
    if (!menu) return;
    const onDown = () => close();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, close]);

  if (!menu || !node) return null;

  const isExpanded = expanded.has(node.id);
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

  // Keep the menu fully on-screen even when triggered near the right/bottom edges.
  const WIDTH = 220;
  const HEIGHT = items.length * 30 + 12;
  const left = Math.min(menu.x, window.innerWidth - WIDTH - 8);
  const top = Math.min(menu.y, window.innerHeight - HEIGHT - 8);

  return (
    <div
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
      {items.map((it, i) => (
        <div key={i}>
          {it.divider && i > 0 && (
            <div style={{ height: 1, background: "var(--c-border)", margin: "4px 0", opacity: 0.5 }} />
          )}
          <button
            disabled={it.disabled}
            onClick={(e) => {
              e.stopPropagation();
              it.onClick();
              close();
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
