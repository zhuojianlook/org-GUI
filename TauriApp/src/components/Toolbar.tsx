import { useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useOrgStore, type UpdateChannel } from "../store/useOrgStore";
import { IN_TAURI } from "../api/org";

// Updater manifests, served from the `updater` branch by the release workflow.
// stable        → v* tags    → latest.json
// experimental  → exp-* tags → latest-experimental.json
const MANIFEST_URLS: Record<UpdateChannel, string> = {
  stable: "https://raw.githubusercontent.com/zhuojianlook/org-GUI/updater/latest.json",
  experimental:
    "https://raw.githubusercontent.com/zhuojianlook/org-GUI/updater/latest-experimental.json",
};

type UpdateState = "idle" | "checking" | "downloading" | "done" | "error";

export default function Toolbar() {
  const { doc, file, loading, error, emacsOk, loadFile, reload, createFile, addHeading, depMode, setDepMode } =
    useOrgStore();
  const updateChannel = useOrgStore((s) => s.updateChannel);
  const setUpdateChannel = useOrgStore((s) => s.setUpdateChannel);
  const [updateState, setUpdateState] = useState<UpdateState>("idle");
  const [updatePct, setUpdatePct] = useState(0);
  const [updateMsg, setUpdateMsg] = useState("");

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
      case "checking": return "Checking…";
      case "downloading": return `Updating ${updatePct}%`;
      case "done": return "Restart to apply ↻";
      case "error": return "Update failed";
      default: return "Check for updates";
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
    if (typeof selected === "string") {
      await loadFile(selected);
    }
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
        height: 44,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "0 12px",
        background: "var(--c-surface)",
        borderBottom: "1px solid var(--c-border)",
      }}
    >
      <span style={{ fontWeight: 700, color: "var(--c-accent)" }}>org-GUI</span>
      <button onClick={newFile} style={btn}>
        New .org…
      </button>
      <button onClick={pickFile} style={btn}>
        Open .org…
      </button>
      <button onClick={() => addHeading(0, "New heading")} style={btn} disabled={!doc}>
        + Heading
      </button>
      <button onClick={reload} style={btn} disabled={!file}>
        Reload
      </button>

      {/* Dependency mode: wire prerequisite → dependent links on the graph */}
      <button
        onClick={() => setDepMode(!depMode)}
        style={{ ...btn, ...(depMode ? { background: "#e0a458", color: "#000", borderColor: "#e0a458", fontWeight: 700 } : {}) }}
        disabled={!doc}
        title="Dependency mode: drag from a prerequisite node onto a dependent node to link them; click a link to remove it"
      >
        ⇢ Deps
      </button>

      <div style={{ flex: 1 }} />
      <button
        onClick={() => window.dispatchEvent(new CustomEvent("orggui:openSetup"))}
        title="Set up / re-install Emacs + Doom Emacs prerequisites"
        style={btn}
      >
        ⚙ Setup
      </button>
      <span style={{ fontSize: 12, color: "var(--c-text-dim)" }}>
        {doc?.title || (file ? file.split("/").pop() : "No file open")}
      </span>
      {loading && <span style={{ fontSize: 12, color: "var(--c-amber)" }}>Loading…</span>}
      <select
        value={updateChannel}
        onChange={(e) => setUpdateChannel(e.target.value as UpdateChannel)}
        title="Update channel — Stable ships every v* release; Experimental ships every exp-* release first"
        style={{
          ...btn,
          paddingRight: 18,
          ...(updateChannel === "experimental"
            ? { background: "#e0a458", color: "#000", borderColor: "#e0a458", fontWeight: 700 }
            : {}),
        }}
      >
        <option value="stable">Stable</option>
        <option value="experimental">Experimental</option>
      </select>
      <button
        onClick={checkForUpdates}
        disabled={updateState === "checking" || updateState === "downloading"}
        title={updateMsg || `Check for ${updateChannel} updates`}
        style={{
          ...btn,
          ...(updateState === "done"
            ? { background: "var(--c-green)", color: "#000", borderColor: "var(--c-green)" }
            : updateState === "error"
              ? { background: "transparent", color: "var(--c-red)", borderColor: "var(--c-red)" }
              : {}),
        }}
      >
        ⇧ {updateLabel}
      </button>
      <span
        title={emacsOk === false ? error || "Emacs server unreachable" : "Emacs connected"}
        style={{
          fontSize: 11,
          padding: "2px 8px",
          borderRadius: 10,
          background: emacsOk ? "var(--c-green)" : "var(--c-red)",
          color: "#000",
          opacity: emacsOk === null ? 0.4 : 1,
        }}
      >
        {emacsOk === null ? "Emacs ?" : emacsOk ? "Emacs ●" : "Emacs ✕"}
      </span>
    </div>
  );
}

const btn: React.CSSProperties = {
  background: "var(--c-surface2)",
  color: "var(--c-text)",
  border: "1px solid var(--c-border)",
  borderRadius: 6,
  padding: "4px 12px",
  fontSize: 13,
  cursor: "pointer",
};
