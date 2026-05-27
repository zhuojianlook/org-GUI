import { useMemo } from "react";
import { ViewportPortal, useStore } from "@xyflow/react";
import { useOrgStore } from "../store/useOrgStore";

/**
 * Organic "metaball" aura behind tagged nodes. For each coloured tag we drop
 * one translucent circle per tagged node and pump the whole tag group through
 * an SVG goo filter (feGaussianBlur + alpha-threshold via feColorMatrix). The
 * result: nearby same-tag circles physically merge into a single flowing
 * blob, like wet ink spreading. Multi-tag = one circle per tag at the same
 * position so each colour gets its own blob field.
 *
 * Respect the global aura toggle: when OFF + no filter, render nothing.
 * When OFF + filter set, render only the filtered tag's blobs (so the filter
 * narrative still has visual emphasis). When ON, all coloured tags glow.
 *
 * Lives inside ViewportPortal so coordinates are flow-space (pans/zooms with
 * the canvas).
 */
export default function TagAura() {
  const tagColors = useOrgStore((s) => s.tagColors);
  const tagFilter = useOrgStore((s) => s.tagFilter);
  const tagAuraEnabled = useOrgStore((s) => s.tagAuraEnabled);
  const doc = useOrgStore((s) => s.doc);
  const flowNodes = useStore((s) => s.nodes);

  const groups = useMemo(() => {
    if (!doc) return [] as { tag: string; color: string; circles: { x: number; y: number; r: number }[] }[];
    // When the toggle is off and no filter is set, no aura at all.
    if (!tagAuraEnabled && tagFilter == null) return [];

    const nodeById = new Map<string, typeof doc.nodes[number]>();
    for (const n of doc.nodes) nodeById.set(n.id, n);

    const buckets = new Map<string, { x: number; y: number; r: number }[]>();
    for (const fn of flowNodes) {
      const org = nodeById.get(fn.id);
      if (!org) continue;
      const tags = (org.tagsAll ?? []).filter((t) => tagColors[t]);
      if (tags.length === 0) continue;
      const w = fn.width ?? fn.measured?.width ?? 220;
      const h = fn.height ?? fn.measured?.height ?? 60;
      // Use a radius derived from the node's diagonal — bigger nodes get bigger
      // blobs, so the blob field always touches the node's bounding region.
      const r = Math.max(48, Math.sqrt(w * w + h * h) * 0.55);
      const cx = fn.position.x + w / 2;
      const cy = fn.position.y + h / 2;
      for (const t of tags) {
        // Skip non-filtered tags when filter is active (mirrors the filter
        // override behaviour: only the active tag's blob shows).
        if (tagFilter != null && t !== tagFilter) continue;
        const arr = buckets.get(t) ?? [];
        arr.push({ x: cx, y: cy, r });
        buckets.set(t, arr);
      }
    }
    return [...buckets.entries()].map(([tag, circles]) => ({
      tag,
      color: tagColors[tag],
      circles,
    }));
  }, [doc, flowNodes, tagColors, tagFilter, tagAuraEnabled]);

  if (groups.length === 0) return null;

  return (
    <ViewportPortal>
      <svg
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          overflow: "visible",
          pointerEvents: "none",
        }}
        width="1"
        height="1"
      >
        <defs>
          {/* The classic "goo" filter: heavy blur, then crank alpha so the
              blurred bits past a threshold stay solid and below it vanish.
              Net effect — overlapping circles bleed into one blob with hard
              edges instead of looking like a fuzzy cloud. */}
          <filter id="org-tag-goo">
            <feGaussianBlur in="SourceGraphic" stdDeviation="22" result="blur" />
            <feColorMatrix
              in="blur"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -10"
              result="goo"
            />
            <feBlend in="goo" in2="SourceGraphic" />
          </filter>
        </defs>
        {groups.map(({ tag, color, circles }) => (
          <g key={tag} filter="url(#org-tag-goo)" style={{ opacity: 0.6 }}>
            {circles.map((c, i) => (
              <circle key={i} cx={c.x} cy={c.y} r={c.r} fill={color} />
            ))}
          </g>
        ))}
      </svg>
    </ViewportPortal>
  );
}
