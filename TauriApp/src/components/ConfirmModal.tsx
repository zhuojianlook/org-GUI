import { useEffect } from "react";
import { useOrgStore, type ConfirmOption } from "../store/useOrgStore";

/**
 * Themed, in-app confirmation modal — replaces the native OS dialog so the
 * warning matches the application's look. Driven entirely by store state:
 * `store.confirm({title, message, options})` opens it and resolves with the
 * clicked option's value (or null when dismissed via Esc / backdrop).
 *
 * Mounted once at the app root; renders nothing until a confirm is requested.
 */
export default function ConfirmModal() {
  const req = useOrgStore((s) => s.confirmRequest);
  const resolveConfirm = useOrgStore((s) => s.resolveConfirm);

  // Esc dismisses (resolves null). Bound only while a request is open.
  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        resolveConfirm(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [req, resolveConfirm]);

  if (!req) return null;

  return (
    <div
      onClick={() => resolveConfirm(null)}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10050,
        backdropFilter: "blur(1px)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{
          width: 440,
          maxWidth: "92vw",
          background: "var(--c-surface)",
          border: "1px solid var(--c-border)",
          borderRadius: 10,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
          color: "var(--c-text)",
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700 }}>{req.title}</div>
        <div
          style={{
            fontSize: 13,
            lineHeight: 1.5,
            color: "var(--c-text-dim)",
            whiteSpace: "pre-wrap",
          }}
        >
          {req.message}
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            flexWrap: "wrap",
            gap: 8,
            marginTop: 4,
          }}
        >
          {req.options.map((opt, i) => (
            <button
              key={opt.value}
              // Focus the LAST button (the safe / cancel choice in our flows)
              // so a stray Enter never triggers a destructive default.
              autoFocus={i === req.options.length - 1}
              onClick={() => resolveConfirm(opt.value)}
              style={buttonStyle(opt.kind)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function buttonStyle(kind: ConfirmOption["kind"]): React.CSSProperties {
  const base: React.CSSProperties = {
    borderRadius: 8,
    padding: "8px 14px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    border: "1px solid transparent",
  };
  if (kind === "danger") return { ...base, background: "#d96459", color: "#fff" };
  if (kind === "primary") return { ...base, background: "var(--c-accent)", color: "#fff" };
  return {
    ...base,
    background: "transparent",
    color: "var(--c-text)",
    border: "1px solid var(--c-border)",
  };
}
