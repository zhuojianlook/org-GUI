import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { useOrgStore } from "../store/useOrgStore";
import { gcalInstall, gcalStatus, gcalSync, type GcalStatus, IN_TAURI } from "../api/org";

// Persisted, non-secret-aware: the client secret lives in localStorage. It's
// the user's OWN Google OAuth client secret for a desktop app, on their own
// machine — acceptable for a personal-use integration, and never leaves the
// device except to Google during auth.
const CFG_KEY = "org-gui:gcal:config";
interface GcalConfig {
  clientId: string;
  clientSecret: string;
  calendarId: string;
  file: string;
}
function loadCfg(): GcalConfig {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (raw) return { calendarId: "primary", ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { clientId: "", clientSecret: "", calendarId: "primary", file: "" };
}
function saveCfg(c: GcalConfig) {
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

/**
 * Google Calendar integration via the org-gcal Emacs package. org-gcal is
 * installed self-contained into ~/.org-gui/elpa (decoupled from the user's
 * Doom setup) and pulls calendar events into a chosen .org file, which then
 * renders on the timeline like any other scheduled/timestamped entry.
 *
 * One-way for now (Google → org). Two-way push is a future step.
 */
export default function GcalPanel({ onClose }: { onClose: () => void }) {
  const loadFile = useOrgStore((s) => s.loadFile);
  const currentFile = useOrgStore((s) => s.file);

  const [cfg, setCfg] = useState<GcalConfig>(() => {
    const c = loadCfg();
    if (!c.file && currentFile) c.file = currentFile;
    return c;
  });
  const [status, setStatus] = useState<GcalStatus | null>(null);
  const [busy, setBusy] = useState<null | "status" | "install" | "sync">(null);
  const [msg, setMsg] = useState<string>("");
  const [err, setErr] = useState<string>("");

  const refreshStatus = async () => {
    setBusy("status");
    setErr("");
    try {
      setStatus(await gcalStatus());
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };
  useEffect(() => {
    if (IN_TAURI) refreshStatus();
  }, []);

  const set = (patch: Partial<GcalConfig>) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    saveCfg(next);
  };

  const onInstall = async () => {
    setBusy("install");
    setErr("");
    setMsg("Installing org-gcal and its dependencies (1–2 min)…");
    try {
      const r = await gcalInstall();
      setMsg(r);
      await refreshStatus();
    } catch (e) {
      setErr(String(e));
      setMsg("");
    } finally {
      setBusy(null);
    }
  };

  const onPickFile = async () => {
    const path = await save({
      defaultPath: cfg.file || "google-calendar.org",
      filters: [{ name: "Org files", extensions: ["org"] }],
    });
    if (typeof path === "string") {
      const p = path.endsWith(".org") ? path : `${path}.org`;
      set({ file: p });
    }
  };

  const canSync =
    !!cfg.clientId.trim() && !!cfg.clientSecret.trim() && !!cfg.calendarId.trim() && !!cfg.file.trim();

  const onSync = async () => {
    setBusy("sync");
    setErr("");
    setMsg(
      "Syncing… if this is the first time, your browser will open for Google sign-in — approve it, then come back.",
    );
    try {
      await gcalSync(cfg.clientId.trim(), cfg.clientSecret.trim(), cfg.calendarId.trim(), cfg.file.trim());
      setMsg("Synced. Opening the calendar file…");
      await loadFile(cfg.file.trim());
      await refreshStatus();
      setMsg("Synced — events are now on the timeline.");
    } catch (e) {
      setErr(String(e));
      setMsg("");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10050,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxHeight: "86vh",
          overflowY: "auto",
          background: "var(--c-surface)",
          border: "1px solid var(--c-border)",
          borderRadius: 12,
          padding: 20,
          boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
          color: "var(--c-text)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>📅 Google Calendar</h2>
          <button onClick={onClose} style={iconBtn} title="Close">
            ✕
          </button>
        </div>

        {/* Status line */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14, fontSize: 12 }}>
          <Pill ok={status?.available} label={status?.available ? "Installed" : "Not installed"} />
          <Pill ok={status?.configured} label={status?.configured ? "Configured" : "Not configured"} />
          <Pill ok={status?.authorized} label={status?.authorized ? "Authorized" : "Not authorized"} />
          {busy === "status" && <span style={{ color: "var(--c-text-dim)" }}>checking…</span>}
        </div>

        {/* Install */}
        {status && !status.available && (
          <div style={{ marginBottom: 16 }}>
            <p style={{ fontSize: 13, color: "var(--c-text-dim)", marginTop: 0 }}>
              org-gcal isn't installed yet. This downloads it (and its dependencies) into a private
              folder, independent of your own Emacs config.
            </p>
            <button onClick={onInstall} disabled={busy != null} style={primaryBtn}>
              {busy === "install" ? "Installing…" : "Install org-gcal"}
            </button>
          </div>
        )}

        {/* Setup help */}
        <details style={{ marginBottom: 14, fontSize: 12.5, color: "var(--c-text-dim)" }}>
          <summary style={{ cursor: "pointer", color: "var(--c-text)" }}>
            One-time Google setup (click for steps)
          </summary>
          <ol style={{ paddingLeft: 18, lineHeight: 1.6 }}>
            <li>
              In{" "}
              <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer" style={link}>
                Google Cloud Console
              </a>
              , create a project and enable the <b>Google Calendar API</b>.
            </li>
            <li>
              Configure the OAuth consent screen (External, add yourself as a test user).
            </li>
            <li>
              Create an OAuth <b>Client ID</b> of type <b>Desktop app</b> — copy the Client ID and
              Client secret below.
            </li>
            <li>Your Calendar ID is usually your email, or <code>primary</code> for the main one.</li>
          </ol>
        </details>

        {/* Config form */}
        <Field label="Client ID">
          <input
            value={cfg.clientId}
            onChange={(e) => set({ clientId: e.target.value })}
            placeholder="…apps.googleusercontent.com"
            style={input}
          />
        </Field>
        <Field label="Client secret">
          <input
            type="password"
            value={cfg.clientSecret}
            onChange={(e) => set({ clientSecret: e.target.value })}
            placeholder="GOCSPX-…"
            style={input}
          />
        </Field>
        <Field label="Calendar ID">
          <input
            value={cfg.calendarId}
            onChange={(e) => set({ calendarId: e.target.value })}
            placeholder="primary  (or you@gmail.com)"
            style={input}
          />
        </Field>
        <Field label="Target .org file (events are written here)">
          <div style={{ display: "flex", gap: 6 }}>
            <input
              value={cfg.file}
              onChange={(e) => set({ file: e.target.value })}
              placeholder="/path/to/google-calendar.org"
              style={{ ...input, flex: 1 }}
            />
            <button onClick={onPickFile} style={secondaryBtn}>
              Browse…
            </button>
          </div>
        </Field>

        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
          <button
            onClick={onSync}
            disabled={busy != null || !status?.available || !canSync}
            style={{ ...primaryBtn, opacity: !status?.available || !canSync ? 0.5 : 1 }}
            title={
              !status?.available
                ? "Install org-gcal first"
                : !canSync
                  ? "Fill in all fields above"
                  : "Pull events from Google into the target file"
            }
          >
            {busy === "sync" ? "Syncing…" : "Sync now (Google → org)"}
          </button>
          <button onClick={refreshStatus} disabled={busy != null} style={secondaryBtn}>
            Refresh status
          </button>
        </div>

        {msg && <p style={{ fontSize: 12.5, color: "var(--c-text-dim)", marginBottom: 0 }}>{msg}</p>}
        {err && (
          <p style={{ fontSize: 12.5, color: "var(--c-red)", whiteSpace: "pre-wrap", marginBottom: 0 }}>
            {err}
          </p>
        )}
        <p style={{ fontSize: 11, color: "var(--c-text-dim)", marginTop: 14, marginBottom: 0 }}>
          One-way for now (Google → org). Pushing org changes back to Google is a future step.
        </p>
      </div>
    </div>
  );
}

function Pill({ ok, label }: { ok?: boolean; label: string }) {
  return (
    <span
      style={{
        padding: "2px 9px",
        borderRadius: 10,
        fontWeight: 600,
        background: ok ? "var(--c-green)" : "var(--c-surface2)",
        color: ok ? "#000" : "var(--c-text-dim)",
        border: ok ? "none" : "1px solid var(--c-border)",
      }}
    >
      {ok ? "✓ " : "• "}
      {label}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--c-text-dim)", marginBottom: 4 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

const input: React.CSSProperties = {
  width: "100%",
  background: "var(--c-bg)",
  color: "var(--c-text)",
  border: "1px solid var(--c-border)",
  borderRadius: 6,
  padding: "6px 9px",
  fontSize: 13,
  fontFamily: "inherit",
};
const primaryBtn: React.CSSProperties = {
  background: "var(--c-accent)",
  color: "#fff",
  border: "none",
  borderRadius: 7,
  padding: "8px 16px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};
const secondaryBtn: React.CSSProperties = {
  background: "var(--c-surface2)",
  color: "var(--c-text)",
  border: "1px solid var(--c-border)",
  borderRadius: 7,
  padding: "8px 14px",
  fontSize: 13,
  cursor: "pointer",
};
const iconBtn: React.CSSProperties = {
  background: "transparent",
  color: "var(--c-text-dim)",
  border: "none",
  fontSize: 16,
  cursor: "pointer",
};
const link: React.CSSProperties = { color: "var(--c-accent)" };
