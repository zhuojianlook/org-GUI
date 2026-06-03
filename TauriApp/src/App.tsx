import { useEffect, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { open } from "@tauri-apps/plugin-dialog";
import Toolbar from "./components/Toolbar";
import TabBar from "./components/TabBar";
import TimelineGraph from "./components/TimelineGraph";
import DetailPanel from "./components/DetailPanel";
import EmacsTerminal from "./components/EmacsTerminal";
import AgendaPanel from "./components/AgendaPanel";
import TimelineBand from "./components/TimelineBand";
import ContextMenu from "./components/ContextMenu";
import ErrorToast from "./components/ErrorToast";
import PrereqsModal, { fetchPrereqStatus } from "./components/PrereqsModal";
import GcalPanel from "./components/GcalPanel";
import { useOrgStore } from "./store/useOrgStore";
import { IN_TAURI } from "./api/org";

export default function App() {
  const doc = useOrgStore((s) => s.doc);
  const error = useOrgStore((s) => s.error);
  const panel = useOrgStore((s) => s.panel);
  const setPanel = useOrgStore((s) => s.setPanel);
  const selectedId = useOrgStore((s) => s.selectedId);
  const checkEmacs = useOrgStore((s) => s.checkEmacs);
  const loadFile = useOrgStore((s) => s.loadFile);
  const restoreSession = useOrgStore((s) => s.restoreSession);
  const addHeading = useOrgStore((s) => s.addHeading);
  const showTimeline = useOrgStore((s) => s.showTimeline);
  const openTabs = useOrgStore((s) => s.openTabs);
  const file = useOrgStore((s) => s.file);
  const loading = useOrgStore((s) => s.loading);
  const loadingFile = useOrgStore((s) => s.loadingFile);

  const [showSetup, setShowSetup] = useState(false);
  const [showGcal, setShowGcal] = useState(false);

  useEffect(() => {
    checkEmacs();
    // Browser preview: there's no file dialog, so load the embedded demo.
    if (!IN_TAURI) {
      loadFile("demo.org");
      return;
    }
    // Desktop: restore the previous session — re-open every tab that still
    // exists on disk and activate the last one. Falls back to the single
    // last-opened file for users upgrading from a pre-multi-tab build.
    restoreSession();
    // Auto-open the Setup modal on first launch if Emacs or Doom is missing.
    (async () => {
      const s = await fetchPrereqStatus();
      if (s && (!s.emacs_installed || !s.doom_installed)) setShowSetup(true);
    })();
    // Toolbar's Setup button asks us to open the modal on demand.
    const onOpen = () => setShowSetup(true);
    const onGcal = () => setShowGcal(true);
    window.addEventListener("orggui:openSetup", onOpen);
    window.addEventListener("orggui:openGcal", onGcal);
    return () => {
      window.removeEventListener("orggui:openSetup", onOpen);
      window.removeEventListener("orggui:openGcal", onGcal);
    };
  }, [checkEmacs, restoreSession]);

  const pickFile = async () => {
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
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Toolbar />
      <TabBar />
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* Left column: milestone timeline band on top, graph below */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          {doc && showTimeline && (
            <div style={{ flex: "0 0 32%", minHeight: 180, maxHeight: 380, position: "relative", minWidth: 0 }}>
              <TimelineBand />
            </div>
          )}
          <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
          {doc ? (
            <>
              {/* Key the graph on the active file so switching tabs fully
                  remounts React Flow. Node ids are buffer-position based
                  (`n<begin>`), so two different files routinely share ids
                  like "n1" — without a remount React Flow keeps the stale
                  node objects keyed by those colliding ids and the canvas
                  appears not to change when you switch tabs. A fresh mount
                  guarantees the new file's graph (and a clean fitView). */}
              <ReactFlowProvider key={file ?? "none"}>
                <TimelineGraph />
              </ReactFlowProvider>
              {doc.nodes.length === 0 && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 14,
                    pointerEvents: "none",
                    color: "var(--c-text-dim)",
                  }}
                >
                  <div style={{ fontSize: 16 }}>
                    {doc.title ? `"${doc.title}" is empty` : "Empty file"} — add your first heading
                  </div>
                  <button
                    onClick={() => addHeading(0, "New heading")}
                    style={{
                      pointerEvents: "auto",
                      background: "var(--c-accent)",
                      color: "#fff",
                      border: "none",
                      borderRadius: 8,
                      padding: "10px 20px",
                      fontSize: 14,
                      cursor: "pointer",
                    }}
                  >
                    + Add heading
                  </button>
                </div>
              )}
            </>
          ) : openTabs.length > 0 ? (
            // Tabs are restored but no doc is loaded yet — either a load is
            // in flight, or the active tab's parse failed. Show a context-
            // aware panel (loading / error + retry) instead of the generic
            // "open a file" prompt, which is misleading when tabs exist.
            <TabbedEmptyState
              openTabs={openTabs}
              activeFile={file}
              loading={loading || loadingFile != null}
              error={error}
              onRetry={(f) => loadFile(f)}
              onOpen={pickFile}
            />
          ) : (
            <EmptyState onOpen={pickFile} error={error} />
          )}
          </div>
        </div>

        {/* Right region: whichever pull-out drawer the user has open (or
            nothing — graph fills the width). Each drawer owns its width so the
            tab rail stays a fixed strip on the far right regardless. */}
        {doc && panel === "emacs" && (
          <div
            style={{
              width: 560,
              flexShrink: 0,
              borderLeft: "1px solid var(--c-border)",
              background: "var(--c-surface)",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
            }}
          >
            <EmacsTerminal />
          </div>
        )}
        {doc && panel === "agenda" && (
          <div
            style={{
              width: 620,
              flexShrink: 0,
              borderLeft: "1px solid var(--c-border)",
              background: "var(--c-surface)",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
            }}
          >
            <AgendaPanel />
          </div>
        )}
        {doc && panel === "details" && <DetailPanel />}

        {/* Vertical tab rail on the far right to pull panels in/out. Details
            is disabled until a node is selected — it has nothing to show
            otherwise. */}
        {doc && (
          <div style={{ display: "flex", flexDirection: "column", flexShrink: 0, borderLeft: "1px solid var(--c-border)", background: "var(--c-surface)" }}>
            <TabRailButton
              label="Details"
              active={panel === "details"}
              disabled={!selectedId}
              onClick={() => setPanel(panel === "details" ? null : "details")}
            />
            <TabRailButton label="Agenda" active={panel === "agenda"} onClick={() => setPanel(panel === "agenda" ? null : "agenda")} />
            <TabRailButton label="Emacs" active={panel === "emacs"} onClick={() => setPanel(panel === "emacs" ? null : "emacs")} />
          </div>
        )}
      </div>
      {showSetup && <PrereqsModal onClose={() => setShowSetup(false)} />}
      {showGcal && <GcalPanel onClose={() => setShowGcal(false)} />}
      <ContextMenu />
      <ErrorToast />
    </div>
  );
}

function TabRailButton({
  label,
  active,
  onClick,
  disabled,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={
        disabled
          ? `${label} — select a node first`
          : active
            ? `Close ${label}`
            : `Open ${label}`
      }
      style={{
        writingMode: "vertical-rl",
        textOrientation: "mixed",
        padding: "16px 9px",
        border: "none",
        borderBottom: "1px solid var(--c-border)",
        background: active ? "var(--c-accent)" : "transparent",
        color: active ? "#fff" : disabled ? "var(--c-border)" : "var(--c-text-dim)",
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: 1.5,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  );
}

/** Shown when tabs are restored but no document is loaded — distinguishes
 *  "still loading", "load failed (retry)", and "pick a tab" so the user
 *  isn't told to "open a file" when files are already open in the strip. */
function TabbedEmptyState({
  openTabs,
  activeFile,
  loading,
  error,
  onRetry,
  onOpen,
}: {
  openTabs: string[];
  activeFile: string | null;
  loading: boolean;
  error: string | null;
  onRetry: (file: string) => void;
  onOpen: () => void;
}) {
  // The file we'd retry: the active one if known, else the first tab.
  const target = activeFile ?? openTabs[0];
  const name = (target ?? "").split("/").pop() || target;
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        color: "var(--c-text-dim)",
        padding: 24,
        textAlign: "center",
      }}
    >
      {loading ? (
        <div style={{ fontSize: 16 }}>Loading {name}…</div>
      ) : (
        <>
          <div style={{ fontSize: 16 }}>
            {error ? `Couldn't open ${name}` : `Click a tab above to open it`}
          </div>
          {target && (
            <button
              onClick={() => onRetry(target)}
              style={{
                background: "var(--c-accent)",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                padding: "9px 18px",
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              {error ? `Retry ${name}` : `Open ${name}`}
            </button>
          )}
          <button
            onClick={onOpen}
            style={{
              background: "transparent",
              color: "var(--c-text-dim)",
              border: "1px solid var(--c-border)",
              borderRadius: 8,
              padding: "7px 16px",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Open another .org…
          </button>
          {error && (
            <div style={{ color: "var(--c-red)", maxWidth: 520, fontSize: 12, whiteSpace: "pre-wrap" }}>
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function EmptyState({ onOpen, error }: { onOpen: () => void; error: string | null }) {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        color: "var(--c-text-dim)",
      }}
    >
      <div style={{ fontSize: 18 }}>Open an .org file to visualize it on a timeline</div>
      <button
        onClick={onOpen}
        style={{
          background: "var(--c-accent)",
          color: "#fff",
          border: "none",
          borderRadius: 8,
          padding: "10px 20px",
          fontSize: 14,
          cursor: "pointer",
        }}
      >
        Open .org…
      </button>
      {error && (
        <div style={{ color: "var(--c-red)", maxWidth: 480, textAlign: "center", fontSize: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
}
