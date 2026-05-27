import { useMemo } from "react";
import { ViewportPortal, useStore } from "@xyflow/react";
import { useOrgStore } from "../store/useOrgStore";

/**
 * Per-node radiant aura. Each tagged node emits its own soft luminous halo
 * in its tag colour — a small bright core surrounded by a wide Gaussian
 * blur, just like a star's corona. Two design constraints make the result
 * read as "shared light" instead of "fuzzy line" or "polygon hull":
 *
 *  1. No MST, no paths, no connecting lines drawn. Glow is per-node only.
 *     If two tagged nodes sit close, their wide halos overlap in space and
 *     blend — that overlap IS the "sharing". If they're far apart, two
 *     isolated stars.
 *  2. mix-blend-mode: screen on the SVG layer so the colors blend
 *     ADDITIVELY against the dark canvas (overlapping halos brighten
 *     instead of just stacking with opacity). Same node carrying multiple
 *     coloured tags gets multiple stacked halos that blend the same way.
 *
 * Respects the global ✦ Aura toggle and the filter-override: OFF + no
 * filter → render nothing; OFF + filter set → only the filtered tag's
 * halos draw; ON → every coloured tag glows.
 */
export default function TagAura() {
  const tagColors = useOrgStore((s) => s.tagColors);
  const tagFilter = useOrgStore((s) => s.tagFilter);
  const tagAuraEnabled = useOrgStore((s) => s.tagAuraEnabled);
  const doc = useOrgStore((s) => s.doc);
  const flowNodes = useStore((s) => s.nodes);

  const halos = useMemo(() => {
    if (!doc) return [] as { key: string; color: string; cx: number; cy: number }[];
    if (!tagAuraEnabled && tagFilter == null) return [];

    const nodeById = new Map<string, typeof doc.nodes[number]>();
    for (const n of doc.nodes) nodeById.set(n.id, n);

    const out: { key: string; color: string; cx: number; cy: number }[] = [];
    for (const fn of flowNodes) {
      const org = nodeById.get(fn.id);
      if (!org) continue;
      const tags = (org.tagsAll ?? []).filter((t) => tagColors[t]);
      if (tags.length === 0) continue;
      const w = fn.width ?? fn.measured?.width ?? 220;
      const h = fn.height ?? fn.measured?.height ?? 60;
      const cx = fn.position.x + w / 2;
      const cy = fn.position.y + h / 2;
      for (const t of tags) {
        if (tagFilter != null && t !== tagFilter) continue;
        out.push({ key: `${fn.id}:${t}`, color: tagColors[t], cx, cy });
      }
    }
    return out;
  }, [doc, flowNodes, tagColors, tagFilter, tagAuraEnabled]);

  if (halos.length === 0) return null;

  return (
    <ViewportPortal>
      <svg
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          overflow: "visible",
          pointerEvents: "none",
          // Additive light: overlapping halos brighten the dark canvas
          // instead of just stacking with alpha. The "shared glow" the user
          // wanted falls out of this for free when nodes are close enough
          // for their wide blurs to overlap.
          mixBlendMode: "screen",
        }}
        width="1"
        height="1"
      >
        <defs>
          {/* Pure Gaussian blur — no alpha threshold (that's what flattened
              the colours into grey blobs in v0.2.11). The wide blur is the
              corona; the small filled circle below is the bright core that
              survives the blur as a hotspot. */}
          <filter id="org-aura-blur" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="28" />
          </filter>
        </defs>
        <g filter="url(#org-aura-blur)">
          {halos.map(({ key, color, cx, cy }) => (
            <circle key={key} cx={cx} cy={cy} r={22} fill={color} opacity={0.85} />
          ))}
        </g>
      </svg>
    </ViewportPortal>
  );
}
