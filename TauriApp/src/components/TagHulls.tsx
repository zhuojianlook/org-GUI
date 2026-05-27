import { useMemo } from "react";
import { ViewportPortal, useStore } from "@xyflow/react";
import { useOrgStore } from "../store/useOrgStore";
import { convexHull, hullToSvgPath } from "../utils/tagColor";

/**
 * Background "river" overlay that groups tagged nodes together. For each tag
 * with a user-assigned colour, we collect the bounding-box corners of every
 * visible node that carries it, take the convex hull, and render the result
 * as an SVG path with a translucent fill plus a wide round-joined stroke.
 * The wide stroke does the heavy lifting:
 *   • 1-node groups (degenerate hull = a point) become circles.
 *   • 2-node groups become capsules.
 *   • 3+-node groups become smooth polygons with rounded corners.
 * Lives inside ViewportPortal so coordinates are interpreted in flow space
 * and the overlay pans/zooms with the rest of the canvas.
 */
export default function TagHulls() {
  const tagColors = useOrgStore((s) => s.tagColors);
  const tagFilter = useOrgStore((s) => s.tagFilter);
  const doc = useOrgStore((s) => s.doc);
  // React Flow's measured node list — gives us width/height once the DOM
  // has rendered (.measured), falling back to the layout-supplied size.
  const flowNodes = useStore((s) => s.nodes);

  // Group node corner points by tag colour. We use rectangle corners (not
  // just centres) so the hull encloses the actual node body, not a tight
  // path that would clip through the cards.
  const pathsByTag = useMemo(() => {
    if (!doc) return [] as { tag: string; color: string; d: string; filtered: boolean }[];
    const nodeById = new Map<string, typeof doc.nodes[number]>();
    for (const n of doc.nodes) nodeById.set(n.id, n);

    // tag → array of [x,y] corner points across every visible tagged node.
    const buckets = new Map<string, [number, number][]>();
    for (const fn of flowNodes) {
      const org = nodeById.get(fn.id);
      if (!org) continue;
      const tags = (org.tagsAll ?? []).filter((t) => tagColors[t]);
      if (tags.length === 0) continue;
      const w = (fn.width ?? fn.measured?.width ?? 220);
      const h = (fn.height ?? fn.measured?.height ?? 60);
      const x = fn.position.x;
      const y = fn.position.y;
      // Pad the corners inward slightly so the hull hugs the card rather than
      // jutting past it; the wide stroke later puffs it back out.
      const PAD = 6;
      const corners: [number, number][] = [
        [x + PAD, y + PAD],
        [x + w - PAD, y + PAD],
        [x + PAD, y + h - PAD],
        [x + w - PAD, y + h - PAD],
      ];
      for (const t of tags) {
        const arr = buckets.get(t) ?? [];
        arr.push(...corners);
        buckets.set(t, arr);
      }
    }

    const out: { tag: string; color: string; d: string; filtered: boolean }[] = [];
    for (const [tag, points] of buckets) {
      const hull = convexHull(points);
      const d = hullToSvgPath(hull);
      if (!d) continue;
      const filtered = tagFilter != null && tagFilter !== tag;
      out.push({ tag, color: tagColors[tag], d, filtered });
    }
    return out;
  }, [doc, flowNodes, tagColors, tagFilter]);

  if (pathsByTag.length === 0) return null;

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
        // SVG with no width/height collapses; give it a tiny anchor — the
        // overflow:visible makes the paths draw outside the viewBox anyway.
        width="1"
        height="1"
      >
        {pathsByTag.map(({ tag, color, d, filtered }) => (
          <path
            key={tag}
            d={d}
            fill={color}
            fillOpacity={filtered ? 0.04 : 0.12}
            stroke={color}
            strokeOpacity={filtered ? 0.18 : 0.55}
            strokeWidth={48}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
      </svg>
    </ViewportPortal>
  );
}
