import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useOrgStore, type UpdateChannel } from "../store/useOrgStore";
import { IN_TAURI } from "../api/org";

const REPO = "zhuojianlook/org-GUI";

// Updater manifests, served from the `updater` branch by the release workflow.
// stable        → v* tags    → latest.json
// experimental  → exp-* tags → latest-experimental.json
const MANIFEST_URLS: Record<UpdateChannel, string> = {
  stable: `https://raw.githubusercontent.com/${REPO}/updater/latest.json`,
  experimental: `https://raw.githubusercontent.com/${REPO}/updater/latest-experimental.json`,
};

type UpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "ready"
  | "error";

// The About window auto-opens once per app session. Tracked at module scope so
// it survives App-internal re-renders but resets on a fresh launch (= startup).
let _aboutAutoShown = false;
export function shouldAutoOpenAbout(): boolean {
  if (_aboutAutoShown) return false;
  _aboutAutoShown = true;
  return true;
}

interface ChangelogEntry {
  version: string;
  date: string;
  changes: string[];
}

// Cached for the session — fetched from GitHub releases on first About open.
let _changelogCache: ChangelogEntry[] | null = null;

async function fetchChangelog(): Promise<ChangelogEntry[]> {
  if (_changelogCache) return _changelogCache;
  try {
    // org-GUI's CSP is disabled and api.github.com sends permissive CORS, so a
    // direct fetch works from the WebView (no Rust proxy needed).
    const resp = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`);
    const releases = await resp.json();
    if (!Array.isArray(releases)) throw new Error("Invalid releases response");
    const entries: ChangelogEntry[] = [];
    for (const rel of releases) {
      const tag = rel.tag_name || "";
      const version = tag.replace(/^(v|exp-)/, "");
      if (!version) continue;
      const date = (rel.published_at || "").slice(0, 10);
      const isExp = tag.startsWith("exp-");
      // The release workflow writes bodies as `* <commit subject>` bullets.
      const changes: string[] = [];
      for (const line of (rel.body || "").split("\n")) {
        const trimmed = line.trim();
        if (!/^[*\-]\s+/.test(trimmed)) continue;
        let text = trimmed.replace(/^[*\-]\s+/, "").trim();
        text = text.replace(/\s+by\s+@\S+.*$/i, "").replace(/\s+in\s+https:\/\/\S+/g, "").trim();
        if (text.includes("Full Changelog") || text.includes("github.com/compare")) continue;
        if (text.length > 5) changes.push(text);
      }
      entries.push({
        version: isExp ? `${version} (experimental)` : version,
        date,
        changes: changes.length ? changes : [`Release ${tag}`],
      });
    }
    _changelogCache = entries;
    return entries;
  } catch {
    return [];
  }
}

// Parse the leading "x.y.z" of a version label (ignores a " (experimental)"
// suffix) into a numeric tuple for comparison.
function verTuple(s: string): number[] {
  return (s.split(" ")[0] || "").split(".").map((n) => parseInt(n, 10) || 0);
}
function isNewer(latest: string, current: string): boolean {
  const a = verTuple(latest);
  const b = verTuple(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

/**
 * The About window — app identity, authorship, update channel + the full
 * check → download → restart flow, and a live changelog. Modelled on the
 * multipanelfigure About dialog. Auto-launches once per session on startup.
 */
export default function AboutModal({ onClose }: { onClose: () => void }) {
  const updateChannel = useOrgStore((s) => s.updateChannel);
  const setUpdateChannel = useOrgStore((s) => s.setUpdateChannel);

  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState("");
  const [dl, setDl] = useState(0);
  const [dlTotal, setDlTotal] = useState<number | null>(null);
  const [changelog, setChangelog] = useState<ChangelogEntry[]>([]);
  const [changelogOpen, setChangelogOpen] = useState(false);

  const appVersion = __APP_VERSION__;

  const close = () => {
    setStatus("idle");
    onClose();
  };

  // Esc closes — matches the rest of the app's modals.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch the changelog when the window opens (it only mounts while shown).
  useEffect(() => {
    fetchChangelog().then(setChangelog);
  }, []);

  const toggleChannel = (c: UpdateChannel) => {
    setUpdateChannel(c);
    setStatus("idle");
    setLatestVersion(null);
  };

  const checkForUpdates = async () => {
    if (!IN_TAURI) {
      setErrMsg("In-app updates only work in the desktop app.");
      setStatus("error");
      return;
    }
    setStatus("checking");
    setLatestVersion(null);
    setErrMsg("");
    try {
      // Cache-bust so a freshly-pushed manifest is seen immediately.
      const resp = await fetch(`${MANIFEST_URLS[updateChannel]}?t=${Date.now()}`);
      const manifest = (await resp.json()) as { version?: string };
      const latest = manifest.version || "";
      if (isNewer(latest, appVersion)) {
        setLatestVersion(latest);
        setStatus("available");
      } else {
        setStatus("up-to-date");
      }
    } catch (e) {
      setErrMsg(String(e));
      setStatus("error");
    }
  };

  const downloadAndInstall = async () => {
    setStatus("downloading");
    setDl(0);
    setDlTotal(null);
    let off: UnlistenFn | undefined;
    let offFin: UnlistenFn | undefined;
    try {
      off = await listen<{ downloaded: number; total: number | null }>(
        "updater://progress",
        (e) => {
          setDl(e.payload.downloaded);
          if (e.payload.total) setDlTotal(e.payload.total);
        },
      );
      offFin = await listen<unknown>("updater://finished", () => setStatus("ready"));
      await invoke<string>("download_and_install_update", {
        manifestUrl: MANIFEST_URLS[updateChannel],
      });
      setStatus("ready");
    } catch (e) {
      setErrMsg(String(e));
      setStatus("error");
    } finally {
      off?.();
      offFin?.();
    }
  };

  // Changelog entries strictly newer than the running version — shown inline
  // when an update is available so the user sees what they'd be getting.
  const whatsNew = changelog.filter((entry) => isNewer(entry.version, appVersion));

  const dlMB = dl / 1024 / 1024;
  const totalMB = dlTotal ? dlTotal / 1024 / 1024 : null;
  const pct = dlTotal && dlTotal > 0 ? Math.min(100, Math.round((dl / dlTotal) * 100)) : null;

  return (
    <div
      onClick={close}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10002,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 480,
          maxWidth: "92vw",
          maxHeight: "90vh",
          overflow: "auto",
          background: "var(--c-surface)",
          border: "1px solid var(--c-border)",
          borderRadius: 12,
          padding: "20px 24px 24px",
          boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
        }}
      >
        {/* Close (top-right) */}
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: -8 }}>
          <button
            onClick={close}
            title="Close (Esc)"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--c-text-dim)",
              fontSize: 20,
              lineHeight: 1,
              cursor: "pointer",
              padding: 2,
            }}
          >
            ×
          </button>
        </div>

        {/* ── Identity ── */}
        <div style={{ textAlign: "center", padding: "4px 0 8px" }}>
          <div style={{ fontWeight: 800, color: "var(--c-accent)", fontSize: 24, letterSpacing: 0.2 }}>
            org-GUI
          </div>
          <div style={{ fontSize: 12.5, color: "var(--c-text-dim)", marginTop: 4 }}>
            Version {appVersion}
          </div>
          <div style={{ fontSize: 13.5, color: "var(--c-text)", marginTop: 10 }}>
            Created by <strong>Zhuojian Look</strong>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--c-text-dim)", marginTop: 8, lineHeight: 1.5, maxWidth: 360, marginInline: "auto" }}>
            A timeline node-graph view for Emacs org-mode — headings placed along a
            time axis, with round-trip editing through your live Emacs daemon.
          </div>
        </div>

        <Divider />

        {/* ── Update channel toggle ── */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 11, color: "var(--c-text-dim)" }}>Update channel:</span>
          <ChannelButton label="Stable" active={updateChannel === "stable"} onClick={() => toggleChannel("stable")} />
          <ChannelButton label="Experimental" warning active={updateChannel === "experimental"} onClick={() => toggleChannel("experimental")} />
        </div>
        {updateChannel === "experimental" && (
          <div style={{ fontSize: 10.5, color: "#e0a458", textAlign: "center", marginBottom: 6 }}>
            Experimental updates may contain unstable features
          </div>
        )}

        {/* ── Check for updates + status ── */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, marginTop: 6 }}>
          <button
            onClick={checkForUpdates}
            disabled={status === "checking" || status === "downloading"}
            style={{
              ...outlineBtn,
              cursor: status === "checking" || status === "downloading" ? "progress" : "pointer",
              opacity: status === "checking" || status === "downloading" ? 0.7 : 1,
            }}
          >
            {status === "checking" ? "Checking…" : "⇧ Check for updates"}
          </button>

          {status === "up-to-date" && (
            <Alert tone="success">
              You are running the latest {updateChannel} version ({appVersion}).
            </Alert>
          )}

          {status === "available" && (
            <Alert tone="info">
              <div style={{ fontWeight: 700, fontSize: 12.5 }}>Version {latestVersion} is available!</div>
              {whatsNew.length > 0 && (
                <div style={{ marginTop: 8, maxHeight: 150, overflowY: "auto" }}>
                  {whatsNew.map((entry) => (
                    <ChangelogBlock key={entry.version} entry={entry} small />
                  ))}
                </div>
              )}
              <button onClick={downloadAndInstall} style={{ ...primaryBtn, marginTop: 8 }}>
                ⤓ Download &amp; install update
              </button>
            </Alert>
          )}

          {status === "downloading" && (
            <Alert tone="info">
              Downloading update…{" "}
              {dl > 0 &&
                (totalMB != null
                  ? `(${dlMB.toFixed(1)} MB / ${totalMB.toFixed(1)} MB${pct != null ? ` — ${pct}%` : ""})`
                  : `(${dlMB.toFixed(1)} MB)`)}
            </Alert>
          )}

          {status === "ready" && (
            <Alert tone="success">
              <div style={{ fontWeight: 700, fontSize: 12.5 }}>Update installed — restart to apply.</div>
              <button
                onClick={() =>
                  invoke("restart_app").catch((e) => {
                    setErrMsg(String(e));
                    setStatus("error");
                  })
                }
                style={{ ...primaryBtn, marginTop: 8, background: "var(--c-green)", color: "#000" }}
              >
                ↻ Restart now
              </button>
            </Alert>
          )}

          {status === "error" && (
            <Alert tone="warning">
              Could not update. {errMsg ? `Error: ${errMsg}` : "Please check your internet connection."}
            </Alert>
          )}
        </div>

        <Divider />

        {/* ── Changelog (collapsible) ── */}
        <button
          onClick={() => setChangelogOpen((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            width: "100%",
            background: "transparent",
            border: "none",
            padding: "4px 0",
            cursor: "pointer",
            color: "var(--c-text)",
            fontFamily: "inherit",
            fontSize: 12.5,
            fontWeight: 600,
          }}
        >
          <span style={{ display: "inline-block", transform: changelogOpen ? "rotate(90deg)" : "none", transition: "transform 0.12s" }}>
            ▸
          </span>
          Changelog
        </button>
        {changelogOpen && (
          <div style={{ paddingTop: 4 }}>
            {changelog.length === 0 ? (
              <div style={{ fontSize: 11.5, color: "var(--c-text-dim)" }}>Loading changelog…</div>
            ) : (
              changelog.map((entry) => <ChangelogBlock key={entry.version} entry={entry} />)
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ChannelButton({
  label,
  active,
  warning,
  onClick,
}: {
  label: string;
  active: boolean;
  warning?: boolean;
  onClick: () => void;
}) {
  const accent = warning ? "#e0a458" : "var(--c-accent)";
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: "2px 10px",
        borderRadius: 5,
        cursor: "pointer",
        fontFamily: "inherit",
        border: `1px solid ${accent}`,
        background: active ? accent : "transparent",
        color: active ? "#000" : accent,
      }}
    >
      {label}
    </button>
  );
}

function ChangelogBlock({ entry, small }: { entry: ChangelogEntry; small?: boolean }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontWeight: 700, fontSize: small ? 11 : 12 }}>
        v{entry.version} — {entry.date}
      </div>
      <ul style={{ margin: "2px 0 0", paddingLeft: 18 }}>
        {entry.changes.map((c, i) => (
          <li key={i} style={{ fontSize: small ? 10.5 : 11.5, color: "var(--c-text-dim)", lineHeight: 1.45 }}>
            {c}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Alert({ tone, children }: { tone: "success" | "info" | "warning"; children: React.ReactNode }) {
  const color =
    tone === "success" ? "var(--c-green)" : tone === "warning" ? "#e0a458" : "var(--c-accent)";
  return (
    <div
      style={{
        width: "100%",
        border: `1px solid ${color}`,
        borderRadius: 8,
        padding: "8px 10px",
        fontSize: 11.5,
        color: "var(--c-text)",
        background: "var(--c-surface2)",
        lineHeight: 1.45,
      }}
    >
      {children}
    </div>
  );
}

function Divider() {
  return <div aria-hidden style={{ height: 1, background: "var(--c-border)", opacity: 0.7, margin: "16px 0" }} />;
}

const outlineBtn: React.CSSProperties = {
  background: "transparent",
  color: "var(--c-accent)",
  border: "1px solid var(--c-accent)",
  borderRadius: 8,
  padding: "7px 14px",
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "inherit",
};

const primaryBtn: React.CSSProperties = {
  background: "var(--c-accent)",
  color: "#fff",
  border: "none",
  borderRadius: 7,
  padding: "6px 12px",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "inherit",
};
