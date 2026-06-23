import { useEffect, useState } from "react";
import { useOrgStore, isGcalAuthExpired, GCAL_AUTH_EXPIRED_MSG, gcalPushIds } from "../store/useOrgStore";
import {
  gcalInstall,
  gcalStatus,
  gcalSync,
  gcalPush,
  gcalCalendars,
  type GcalStatus,
  type GcalCalendar,
  IN_TAURI,
} from "../api/org";
import {
  HAS_DEFAULT_GOOGLE_CLIENT,
  DEFAULT_GOOGLE_CLIENT_ID,
  DEFAULT_GOOGLE_CLIENT_SECRET,
} from "../config/google";

// Mirror of the store's key — GcalPanel writes the id→{summary,colour} map
// here after a calendar-list fetch; the timeline reads it to colour/tag events
// by calendar.
const GCAL_CALS_KEY = "org-gui:gcal:calendars";
function saveCalMap(cals: GcalCalendar[]) {
  try {
    const map: Record<string, { summary: string; color: string | null }> = {};
    for (const c of cals) map[c.id] = { summary: c.summary, color: c.color };
    localStorage.setItem(GCAL_CALS_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

// Persisted, non-secret-aware: the client secret lives in localStorage. It's
// the user's OWN Google OAuth client secret for a desktop app, on their own
// machine — acceptable for a personal-use integration, and never leaves the
// device except to Google during auth. (When the build ships a first-party
// Google client, the user usually doesn't enter any of this — see
// `useOwnClient`.)
const CFG_KEY = "org-gui:gcal:config";
interface GcalConfig {
  clientId: string;
  clientSecret: string;
  /** The Google account email you sign in with (the primary calendar's id).
   *  The OAuth token is keyed under this; the calendar picker lists all of
   *  this account's calendars. */
  account: string;
  /** Calendar ids selected to sync (checkboxes). Empty = just the primary. */
  selectedCalendars: string[];
  /** Push Emacs edits back to Google on Sync (org-gcal-sync) vs one-way pull. */
  twoWay: boolean;
  file: string;
  // Opt out of the built-in "Sign in with Google" client and use your own
  // OAuth credentials instead (advanced).
  useOwnClient: boolean;
  // Legacy single-calendar field; migrated into `account` on load.
  calendarId?: string;
}
function loadCfg(): GcalConfig {
  const base: GcalConfig = {
    clientId: "",
    clientSecret: "",
    account: "",
    selectedCalendars: [],
    twoWay: false,
    file: "",
    useOwnClient: false,
  };
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (raw) {
      const merged = { ...base, ...JSON.parse(raw) } as GcalConfig;
      // Migrate the old single calendarId → account.
      if (!merged.account && merged.calendarId && merged.calendarId !== "primary") {
        merged.account = merged.calendarId;
      }
      return merged;
    }
  } catch {
    /* ignore */
  }
  return base;
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
  const gcalAuthExpired = useOrgStore((s) => s.gcalAuthExpired);
  const gcalReconnect = useOrgStore((s) => s.gcalReconnect);

  const [cfg, setCfg] = useState<GcalConfig>(() => {
    const c = loadCfg();
    if (!c.file && currentFile) c.file = currentFile;
    return c;
  });
  const [status, setStatus] = useState<GcalStatus | null>(null);
  const [busy, setBusy] = useState<null | "status" | "install" | "sync" | "cals" | "reconnect">(null);
  const [msg, setMsg] = useState<string>("");
  const [err, setErr] = useState<string>("");
  const [calendars, setCalendars] = useState<GcalCalendar[]>([]);

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

  // Which OAuth client this sync will use. When the build ships a first-party
  // client and the user hasn't opted into their own, we use the built-in one
  // and the user never sees a client id/secret field.
  const usingBuiltIn = HAS_DEFAULT_GOOGLE_CLIENT && !cfg.useOwnClient;
  const effClientId = usingBuiltIn ? DEFAULT_GOOGLE_CLIENT_ID : cfg.clientId.trim();
  const effClientSecret = usingBuiltIn ? DEFAULT_GOOGLE_CLIENT_SECRET : cfg.clientSecret.trim();
  const account = cfg.account.trim();
  // Calendars to sync: the checked ones, or just the account (primary) on the
  // very first sign-in before the picker is populated.
  const calsToSync = cfg.selectedCalendars.length ? cfg.selectedCalendars : account ? [account] : [];

  const haveCreds = !!effClientId && !!effClientSecret;
  const canSync = haveCreds && !!account && !!currentFile && calsToSync.length > 0;

  // Pull the account's calendar list (after sign-in) to populate the picker,
  // and stash the id→{name,colour} map for the timeline's per-calendar tags.
  const fetchCalendars = async () => {
    if (!haveCreds || !account) return;
    setBusy("cals");
    try {
      const cals = await gcalCalendars(effClientId, effClientSecret, account);
      setCalendars(cals);
      saveCalMap(cals);
      // The calendar→colour map now exists; re-load the current file so its
      // events get tagged + coloured by calendar (the map may not have existed
      // when the file was first opened).
      if (currentFile) void loadFile(currentFile);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };
  // Auto-load the picker once we're authorized and have an account.
  useEffect(() => {
    if (IN_TAURI && status?.authorized && account && calendars.length === 0) {
      void fetchCalendars();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.authorized, account]);

  const toggleCalendar = (id: string) => {
    const sel = cfg.selectedCalendars.includes(id)
      ? cfg.selectedCalendars.filter((x) => x !== id)
      : [...cfg.selectedCalendars, id];
    set({ selectedCalendars: sel });
  };

  const onSync = async () => {
    // Calendar events sync into whatever .org file is the active tab.
    const target = (currentFile ?? "").trim();
    if (!target) {
      setErr("Open an .org file first — calendar events sync into the current tab.");
      return;
    }
    setBusy("sync");
    setErr("");
    setMsg(
      cfg.twoWay
        ? "Two-way syncing… your Emacs edits push to Google and Google's changes pull back."
        : "Syncing… if this is the first time, your browser opens for Google sign-in — approve it, then come back.",
    );
    try {
      // Push any pending timeline MOVES first (org-gcal-post-at-point per
      // event) so the subsequent fetch can't revert them — org-gcal-sync's own
      // export skips gcal-managed events, so this is the only path that uploads
      // a calendar move.
      const ghostIds = gcalPushIds(useOrgStore.getState().gcalGhosts, useOrgStore.getState().doc);
      if (cfg.twoWay && ghostIds.length > 0) {
        setMsg(`Pushing ${ghostIds.length} moved event(s) to Google…`);
        await gcalPush(effClientId, effClientSecret, account, ghostIds, target);
        useOrgStore.getState().clearGcalGhosts();
      }
      setMsg("Syncing…");
      const synced = await gcalSync(effClientId, effClientSecret, account, calsToSync, target, cfg.twoWay);
      // The sign-in just worked — clear any stale "expired" banner.
      useOrgStore.getState().setGcalAuthExpired(false);
      // How many calendar events actually landed in the file? Turns a vague
      // "it says it synced but I see nothing" into an actionable signal.
      const eventCount = synced.nodes.filter((n) => n.calendarId).length;
      setMsg("Synced. Opening the calendar file…");
      await loadFile(target);
      // Anything left (e.g. a one-way fetch reconciled them) is resolved.
      useOrgStore.getState().clearGcalGhosts();
      // Those events are now imported — clear the "new on Google" badge, then
      // re-check so it reflects reality immediately.
      useOrgStore.setState({ gcalNewCount: 0, gcalNewTitles: [] });
      void useOrgStore.getState().checkGcalNew();
      await refreshStatus();
      // Refresh the picker (also captures any newly-created calendars).
      void fetchCalendars();
      setMsg(
        eventCount > 0
          ? `Synced — ${eventCount} calendar event${eventCount === 1 ? "" : "s"} in this file (on the timeline now).`
          : "Synced, but no calendar events were written. Check the calendars selected below are ticked, and that your events fall within the next year / past 6 months.",
      );
    } catch (e) {
      // A dead Google sign-in: show the actionable message and flip the panel
      // (and the rest of the app) into the Reconnect state.
      if (isGcalAuthExpired(e)) {
        useOrgStore.getState().setGcalAuthExpired(true);
        setErr(GCAL_AUTH_EXPIRED_MSG);
      } else {
        setErr(String(e));
      }
      setMsg("");
    } finally {
      setBusy(null);
    }
  };

  // Reconnect: forget the stored token, then re-check status so the button
  // reverts to "Sign in with Google" for a fresh authorization.
  const onReconnect = async () => {
    setBusy("reconnect");
    setErr("");
    setMsg("Clearing the stored Google sign-in…");
    try {
      await gcalReconnect();
      await refreshStatus();
      setMsg('Sign-in cleared. Click "Sign in with Google" to authorize again.');
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
          <Pill
            ok={status?.configured || usingBuiltIn}
            label={status?.configured || usingBuiltIn ? "Configured" : "Not configured"}
          />
          <Pill ok={status?.authorized} label={status?.authorized ? "Authorized" : "Not authorized"} />
          {busy === "status" && <span style={{ color: "var(--c-text-dim)" }}>checking…</span>}
        </div>

        {/* Expired sign-in banner — "Authorized" above only means a token FILE
            exists, not that it still works; this appears the moment a real
            Google call fails because the sign-in died. */}
        {gcalAuthExpired && (
          <div
            style={{
              padding: "9px 11px",
              marginBottom: 14,
              borderRadius: 6,
              background: "var(--c-surface2)",
              border: "1px solid #e0a458",
              color: "#e0a458",
              fontSize: 12.5,
              lineHeight: 1.5,
            }}
          >
            Your Google sign-in has expired or was revoked, so changes aren't reaching Google.
            Click <b>Reconnect</b>, then <b>Sign in with Google</b>. A Google app in "Testing" mode
            expires sign-ins after 7 days — publishing the OAuth app to production removes that.
          </div>
        )}

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

        {usingBuiltIn ? (
          /* Built-in client → one-click sign in. The user only picks which
             calendar and where to write it; no credentials to enter. */
          <div
            style={{
              marginBottom: 14,
              fontSize: 12.5,
              color: "var(--c-text-dim)",
              lineHeight: 1.55,
            }}
          >
            <p style={{ marginTop: 0 }}>
              Click <b>Sign in with Google</b> below — your browser opens Google's consent page,
              you approve access to <b>your own</b> calendar, and events flow into the file you
              choose. Nothing to configure.
            </p>
          </div>
        ) : (
          /* Own-client (advanced / community builds) → full credentials form. */
          <details
            open={!HAS_DEFAULT_GOOGLE_CLIENT}
            style={{ marginBottom: 14, fontSize: 12.5, color: "var(--c-text-dim)" }}
          >
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
              <li>Configure the OAuth consent screen (External, add yourself as a test user).</li>
              <li>
                Create an OAuth <b>Client ID</b> of type <b>Desktop app</b> — copy the Client ID and
                Client secret below.
              </li>
              <li>Your account is your Gmail address; after sign-in, pick which calendars to sync.</li>
            </ol>
          </details>
        )}

        {/* Credentials — only when NOT using the built-in client. */}
        {!usingBuiltIn && (
          <>
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
          </>
        )}
        <Field label="Google account (the email you sign in with)">
          <input
            value={cfg.account}
            onChange={(e) => set({ account: e.target.value })}
            placeholder="you@gmail.com"
            style={input}
          />
        </Field>
        <Field label="Target .org file (the open tab — events sync here)">
          <div
            style={{
              ...input,
              display: "flex",
              alignItems: "center",
              fontFamily: "ui-monospace, monospace",
              fontSize: 12,
              color: currentFile ? "var(--c-text)" : "var(--c-red)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={currentFile ?? undefined}
          >
            {currentFile ?? "No .org file open — open a tab first"}
          </div>
        </Field>

        {/* Multi-calendar picker — appears once authorized + calendars loaded.
            Each row shows the calendar's Google colour (also used as its tag). */}
        {status?.authorized && (
          <Field
            label={`Calendars to sync${cfg.selectedCalendars.length ? ` (${cfg.selectedCalendars.length} selected)` : ""}`}
          >
            {busy === "cals" ? (
              <span style={{ fontSize: 12, color: "var(--c-text-dim)" }}>Loading calendars…</span>
            ) : calendars.length === 0 ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "var(--c-text-dim)" }}>
                  No calendars loaded yet.
                </span>
                <button onClick={fetchCalendars} style={secondaryBtn}>
                  Load calendars
                </button>
              </div>
            ) : (
              <div
                style={{
                  maxHeight: 168,
                  overflowY: "auto",
                  border: "1px solid var(--c-border)",
                  borderRadius: 7,
                  padding: "4px 0",
                }}
              >
                {calendars.map((c) => {
                  const checked = cfg.selectedCalendars.includes(c.id);
                  return (
                    <label
                      key={c.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "5px 10px",
                        cursor: "pointer",
                        fontSize: 12.5,
                      }}
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggleCalendar(c.id)} />
                      <span
                        style={{
                          width: 11,
                          height: 11,
                          borderRadius: 3,
                          flexShrink: 0,
                          background: c.color ?? "var(--c-text-dim)",
                          boxShadow: "0 0 0 1px rgba(0,0,0,0.25) inset",
                        }}
                      />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {c.summary}
                        {c.primary && (
                          <span style={{ color: "var(--c-text-dim)", marginLeft: 5 }}>· primary</span>
                        )}
                        {c.accessRole === "reader" || c.accessRole === "freeBusyReader" ? (
                          <span style={{ color: "var(--c-text-dim)", marginLeft: 5 }}>· read-only</span>
                        ) : null}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </Field>
        )}

        {/* Two-way sync toggle. */}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 4,
            marginBottom: 10,
            fontSize: 12.5,
            cursor: "pointer",
          }}
        >
          <input type="checkbox" checked={cfg.twoWay} onChange={(e) => set({ twoWay: e.target.checked })} />
          <span>
            Two-way sync — push my Emacs edits back to Google on Sync
            <span style={{ color: "var(--c-text-dim)", display: "block", fontSize: 11 }}>
              Edits to synced events update Google; org entries assigned to a calendar create new
              events. Off = pull only (Google → org).
            </span>
          </span>
        </label>

        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
          <button
            onClick={onSync}
            disabled={busy != null || !status?.available || !canSync}
            style={{ ...primaryBtn, opacity: !status?.available || !canSync ? 0.5 : 1 }}
            title={
              !status?.available
                ? "Install org-gcal first"
                : !canSync
                  ? "Enter your Google account email and a target .org file"
                  : cfg.twoWay
                    ? "Push your edits to Google and pull Google's changes"
                    : "Pull events from Google into the target file"
            }
          >
            {busy === "sync"
              ? "Syncing…"
              : !status?.authorized
                ? "Sign in with Google"
                : cfg.twoWay
                  ? "Sync now (two-way)"
                  : "Sync now"}
          </button>
          <button onClick={refreshStatus} disabled={busy != null} style={secondaryBtn}>
            Refresh status
          </button>
          {/* Reconnect: always available once a token file exists (and made
              prominent when we KNOW the sign-in is dead) so re-authorizing is
              one click instead of deleting a file by hand. */}
          {(status?.authorized || gcalAuthExpired) && (
            <button
              onClick={onReconnect}
              disabled={busy != null}
              title="Forget the stored Google token so you can sign in again (use this if sync stopped working)."
              style={
                gcalAuthExpired
                  ? { ...primaryBtn, background: "#e0a458", color: "#1c1c1e" }
                  : { ...secondaryBtn, color: "#e0a458", borderColor: "#e0a458" }
              }
            >
              {busy === "reconnect" ? "Reconnecting…" : "Reconnect"}
            </button>
          )}
        </div>

        {/* Toggle between the built-in client and your own OAuth credentials.
            Only shown when this build actually ships a first-party client. */}
        {HAS_DEFAULT_GOOGLE_CLIENT && (
          <button
            onClick={() => set({ useOwnClient: !cfg.useOwnClient })}
            style={{
              background: "none",
              border: "none",
              color: "var(--c-accent)",
              fontSize: 11.5,
              cursor: "pointer",
              padding: 0,
              marginTop: 10,
            }}
          >
            {cfg.useOwnClient
              ? "← Use the built-in Google sign-in"
              : "Advanced: use my own Google OAuth client →"}
          </button>
        )}

        {msg && <p style={{ fontSize: 12.5, color: "var(--c-text-dim)", marginBottom: 0 }}>{msg}</p>}
        {err && (
          <p style={{ fontSize: 12.5, color: "var(--c-red)", whiteSpace: "pre-wrap", marginBottom: 0 }}>
            {err}
          </p>
        )}
        <p style={{ fontSize: 11, color: "var(--c-text-dim)", marginTop: 14, marginBottom: 0 }}>
          Each calendar's events are tagged + coloured by calendar on the timeline. Two-way sync
          pushes your Emacs edits back to Google when enabled.
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
