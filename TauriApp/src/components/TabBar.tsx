import { useOrgStore } from "../store/useOrgStore";
import { IN_TAURI } from "../api/org";
import { open } from "@tauri-apps/plugin-dialog";

/**
 * Thin strip below the main toolbar that lists every open .org file as a
 * clickable tab. Click a tab → loadFile(path). Click the × → closeTab(path).
 * Click the + → pick another file and open it in a new tab. Only renders
 * when at least one file is open (the empty state already has its own Open
 * .org button so we don't double up).
 *
 * Per-file state (positions, expanded set, milestones, tag colours, table-
 * collapse flags, deadline colours) already persists in localStorage keyed
 * by the absolute file path, so switching tabs restores each file's view
 * naturally — only the doc itself needs to be re-parsed by loadFile.
 */
export default function TabBar() {
  const openTabs = useOrgStore((s) => s.openTabs);
  const file = useOrgStore((s) => s.file);
  const loadingFile = useOrgStore((s) => s.loadingFile);
  const loadFile = useOrgStore((s) => s.loadFile);
  const closeTab = useOrgStore((s) => s.closeTab);
  // Highlight the tab the user JUST clicked even before its parse
  // completes, otherwise the click feels unresponsive while the bridge
  // is reading the file. Falls back to the currently-mounted file once
  // no load is in flight.
  const activePath = loadingFile ?? file;

  // Hide the strip entirely when no tabs are open — the EmptyState component
  // in App.tsx will be visible and offers its own "Open .org…" affordance.
  if (openTabs.length === 0) return null;

  const pick = async () => {
    if (!IN_TAURI) {
      await loadFile("demo.org");
      return;
    }
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Org files", extensions: ["org"] }],
    });
    if (typeof selected === "string") await loadFile(selected);
  };

  return (
    <div
      style={{
        height: 30,
        flexShrink: 0,
        display: "flex",
        alignItems: "stretch",
        background: "var(--c-surface2)",
        borderBottom: "1px solid var(--c-border)",
        overflowX: "auto",
        overflowY: "hidden",
        paddingLeft: 8,
      }}
    >
      {openTabs.map((path) => {
        const isPending = loadingFile === path;
        // "Active" highlight follows the load target while a switch is in
        // flight, then settles on the loaded file.
        const active = path === activePath;
        // The tab is "settled" (a no-op to click) ONLY when it's the fully
        // loaded file and nothing is loading. Crucially we do NOT gate on
        // `path === file` alone: during a switch, `file` still points at the
        // PREVIOUS tab while its parse runs, and the old guard made that
        // previous tab unclickable — so if the new tab's parse stalled, the
        // whole strip froze. Now any click that isn't the settled-active tab
        // (re)loads that tab, superseding an in-flight/stuck load.
        const settled = path === file && loadingFile == null;
        const name = path.split("/").pop() || path;
        return (
          <div
            key={path}
            onClick={() => {
              if (settled) return; // already showing this file — no-op
              loadFile(path); // supersedes any in-flight/stuck load
            }}
            title={isPending ? `${path}\n(loading…)` : path}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "0 10px 0 12px",
              borderRight: "1px solid var(--c-border)",
              background: active ? "var(--c-surface)" : "transparent",
              color: active ? "var(--c-text)" : "var(--c-text-dim)",
              fontSize: 12,
              fontWeight: active ? 600 : 500,
              cursor: settled ? "default" : "pointer",
              // The active tab sits flush with the working area below — its
              // border-bottom disappears into the bg, while inactive tabs
              // sit recessed.
              borderTop: active ? "2px solid var(--c-accent)" : "2px solid transparent",
              userSelect: "none",
              flexShrink: 0,
              maxWidth: 240,
            }}
          >
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: 200,
                fontStyle: isPending ? "italic" : "normal",
              }}
            >
              {name}
              {isPending && (
                <span aria-hidden style={{ marginLeft: 4, color: "var(--c-text-dim)" }}>
                  …
                </span>
              )}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(path);
              }}
              title={`Close ${name}`}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--c-text-dim)",
                cursor: "pointer",
                fontSize: 12,
                lineHeight: 1,
                padding: "2px 4px",
                borderRadius: 3,
                marginLeft: 2,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              ✕
            </button>
          </div>
        );
      })}
      <button
        onClick={pick}
        title="Open another .org file in a new tab"
        style={{
          background: "transparent",
          color: "var(--c-text-dim)",
          border: "none",
          padding: "0 12px",
          fontSize: 14,
          cursor: "pointer",
          flexShrink: 0,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--c-text)")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--c-text-dim)")}
      >
        +
      </button>
    </div>
  );
}
