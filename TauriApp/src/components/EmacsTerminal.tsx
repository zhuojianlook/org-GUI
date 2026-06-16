import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { IN_TAURI } from "../api/org";
import { useOrgStore } from "../store/useOrgStore";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

/**
 * Embeds the user's real Emacs (`emacsclient -t`) in an xterm.js terminal via
 * a PTY in the Rust backend — i.e. complete org-mode + evil, their Doom config.
 * Only works inside the Tauri app (the browser preview has no PTY).
 */
export default function EmacsTerminal() {
  const file = useOrgStore((s) => s.file);
  const begin = useOrgStore((s) => s.editBegin); // subtree to narrow to (0 = whole file)
  const refreshDoc = useOrgStore((s) => s.refreshDoc);
  const containerRef = useRef<HTMLDivElement>(null);
  // Bumping this re-runs the effect: cleanly closes the current emacsclient -t
  // frame and opens a fresh one. Recovers a wedged frame (e.g. stuck at a
  // minibuffer prompt) WITHOUT restarting the whole daemon.
  const [reopenNonce, setReopenNonce] = useState(0);
  // True once the PTY's frame has exited (so we surface a prominent "Reopen").
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    if (!IN_TAURI || !containerRef.current || !file) return;
    setClosed(false);

    const term = new Terminal({
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      cursorBlink: true,
      theme: { background: "#1c1c1e", foreground: "#e5e5ea" },
      allowProposedApi: true,
      macOptionIsMeta: true, // Option = Meta, so M-x / M-RET / etc. work
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    let id: number | null = null;
    // Timestamp of the most recent keystroke sent to the PTY. The idle
    // refresh timer uses this to skip a parse when the user is actively
    // typing — a concurrent `org-gui-parse` would lock the daemon's
    // single-threaded elisp executor and freeze the terminal until the
    // parse completes (seconds, on a large file).
    let lastKeystrokeAt = 0;

    // Workaround so your usual macOS Emacs shortcuts work in a terminal frame:
    // treat ⌘ (Command) as Meta, and encode modified Return / Tab as xterm
    // modifyOtherKeys (CSI 27;mod;code~), which Emacs decodes. So ⌘+Enter→M-RET
    // (new heading), ⌘+Shift+Enter→M-S-RET (new TODO), ⌘+x→M-x, etc.
    const send = (data: string) => {
      lastKeystrokeAt = Date.now();
      if (id != null) invoke("emacs_term_write", { id, data });
    };
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const meta = e.altKey || e.metaKey; // ⌥ and ⌘ both act as Meta
      const special: Record<string, number> = { Enter: 13, Tab: 9 };
      if (e.key in special && (e.ctrlKey || e.shiftKey || meta)) {
        if (meta && !e.ctrlKey && !e.shiftKey) {
          // Plain Meta+Return/Tab: the universal ESC-prefixed form (M-RET, M-TAB).
          send(`\x1b${e.key === "Enter" ? "\r" : "\t"}`);
        } else {
          // Shift/Ctrl combos need modifyOtherKeys: C-RET, S-RET, M-S-RET, …
          const mod = 1 + (e.shiftKey ? 1 : 0) + (meta ? 2 : 0) + (e.ctrlKey ? 4 : 0);
          send(`\x1b[27;${mod};${special[e.key]}~`);
        }
        e.preventDefault();
        return false;
      }
      // ⌘ + a printable char → Meta (ESC prefix): ⌘x = M-x, ⌘f = M-f, …
      if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
        send(`\x1b${e.key}`);
        e.preventDefault();
        return false;
      }
      return true;
    });
    let disposed = false;
    let unlistenData: UnlistenFn | undefined;
    let unlistenExit: UnlistenFn | undefined;

    // Live-but-safe graph sync. The previous implementation called
    // refreshDoc() on EVERY emacs-term-data event, which while typing
    // produces 20-30 events/sec (cursor echo, line redraws, evil cursor
    // blink, modeline ticks, …). Each refreshDoc spawns `org-gui-parse`
    // against the daemon, and elisp is single-threaded — while the parse
    // runs, no PTY input is serviced, which manifests as the app hanging
    // mid-keypress.
    //
    // Strategy: a small interval ticks at REFRESH_INTERVAL_MS and fires
    // refreshDoc iff (a) no keystroke in the last KEYSTROKE_QUIET_MS, and
    // (b) no other refresh is currently in flight. That gives a sub-2 s
    // graph latency after you pause typing, without the parse ever
    // competing with the input pipeline. Final state still catches up on
    // unmount.
    const REFRESH_INTERVAL_MS = 1000;
    const KEYSTROKE_QUIET_MS = 600;
    let refreshInflight = false;
    // True only while this app is the focused, visible application. When the
    // user switches AWAY (⌘-Tab, window occluded/minimised) they're not typing,
    // so `lastKeystrokeAt` goes stale and the idle timer would otherwise fire an
    // `org-gui-parse` every second the whole time they're gone. Each parse locks
    // the daemon's single-threaded elisp loop, so one left running across the
    // app-switch boundary is exactly what makes the first keystrokes after
    // returning hang for seconds. Gating on focus keeps the daemon idle while
    // away; regaining focus counts as activity (below) so the quiet window then
    // shields the user's first post-return keystrokes from a freshly-fired parse.
    let appActive = document.hasFocus() && !document.hidden;
    const idleRefresh = window.setInterval(() => {
      if (!appActive) return;
      if (refreshInflight) return;
      if (Date.now() - lastKeystrokeAt < KEYSTROKE_QUIET_MS) return;
      refreshInflight = true;
      Promise.resolve(refreshDoc()).finally(() => {
        refreshInflight = false;
      });
    }, REFRESH_INTERVAL_MS);

    // Pause refreshes while away; on return, treat it as a keystroke so the next
    // refresh holds off for KEYSTROKE_QUIET_MS — long enough for the user to
    // resume typing, which keeps bumping the timer. ⌘-Tab leaves the document
    // visible but blurs the window, so we watch window focus/blur AND
    // visibilitychange (occlude/minimise) to cover both ways of leaving.
    const onAppBlur = () => {
      appActive = false;
    };
    const onAppFocus = () => {
      appActive = true;
      lastKeystrokeAt = Date.now();
    };
    const onVisibility = () => {
      if (document.hidden) appActive = false;
      else onAppFocus();
    };
    window.addEventListener("blur", onAppBlur);
    window.addEventListener("focus", onAppFocus);
    document.addEventListener("visibilitychange", onVisibility);

    (async () => {
      unlistenData = await listen<{ id: number; data: string }>("emacs-term-data", (e) => {
        term.write(b64ToBytes(e.payload.data));
      });
      unlistenExit = await listen<number>("emacs-term-exit", () => {
        term.writeln("\r\n\x1b[2m[emacs frame closed — click ↻ Reopen]\x1b[0m");
        setClosed(true);
      });
      if (disposed) return;
      let newId: number;
      try {
        newId = await invoke<number>("emacs_term_open", { file, begin, cols: term.cols, rows: term.rows });
      } catch (err) {
        term.writeln(`\x1b[31m${String(err)}\x1b[0m`);
        return;
      }
      // The async open await window is long enough (50-500 ms) that the
      // user can switch tabs / close the panel mid-open. In that case
      // the cleanup function has already fired but `id` was still null,
      // so the PTY would leak. Close it explicitly here when we detect
      // post-await dispose.
      if (disposed) {
        invoke("emacs_term_close", { id: newId }).catch(() => {});
        return;
      }
      id = newId;
      term.onData((d) => {
        lastKeystrokeAt = Date.now();
        if (id != null) invoke("emacs_term_write", { id, data: d });
      });
      term.onResize(({ cols, rows }) => {
        if (id != null) invoke("emacs_term_resize", { id, cols, rows });
      });
      term.focus();
    })();

    const onResize = () => {
      try {
        fit.fit();
      } catch {
        /* container not measurable yet */
      }
    };
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(containerRef.current);

    return () => {
      disposed = true;
      window.clearInterval(idleRefresh);
      window.removeEventListener("blur", onAppBlur);
      window.removeEventListener("focus", onAppFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      if (id != null) invoke("emacs_term_close", { id });
      unlistenData?.();
      unlistenExit?.();
      term.dispose();
      // One final refresh so the graph picks up whatever the user just
      // committed in the terminal, even if we skipped recent idle ticks
      // because they were typing.
      refreshDoc();
    };
  }, [file, begin, refreshDoc, reopenNonce]);

  const reopen = () => setReopenNonce((n) => n + 1);

  if (!IN_TAURI) {
    return (
      <div
        style={{
          height: "100%",
          display: "grid",
          placeItems: "center",
          color: "var(--c-text-dim)",
          textAlign: "center",
          padding: 24,
        }}
      >
        <div>
          Embedded Emacs runs only in the desktop app — it launches{" "}
          <code>emacsclient -t</code> in a terminal here for complete org-mode.
          <br />
          <br />
          (In this browser preview, use Graph mode.)
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "relative", height: "100%", width: "100%" }}>
      <div ref={containerRef} style={{ height: "100%", width: "100%", background: "#1c1c1e", padding: 4 }} />
      {/* Always-available recovery: if the frame ever wedges (e.g. stuck at a
          minibuffer prompt) or its PTY exits, this re-opens a clean frame
          without a full daemon restart. Highlighted once the frame has exited. */}
      <button
        onClick={reopen}
        title="Reopen the Emacs editor frame — recovers a stuck/closed frame without restarting the daemon"
        style={{
          position: "absolute",
          top: 8,
          right: 12,
          zIndex: 5,
          font: "600 11px system-ui, sans-serif",
          padding: "3px 9px",
          borderRadius: 6,
          cursor: "pointer",
          color: closed ? "#1c1c1e" : "#e5e5ea",
          background: closed ? "#e0a458" : "rgba(40,40,44,0.85)",
          border: `1px solid ${closed ? "#e0a458" : "rgba(255,255,255,0.18)"}`,
          boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
          ...(closed ? { animation: "orggui-newpulse 1.6s ease-in-out infinite" } : {}),
        }}
      >
        ↻ Reopen
      </button>
    </div>
  );
}
