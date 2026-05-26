import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { IN_TAURI } from "../api/org";

interface PrereqStatus {
  platform: "macos" | "linux" | "windows" | "unknown";
  emacs_installed: boolean;
  emacsclient_path: string | null;
  homebrew_installed: boolean;
  doom_dir: string | null;
  doom_installed: boolean;
  can_auto_install: boolean;
}

export async function fetchPrereqStatus(): Promise<PrereqStatus | null> {
  if (!IN_TAURI) return null;
  try {
    return await invoke<PrereqStatus>("check_prereqs");
  } catch {
    return null;
  }
}

/**
 * The Setup modal: shows which prerequisites (Emacs / Doom / Homebrew) are
 * already installed, runs the one-click installer, and streams the install
 * log live so the user can see what's happening.
 */
export default function PrereqsModal({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<PrereqStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  const refresh = async () => setStatus(await fetchPrereqStatus());

  useEffect(() => {
    refresh();
  }, []);

  // Stream install log lines + final done/error from the Rust side.
  useEffect(() => {
    if (!IN_TAURI) return;
    let offLog: UnlistenFn | undefined;
    let offDone: UnlistenFn | undefined;
    let offErr: UnlistenFn | undefined;
    (async () => {
      offLog = await listen<string>("install://log", (e) =>
        setLog((l) => [...l, e.payload]),
      );
      offDone = await listen<unknown>("install://done", () => {
        setLog((l) => [...l, "✅ All prerequisites installed."]);
        refresh();
      });
      offErr = await listen<string>("install://error", (e) =>
        setLog((l) => [...l, "❌ " + e.payload]),
      );
    })();
    return () => {
      offLog?.();
      offDone?.();
      offErr?.();
    };
  }, []);

  // Auto-scroll the log as new lines arrive.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const startInstall = async () => {
    setInstalling(true);
    setLog([]);
    try {
      await invoke("install_prereqs");
    } catch (e) {
      // error event already added to log
      setLog((l) => [...l, "❌ " + String(e)]);
    } finally {
      setInstalling(false);
    }
  };

  if (!status) {
    return (
      <Overlay>
        <div style={panel}>
          <div style={{ color: "var(--c-text-dim)" }}>Checking prerequisites…</div>
        </div>
      </Overlay>
    );
  }

  const allGood = status.emacs_installed && status.doom_installed;

  return (
    <Overlay>
      <div style={panel}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <h2 style={{ margin: 0, fontSize: 18, color: "var(--c-text)" }}>Set up org-GUI</h2>
          <button
            onClick={onClose}
            title="Close"
            style={{ background: "transparent", border: "none", color: "var(--c-text-dim)", cursor: "pointer", fontSize: 18 }}
          >
            ✕
          </button>
        </div>

        <p style={{ fontSize: 13, color: "var(--c-text-dim)", margin: 0, lineHeight: 1.5 }}>
          org-GUI uses Emacs as its org-mode backend, with Doom Emacs for sensible
          defaults. Click <b>Install prerequisites</b> below and we'll set them up
          for you. Already installed? You're good to go.
        </p>

        <StatusRow label="Emacs" ok={status.emacs_installed} detail={status.emacsclient_path ?? "Not found"} />
        {status.platform === "macos" && (
          <StatusRow
            label="Homebrew"
            ok={status.homebrew_installed}
            detail={status.homebrew_installed ? "Available" : "Will be installed if needed"}
            optional
          />
        )}
        <StatusRow label="Doom Emacs" ok={status.doom_installed} detail={status.doom_dir ?? "Not found"} />

        {!allGood && status.can_auto_install && (
          <button
            onClick={startInstall}
            disabled={installing}
            style={{
              ...primaryBtn,
              opacity: installing ? 0.7 : 1,
              cursor: installing ? "wait" : "pointer",
            }}
          >
            {installing ? "Installing… (this takes a few minutes)" : "Install prerequisites"}
          </button>
        )}

        {!allGood && !status.can_auto_install && (
          <ManualInstructions platform={status.platform} />
        )}

        {allGood && (
          <button onClick={onClose} style={primaryBtn}>
            All set — open my org file
          </button>
        )}

        {(installing || log.length > 0) && (
          <div
            ref={logRef}
            style={{
              maxHeight: 240,
              overflowY: "auto",
              background: "#1c1c1e",
              padding: 10,
              borderRadius: 6,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 11.5,
              lineHeight: 1.4,
              color: "#cbd5e1",
              whiteSpace: "pre-wrap",
            }}
          >
            {log.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        )}
      </div>
    </Overlay>
  );
}

function StatusRow({
  label,
  ok,
  detail,
  optional,
}: {
  label: string;
  ok: boolean;
  detail: string;
  optional?: boolean;
}) {
  const mark = ok ? "✓" : optional ? "○" : "✕";
  const color = ok ? "#98be65" : optional ? "var(--c-text-dim)" : "#ff6c6b";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 12px",
        border: "1px solid var(--c-border)",
        borderRadius: 6,
        background: "var(--c-bg)",
      }}
    >
      <span style={{ fontSize: 18, fontWeight: 700, color, width: 16, flexShrink: 0 }}>{mark}</span>
      <span style={{ flex: 0, fontWeight: 600, color: "var(--c-text)", minWidth: 100 }}>{label}</span>
      <span style={{ flex: 1, fontSize: 11.5, color: "var(--c-text-dim)", fontFamily: "ui-monospace, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {detail}
      </span>
    </div>
  );
}

function ManualInstructions({ platform }: { platform: string }) {
  if (platform === "windows") {
    return (
      <div style={{ fontSize: 13, color: "var(--c-text-dim)", lineHeight: 1.6 }}>
        <p style={{ marginTop: 0 }}>
          One-click install isn't supported on Windows yet. Install the bits manually:
        </p>
        <ol style={{ paddingLeft: 20, margin: 0 }}>
          <li>
            Emacs — <a href="https://gnu.org/software/emacs/download.html#windows" target="_blank" rel="noreferrer">official Windows builds</a>, or
            <code style={code}> choco install emacs </code> via Chocolatey.
          </li>
          <li>
            Git — <a href="https://git-scm.com/download/win" target="_blank" rel="noreferrer">Git for Windows</a>.
          </li>
          <li>
            In Git Bash: <code style={code}>git clone https://github.com/doomemacs/doomemacs ~/.config/emacs && ~/.config/emacs/bin/doom install</code>
          </li>
        </ol>
      </div>
    );
  }
  return (
    <div style={{ fontSize: 13, color: "var(--c-text-dim)" }}>
      Couldn't detect this platform automatically. Please install Emacs and{" "}
      <a href="https://github.com/doomemacs/doomemacs" target="_blank" rel="noreferrer">
        Doom Emacs
      </a>{" "}
      manually.
    </div>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10000,
      }}
    >
      {children}
    </div>
  );
}

const panel: React.CSSProperties = {
  width: 640,
  maxWidth: "92vw",
  maxHeight: "90vh",
  overflow: "auto",
  background: "var(--c-surface)",
  border: "1px solid var(--c-border)",
  borderRadius: 10,
  padding: 22,
  display: "flex",
  flexDirection: "column",
  gap: 12,
  boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
};

const primaryBtn: React.CSSProperties = {
  background: "var(--c-accent)",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  padding: "10px 16px",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
  alignSelf: "flex-start",
};

const code: React.CSSProperties = {
  fontFamily: "ui-monospace, monospace",
  background: "var(--c-bg)",
  padding: "1px 5px",
  borderRadius: 3,
  fontSize: 11,
};
