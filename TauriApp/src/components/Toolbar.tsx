import { useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useOrgStore, type UpdateChannel } from "../store/useOrgStore";
import { IN_TAURI } from "../api/org";
import TagsPopover from "./TagsPopover";

// Updater manifests, served from the `updater` branch by the release workflow.
// stable        → v* tags    → latest.json
// experimental  → exp-* tags → latest-experimental.json
const MANIFEST_URLS: Record<UpdateChannel, string> = {
  stable: "https://raw.githubusercontent.com/zhuojianlook/org-GUI/updater/latest.json",
  experimental:
    "https://raw.githubusercontent.com/zhuojianlook/org-GUI/updater/latest-experimental.json",
};

type UpdateState = "idle" | "checking" | "downloading" | "done" | "error";

/**
 * Top-of-window menu. The layout is grouped left → right by purpose:
 *   1. Brand   — org-GUI + version chip
 *   2. File    — 📄 New .org · 📁 Open .org
 *   3. Edit    — + Heading
 *   4. View    — ⇢ Deps · 🏷 Tags
 *   5. (flex spacer)
 *   6. Status  — Emacs ●
 *   7. System  — ⚙ ▾  (dropdown: Reload, Setup, ↻ Daemon, Update channel, Check updates)
 *
 * Infrequent system-level actions (Setup, daemon restart, updates) used to
 * crowd the bar — they're now collapsed into the ⚙ menu so the everyday
 * actions stay legible. The active file name moved to the TabBar below.
 */
export default function Toolbar() {
  const doc = useOrgStore((s) => s.doc);
  const file = useOrgStore((s) => s.file);
  const error = useOrgStore((s) => s.error);
  const emacsOk = useOrgStore((s) => s.emacsOk);
  const loadFile = useOrgStore((s) => s.loadFile);
  const reload = useOrgStore((s) => s.reload);
  const createFile = useOrgStore((s) => s.createFile);
  const addHeading = useOrgStore((s) => s.addHeading);
  const depMode = useOrgStore((s) => s.depMode);
  const setDepMode = useOrgStore((s) => s.setDepMode);
  const boxDrawMode = useOrgStore((s) => s.boxDrawMode);
  const setBoxDrawMode = useOrgStore((s) => s.setBoxDrawMode);
  const tagFilter = useOrgStore((s) => s.tagFilter);
  const updateChannel = useOrgStore((s) => s.updateChannel);
  const setUpdateChannel = useOrgStore((s) => s.setUpdateChannel);
  const showTimeline = useOrgStore((s) => s.showTimeline);
  const setShowTimeline = useOrgStore((s) => s.setShowTimeline);

  const [updateState, setUpdateState] = useState<UpdateState>("idle");
  const [updatePct, setUpdatePct] = useState(0);
  const [updateMsg, setUpdateMsg] = useState("");
  const [tagsOpen, setTagsOpen] = useState(false);
  const [systemOpen, setSystemOpen] = useState(false);
  const tagsBtnRef = useRef<HTMLButtonElement>(null);
  const systemBtnRef = useRef<HTMLButtonElement>(null);

  // Dismiss the ⚙ menu on outside click / Esc — same capture-phase pattern
  // we use for ContextMenu so React Flow's own handlers don't swallow it.
  useEffect(() => {
    if (!systemOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      const pop = document.getElementById("org-system-menu");
      if (pop && pop.contains(t)) return;
      if (systemBtnRef.current && systemBtnRef.current.contains(t)) return;
      setSystemOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSystemOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [systemOpen]);

  const checkForUpdates = async () => {
    if (!IN_TAURI) {
      setUpdateState("error");
      setUpdateMsg("In-app updates only work in the desktop app.");
      return;
    }
    setUpdateState("checking");
    setUpdatePct(0);
    setUpdateMsg("");
    let offProgress: UnlistenFn | undefined;
    let offFinished: UnlistenFn | undefined;
    try {
      offProgress = await listen<{ downloaded: number; total: number | null }>(
        "updater://progress",
        (e) => {
          setUpdateState("downloading");
          if (e.payload.total)
            setUpdatePct(Math.min(100, Math.round((100 * e.payload.downloaded) / e.payload.total)));
        },
      );
      offFinished = await listen<unknown>("updater://finished", () => setUpdateState("done"));
      const msg = await invoke<string>("download_and_install_update", {
        manifestUrl: MANIFEST_URLS[updateChannel],
      });
      setUpdateState("done");
      setUpdateMsg(msg);
    } catch (e) {
      const s = String(e);
      if (/No update available/i.test(s)) {
        setUpdateState("idle");
        setUpdateMsg("Already up to date.");
      } else {
        setUpdateState("error");
        setUpdateMsg(s);
      }
    } finally {
      offProgress?.();
      offFinished?.();
    }
  };

  const updateLabel = (() => {
    switch (updateState) {
      case "checking":
        return "Checking…";
      case "downloading":
        return `Updating ${updatePct}%`;
      case "done":
        return "Restart to apply ↻";
      case "error":
        return "Update failed";
      default:
        return "Check for updates";
    }
  })();

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

  const newFile = async () => {
    if (!IN_TAURI) {
      await createFile("untitled.org", "Untitled");
      return;
    }
    const path = await save({
      defaultPath: "untitled.org",
      filters: [{ name: "Org files", extensions: ["org"] }],
    });
    if (typeof path === "string") {
      const p = path.endsWith(".org") ? path : `${path}.org`;
      const title = (p.split("/").pop() || "Untitled").replace(/\.org$/, "");
      await createFile(p, title);
    }
  };

  return (
    <div
      style={{
        height: 40,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "0 10px",
        background: "var(--c-surface)",
        borderBottom: "1px solid var(--c-border)",
      }}
    >
      {/* ── Brand ── */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginRight: 4 }}>
        <span style={{ fontWeight: 700, color: "var(--c-accent)", fontSize: 14 }}>org-GUI</span>
        <span
          title={`Build ${__APP_VERSION__} · ${updateChannel} channel`}
          style={{
            fontSize: 9.5,
            fontWeight: 600,
            color: "var(--c-text-dim)",
            background: "var(--c-surface2)",
            border: "1px solid var(--c-border)",
            borderRadius: 3,
            padding: "1px 5px",
            letterSpacing: 0.3,
          }}
        >
          v{__APP_VERSION__}
        </span>
      </div>

      <Separator />

      {/* ── File ── */}
      <button onClick={newFile} title="Create a new .org file" style={btn}>
        📄 New
      </button>
      <button onClick={pickFile} title="Open an existing .org file in a new tab" style={btn}>
        📁 Open
      </button>

      <Separator />

      {/* ── Edit ── */}
      <button
        onClick={() => addHeading(0, "New heading")}
        title="Add a top-level heading to the current file"
        style={btn}
        disabled={!doc}
      >
        + Heading
      </button>

      <Separator />

      {/* ── View / mode toggles ── */}
      <button
        onClick={() => setDepMode(!depMode)}
        style={{
          ...btn,
          ...(depMode
            ? { background: "#e0a458", color: "#000", borderColor: "#e0a458", fontWeight: 700 }
            : {}),
        }}
        disabled={!doc}
        title="Dependency mode: drag from a prerequisite onto a dependent to link them; click a link to remove it"
      >
        ⇢ Deps
      </button>
      <button
        onClick={() => setBoxDrawMode(!boxDrawMode)}
        style={{
          ...btn,
          ...(boxDrawMode
            ? { background: "#8ab4f8", color: "#000", borderColor: "#8ab4f8", fontWeight: 700 }
            : {}),
        }}
        disabled={!doc}
        title="Region mode: drag on the canvas to draw a box. Nodes inside a box stay inside it; drag one well past the edge to release it."
      >
        ▭ Region
      </button>
      <button
        ref={tagsBtnRef}
        onClick={() => setTagsOpen((v) => !v)}
        style={{
          ...btn,
          ...(tagFilter
            ? {
                background: "var(--c-accent)",
                color: "#fff",
                borderColor: "var(--c-accent)",
                fontWeight: 700,
              }
            : {}),
        }}
        disabled={!doc}
        title={tagFilter ? `Filtering :${tagFilter}: — click to manage tags` : "Manage tag colours and filters"}
      >
        🏷 {tagFilter ? `:${tagFilter}:` : "Tags"}
      </button>
      <button
        onClick={() => setShowTimeline(!showTimeline)}
        style={{
          ...btn,
          ...(showTimeline
            ? {
                background: "var(--c-accent)",
                color: "#fff",
                borderColor: "var(--c-accent)",
                fontWeight: 700,
              }
            : {}),
        }}
        disabled={!doc}
        title={
          showTimeline
            ? "Hide the calendar timeline strip"
            : "Show the calendar timeline strip"
        }
      >
        🗓 Timeline
      </button>
      {tagsOpen && (
        <TagsPopover
          onClose={() => setTagsOpen(false)}
          anchorRect={tagsBtnRef.current?.getBoundingClientRect() ?? null}
          anchorEl={tagsBtnRef.current}
        />
      )}

      <div style={{ flex: 1 }} />

      {/* ── Status ── */}
      <span
        title={emacsOk === false ? error || "Emacs server unreachable" : "Emacs connected"}
        style={{
          fontSize: 10.5,
          padding: "2px 8px",
          borderRadius: 10,
          background: emacsOk ? "var(--c-green)" : "var(--c-red)",
          color: "#000",
          opacity: emacsOk === null ? 0.4 : 1,
          fontWeight: 600,
        }}
      >
        {emacsOk === null ? "Emacs ?" : emacsOk ? "Emacs ●" : "Emacs ✕"}
      </span>

      {/* ── System menu (⚙) ── */}
      <button
        ref={systemBtnRef}
        onClick={() => setSystemOpen((v) => !v)}
        title="System: reload, daemon restart, Emacs setup, updates"
        style={{
          ...btn,
          ...(systemOpen
            ? { background: "var(--c-surface2)", borderColor: "var(--c-accent)" }
            : {}),
        }}
      >
        ⚙ ▾
      </button>
      {systemOpen && (
        <div
          id="org-system-menu"
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            top: 42,
            right: 10,
            minWidth: 260,
            background: "var(--c-surface)",
            border: "1px solid var(--c-border)",
            borderRadius: 8,
            boxShadow: "0 8px 28px rgba(0,0,0,0.55)",
            padding: 4,
            zIndex: 10001,
            fontSize: 12.5,
          }}
        >
          <MenuItem
            label="↻ Reload current file"
            disabled={!file}
            onClick={() => {
              setSystemOpen(false);
              reload();
            }}
          />
          <MenuItem
            label="📅 Google Calendar…"
            onClick={() => {
              setSystemOpen(false);
              window.dispatchEvent(new CustomEvent("orggui:openGcal"));
            }}
          />
          <MenuItem
            label="⚙ Emacs / Doom setup…"
            onClick={() => {
              setSystemOpen(false);
              window.dispatchEvent(new CustomEvent("orggui:openSetup"));
            }}
          />
          <MenuItem
            label="↻ Restart Emacs daemon"
            disabled={!IN_TAURI}
            onClick={async () => {
              setSystemOpen(false);
              if (!IN_TAURI) return;
              try {
                const msg = await invoke<string>("restart_emacs_daemon");
                window.alert(msg);
              } catch (e) {
                window.alert(`Could not restart daemon: ${String(e)}`);
              }
            }}
          />
          <Divider />
          <div style={{ padding: "6px 10px 2px 10px", fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--c-text-dim)", fontWeight: 700 }}>
            Updates
          </div>
          <div style={{ padding: "4px 8px", display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "var(--c-text-dim)", fontSize: 11.5 }}>Channel:</span>
            <select
              value={updateChannel}
              onChange={(e) => setUpdateChannel(e.target.value as UpdateChannel)}
              style={{
                flex: 1,
                background: "var(--c-surface2)",
                color: "var(--c-text)",
                border: "1px solid var(--c-border)",
                borderRadius: 4,
                padding: "2px 6px",
                fontSize: 12,
              }}
            >
              <option value="stable">Stable</option>
              <option value="experimental">Experimental</option>
            </select>
          </div>
          <MenuItem
            label={`⇧ ${updateLabel}`}
            disabled={updateState === "checking" || updateState === "downloading"}
            highlight={
              updateState === "done"
                ? "green"
                : updateState === "error"
                  ? "red"
                  : updateChannel === "experimental"
                    ? "amber"
                    : undefined
            }
            onClick={() => {
              if (updateState === "done") {
                setSystemOpen(false);
                invoke("restart_app").catch((e) => {
                  setUpdateState("error");
                  setUpdateMsg(String(e));
                });
              } else {
                checkForUpdates();
              }
            }}
            titleAttr={updateMsg || `Check for ${updateChannel} updates`}
          />
        </div>
      )}
    </div>
  );
}

function Separator() {
  return (
    <div
      aria-hidden
      style={{
        width: 1,
        height: 18,
        background: "var(--c-border)",
        opacity: 0.7,
        margin: "0 2px",
        flexShrink: 0,
      }}
    />
  );
}

function Divider() {
  return (
    <div
      aria-hidden
      style={{
        height: 1,
        background: "var(--c-border)",
        opacity: 0.7,
        margin: "4px 6px",
      }}
    />
  );
}

function MenuItem({
  label,
  onClick,
  disabled,
  highlight,
  titleAttr,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  highlight?: "green" | "red" | "amber";
  titleAttr?: string;
}) {
  const colors =
    highlight === "green"
      ? { color: "var(--c-green)" }
      : highlight === "red"
        ? { color: "var(--c-red)" }
        : highlight === "amber"
          ? { color: "#e0a458" }
          : {};
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={titleAttr}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        background: "transparent",
        border: "none",
        padding: "6px 10px",
        fontSize: 12.5,
        color: disabled ? "var(--c-text-dim)" : "var(--c-text)",
        cursor: disabled ? "not-allowed" : "pointer",
        fontFamily: "inherit",
        opacity: disabled ? 0.6 : 1,
        borderRadius: 4,
        ...colors,
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = "var(--c-surface2)";
      }}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      {label}
    </button>
  );
}

const btn: React.CSSProperties = {
  background: "var(--c-surface2)",
  color: "var(--c-text)",
  border: "1px solid var(--c-border)",
  borderRadius: 5,
  padding: "3px 9px",
  fontSize: 12.5,
  cursor: "pointer",
  fontFamily: "inherit",
  whiteSpace: "nowrap",
  flexShrink: 0,
};
