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
import { useOrgStore, lastOpenedFile } from "./store/useOrgStore";
import { IN_TAURI } from "./api/org";

export default function App() {
  const doc = useOrgStore((s) => s.doc);
  const error = useOrgStore((s) => s.error);
  const panel = useOrgStore((s) => s.panel);
  const setPanel = useOrgStore((s) => s.setPanel);
  const selectedId = useOrgStore((s) => s.selectedId);
  const checkEmacs = useOrgStore((s) => s.checkEmacs);
  const loadFile = useOrgStore((s) => s.loadFile);
  const addHeading = useOrgStore((s) => s.addHeading);

  const [showSetup, setShowSetup] = useState(false);

  useEffect(() => {
    checkEmacs();
    // Browser preview: there's no file dialog, so load the embedded demo.
    if (!IN_TAURI) {
      loadFile("demo.org");
      return;
    }
    // Desktop: reopen the file from the last session, if any.
    const last = lastOpenedFile();
    if (last) loadFile(last);
    // Auto-open the Setup modal on first launch if Emacs or Doom is missing.
    (async () => {
      const s = await fetchPrereqStatus();
      if (s && (!s.emacs_installed || !s.doom_installed)) setShowSetup(true);
    })();
    // Toolbar's Setup button asks us to open the modal on demand.
    const onOpen = () => setShowSetup(true);
    window.addEventListener("orggui:openSetup", onOpen);
    return () => window.removeEventListener("orggui:openSetup", onOpen);
  }, [checkEmacs, loadFile]);

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
          {doc && (
            <div style={{ flex: "0 0 32%", minHeight: 180, maxHeight: 380, position: "relative", minWidth: 0 }}>
              <TimelineBand />
            </div>
          )}
          <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
          {doc ? (
            <>
              <ReactFlowProvider>
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
