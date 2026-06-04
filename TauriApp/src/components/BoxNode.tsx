import { useState } from "react";
import { useStore, type NodeProps } from "@xyflow/react";
import { useOrgStore, type CanvasBox, REGION_PALETTE } from "../store/useOrgStore";

/**
 * A user-drawn "region" box on the canvas (React Flow node, type `box`).
 *
 * Rendering / pointer model — the tricky part:
 *  - The node WRAPPER (.react-flow__node) is given `pointerEvents: none`
 *    (set via the node's `style` in TimelineGraph) so the box's interior is
 *    click-through: ordinary nodes sitting inside the region stay fully
 *    interactive, and panning the canvas works right through the box.
 *  - Only specific bits opt back IN to pointer events: four thin EDGE strips
 *    + the header chip carry the `.box-move-handle` class (React Flow's
 *    `dragHandle`), so the box can be grabbed and moved by its border or
 *    header but not by its empty middle. The ✕ delete button, the colour
 *    swatch, and the bottom-right resize grip handle their own gestures.
 *
 * Boxes render BENEATH ordinary nodes (low zIndex) and are never "selected"
 * (selectable:false) — their affordances appear on hover instead, so a box
 * never steals the pane-click-to-deselect or elevates above the nodes it
 * contains.
 */
const EDGE = 12; // px thickness of the grabbable border strips
const DEFAULT_COLOR = "#8ab4f8";

export default function BoxNode({ id, data }: NodeProps) {
  const box = (data as { box: CanvasBox }).box;
  const color = box.color || DEFAULT_COLOR;
  const updateBox = useOrgStore((s) => s.updateBox);
  const removeBox = useOrgStore((s) => s.removeBox);
  const zoom = useStore((s) => s.transform[2]);

  const [hover, setHover] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState(box.label ?? "");

  // Drag the bottom-right grip to resize. Pointer moves are in screen pixels;
  // divide by the current zoom to convert to flow units (the box geometry is
  // stored in flow coordinates). Width/height stay clamped to a sane minimum.
  const onResizeDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = box.w;
    const startH = box.h;
    const z = zoom || 1;
    const move = (ev: PointerEvent) => {
      const w = Math.max(80, startW + (ev.clientX - startX) / z);
      const h = Math.max(60, startH + (ev.clientY - startY) / z);
      updateBox(id, { w, h });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const commitLabel = () => {
    setEditing(false);
    updateBox(id, { label: draftLabel.trim() || undefined });
  };

  const stripStyle: React.CSSProperties = {
    position: "absolute",
    pointerEvents: "auto",
    cursor: "move",
  };

  return (
    <div
      style={{ width: "100%", height: "100%", position: "relative", pointerEvents: "none" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* Visual dotted border + faint fill (non-interactive — the strips below
          do the grabbing). */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          border: `2px dashed ${color}`,
          borderRadius: 8,
          background: hover ? `${color}14` : `${color}0a`,
          boxSizing: "border-box",
          transition: "background 0.12s",
        }}
      />

      {/* Four grabbable edge strips (move handles). */}
      <div className="box-move-handle" style={{ ...stripStyle, left: 0, right: 0, top: 0, height: EDGE }} />
      <div className="box-move-handle" style={{ ...stripStyle, left: 0, right: 0, bottom: 0, height: EDGE }} />
      <div className="box-move-handle" style={{ ...stripStyle, top: 0, bottom: 0, left: 0, width: EDGE }} />
      <div className="box-move-handle" style={{ ...stripStyle, top: 0, bottom: 0, right: 0, width: EDGE }} />

      {/* Header chip — label (double-click to rename) + move handle. */}
      {editing ? (
        <input
          autoFocus
          value={draftLabel}
          onChange={(e) => setDraftLabel(e.target.value)}
          onBlur={commitLabel}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitLabel();
            else if (e.key === "Escape") {
              setDraftLabel(box.label ?? "");
              setEditing(false);
            }
          }}
          placeholder="Region name…"
          style={{
            position: "absolute",
            top: -13,
            left: 8,
            pointerEvents: "auto",
            font: "600 11px system-ui, sans-serif",
            color: "#1c1c1e",
            background: color,
            border: "none",
            borderRadius: 5,
            padding: "2px 6px",
            outline: "none",
            width: 130,
          }}
        />
      ) : (
        <div
          className="box-move-handle"
          onDoubleClick={() => {
            setDraftLabel(box.label ?? "");
            setEditing(true);
          }}
          title="Drag to move the region · double-click to rename"
          style={{
            position: "absolute",
            top: -13,
            left: 8,
            pointerEvents: "auto",
            cursor: "move",
            font: "600 11px system-ui, sans-serif",
            color: "#1c1c1e",
            background: color,
            borderRadius: 5,
            padding: "2px 7px",
            maxWidth: "70%",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
          }}
        >
          {box.label || "Region"}
        </div>
      )}

      {/* Hover toolbar: quick preset colours + a full custom picker + delete.
          Floats at the top-right edge; pointerDown is swallowed so using it
          never starts a box drag. */}
      {hover && !editing && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: -16,
            right: 2,
            display: "flex",
            alignItems: "center",
            gap: 3,
            padding: "2px 4px",
            background: "var(--c-surface)",
            border: "1px solid var(--c-border)",
            borderRadius: 6,
            pointerEvents: "auto",
            boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
            zIndex: 3,
          }}
        >
          {REGION_PALETTE.slice(0, 6).map((c) => {
            const active = c.toLowerCase() === color.toLowerCase();
            return (
              <button
                key={c}
                title={`Use ${c}`}
                onClick={() => updateBox(id, { color: c })}
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  background: c,
                  border: active ? "2px solid #fff" : "1px solid rgba(0,0,0,0.4)",
                  padding: 0,
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              />
            );
          })}
          <label
            title="Custom colour…"
            style={{
              position: "relative",
              width: 14,
              height: 14,
              borderRadius: "50%",
              overflow: "hidden",
              cursor: "pointer",
              flexShrink: 0,
              border: "1px solid rgba(0,0,0,0.4)",
              background: "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)",
            }}
          >
            <input
              type="color"
              value={color}
              onChange={(e) => updateBox(id, { color: e.target.value })}
              onPointerDown={(e) => e.stopPropagation()}
              style={{ opacity: 0, width: "100%", height: "100%", cursor: "pointer", border: "none" }}
            />
          </label>
          <button
            title="Delete this region (its nodes are freed)"
            onClick={() => removeBox(id)}
            style={{
              width: 16,
              height: 16,
              borderRadius: 4,
              border: "none",
              background: "#d96459",
              color: "#fff",
              font: "700 11px system-ui, sans-serif",
              lineHeight: "16px",
              textAlign: "center",
              padding: 0,
              marginLeft: 2,
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Bottom-right resize grip. */}
      <div
        onPointerDown={onResizeDown}
        title="Drag to resize the region"
        style={{
          position: "absolute",
          right: -5,
          bottom: -5,
          width: 16,
          height: 16,
          borderRadius: 4,
          background: color,
          border: "1px solid rgba(0,0,0,0.35)",
          cursor: "nwse-resize",
          pointerEvents: "auto",
          opacity: hover ? 1 : 0.6,
          boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
        }}
      />
    </div>
  );
}
