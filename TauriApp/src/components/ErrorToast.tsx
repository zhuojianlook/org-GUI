import { useEffect } from "react";
import { useOrgStore } from "../store/useOrgStore";

/**
 * Bottom-right transient toast that surfaces store errors to the user.
 * Without it most edit-failures (e.g. Org refusing a DONE transition
 * because of unfinished sub-tasks) would land silently in the store's
 * `error` field and be invisible from the canvas.
 *
 * Auto-dismisses after 8 seconds; manual ✕ also clears.
 */
export default function ErrorToast() {
  const error = useOrgStore((s) => s.error);
  const clearError = useOrgStore((s) => s.clearError);

  useEffect(() => {
    if (!error) return;
    const id = window.setTimeout(() => clearError(), 8000);
    return () => window.clearTimeout(id);
  }, [error, clearError]);

  if (!error) return null;

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 10500,
        maxWidth: 420,
        background: "var(--c-surface)",
        border: "1px solid var(--c-red)",
        borderLeft: "4px solid var(--c-red)",
        borderRadius: 8,
        padding: "10px 14px 10px 12px",
        color: "var(--c-text)",
        fontSize: 12.5,
        lineHeight: 1.45,
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        boxShadow: "0 10px 30px rgba(0,0,0,0.55)",
      }}
    >
      <span
        aria-hidden
        style={{
          fontSize: 16,
          lineHeight: 1,
          color: "var(--c-red)",
          flexShrink: 0,
          marginTop: 1,
        }}
      >
        ⚠
      </span>
      <span style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{error}</span>
      <button
        onClick={() => clearError()}
        title="Dismiss"
        style={{
          background: "transparent",
          border: "none",
          color: "var(--c-text-dim)",
          cursor: "pointer",
          padding: 0,
          fontSize: 14,
          lineHeight: 1,
          flexShrink: 0,
        }}
      >
        ✕
      </button>
    </div>
  );
}
