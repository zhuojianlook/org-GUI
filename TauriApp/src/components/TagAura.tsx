import { useMemo } from "react";
import { ViewportPortal, useStore } from "@xyflow/react";
import { useOrgStore } from "../store/useOrgStore";

/**
 * Tag aura — per-tag visual grouping in the canvas, designed to match the
 * user's mental model after several iterations:
 *
 *  1. Each tagged node gets a soft RECTANGULAR fuzz in its tag colour
 *     (sized to the node, not a giant disc). Heavy Gaussian blur turns it
 *     into a luminous halo that follows the node's silhouette, with a
 *     bright core and a fade-to-transparent edge.
 *  2. MST edges between every tagged-node pair are ALWAYS drawn — but the
 *     stroke width decays inverse-quadratically with distance so close
 *     pairs read as bold filaments and far pairs as barely-there wisps.
 *     The user wanted "always present, just thinner".
 *  3. The whole SVG layer renders with mix-blend-mode: screen so
 *     overlapping halos and crossing lines BRIGHTEN the canvas additively
 *     instead of just stacking with opacity. More tagged nodes near each
 *     other ⇒ more glow.
 *
 * Respects the global ✦ Aura toggle and filter override: OFF + no filter →
 * nothing rendered; OFF + filter set → only the filtered tag draws; ON →
 * every coloured tag glows.
 */
export default function TagAura() {
  const tagColors = useOrgStore((s) => s.tagColors);
  const tagFilter = useOrgStore((s) => s.tagFilter);
  const tagAuraEnabled = useOrgStore((s) => s.tagAuraEnabled);
  const doc = useOrgStore((s) => s.doc);
  const flowNodes = useStore((s) => s.nodes);

  type Halo = { x: number; y: number; w: number; h: number };
  type Group = { tag: string; color: string; halos: Halo[]; edges: [Halo, Halo][] };

  const groups = useMemo(() => {
    if (!doc) return [] as Group[];
    if (!tagAuraEnabled && tagFilter == null) return [];

    const nodeById = new Map<string, typeof doc.nodes[number]>();
    for (const n of doc.nodes) nodeById.set(n.id, n);

    const buckets = new Map<string, Halo[]>();
    for (const fn of flowNodes) {
      const org = nodeById.get(fn.id);
      if (!org) continue;
      const tags = (org.tagsAll ?? []).filter((t) => tagColors[t]);
      if (tags.length === 0) continue;
      const w = fn.width ?? fn.measured?.width ?? 220;
      const h = fn.height ?? fn.measured?.height ?? 60;
      const halo: Halo = { x: fn.position.x, y: fn.position.y, w, h };
      for (const t of tags) {
        if (tagFilter != null && t !== tagFilter) continue;
        const arr = buckets.get(t) ?? [];
        arr.push(halo);
        buckets.set(t, arr);
      }
    }

    const out: Group[] = [];
    for (const [tag, halos] of buckets) {
      out.push({
        tag,
        color: tagColors[tag],
        halos,
        edges: mstEdges(halos),
      });
    }
    return out;
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
          mixBlendMode: "screen",
        }}
        width="1"
        height="1"
      >
        <defs>
          {/* Heavy blur for the per-node fuzz — gives each rounded rect a
              soft, asymmetric glow that follows the node silhouette instead
              of a perfect circle. */}
          <filter id="org-aura-fuzz" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="18" />
          </filter>
          {/* Subtler blur for the filaments so they have a slight glow
              without smearing into invisibility. */}
          <filter id="org-aura-line" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" />
          </filter>
        </defs>

        {groups.map(({ tag, color, halos, edges }) => (
          <g key={tag}>
            {/* Per-node rectangular fuzz. The rect is drawn solid; the
                heavy blur turns it into a fade-to-transparent halo with a
                bright core where the node sits. */}
            <g filter="url(#org-aura-fuzz)" opacity={0.75}>
              {halos.map((h, i) => (
                <rect
                  key={i}
                  x={h.x}
                  y={h.y}
                  width={h.w}
                  height={h.h}
                  rx={10}
                  ry={10}
                  fill={color}
                />
              ))}
            </g>
            {/* MST filaments rendered as TAPERED dendrite polygons — wide at
                each endpoint (near the node), pinched in the middle. SVG
                strokes can't vary width along a path, so we sample the bezier
                and emit a closed shape with perpendicular offsets. Distance
                still scales the overall thickness so far edges stay thin. */}
            <g filter="url(#org-aura-line)" opacity={0.9}>
              {edges.map(([a, b], i) => {
                const [ax, ay] = centerOf(a);
                const [bx, by] = centerOf(b);
                const d = Math.hypot(ax - bx, ay - by);
                const scale = widthScaleForDistance(d);
                const wide = 12 * scale; // width at endpoints
                const narrow = Math.max(0.6, 1.4 * scale); // width at midpoint
                return (
                  <path
                    key={i}
                    d={taperedBezierPolygon(ax, ay, bx, by, wide, narrow)}
                    fill={color}
                  />
                );
              })}
            </g>
          </g>
        ))}
      </svg>
    </ViewportPortal>
  );
}

function centerOf(h: { x: number; y: number; w: number; h: number }): [number, number] {
  return [h.x + h.w / 2, h.y + h.h / 2];
}

/** Inverse decay: scale factor for the overall dendrite thickness. Near pairs
 *  scale ≈ 1 (full thickness), far pairs scale ≈ 0.15 (hair-thin). Keeps the
 *  "always present, just thinner" rule. */
function widthScaleForDistance(d: number): number {
  return Math.max(0.15, 1 / (1 + d / 200));
}

/**
 * Generate a closed SVG path that traces a tapered "dendrite" polygon along
 * a quadratic bezier from A to B. Samples the bezier at N points; at each
 * sample we offset perpendicular to the tangent by ±widthAt(t)/2 where the
 * width is `wide` at the endpoints and `narrow` at the midpoint, following
 * a smooth `1 - sin(πt)` taper. The two offset paths form one closed shape.
 *
 * The shape's perpendicular control point is the same one we used to give
 * the old curved stroke its organic curvature.
 */
function taperedBezierPolygon(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  wide: number,
  narrow: number,
  samples = 24,
): string {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.max(1, Math.hypot(dx, dy));
  const offset = Math.min(len * 0.15, 60);
  // Perpendicular unit vector for the control-point offset.
  const ux = -dy / len;
  const uy = dx / len;
  const cx = (ax + bx) / 2 + ux * offset;
  const cy = (ay + by) / 2 + uy * offset;

  const upper: [number, number][] = [];
  const lower: [number, number][] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const ti = 1 - t;
    // Point on quadratic bezier P(t) = (1-t)²A + 2t(1-t)C + t²B
    const px = ti * ti * ax + 2 * t * ti * cx + t * t * bx;
    const py = ti * ti * ay + 2 * t * ti * cy + t * t * by;
    // Tangent P'(t) = 2(1-t)(C-A) + 2t(B-C)
    const tx = 2 * ti * (cx - ax) + 2 * t * (bx - cx);
    const ty = 2 * ti * (cy - ay) + 2 * t * (by - cy);
    const tl = Math.max(0.0001, Math.hypot(tx, ty));
    // Perpendicular to the tangent (rotated 90°), unit length.
    const nxi = -ty / tl;
    const nyi = tx / tl;
    // Smooth dendrite taper: width(0) = wide, width(0.5) = narrow,
    // width(1) = wide. `1 - sin(πt)` is wide → narrow → wide with C¹
    // continuity (no kinks at the endpoints).
    const u = 1 - Math.sin(Math.PI * t);
    const w = (narrow + (wide - narrow) * u) / 2;
    upper.push([px + nxi * w, py + nyi * w]);
    lower.push([px - nxi * w, py - nyi * w]);
  }

  // Walk upper forward, then lower in reverse, close the polygon.
  const parts: string[] = [`M ${upper[0][0]},${upper[0][1]}`];
  for (let i = 1; i < upper.length; i++) parts.push(`L ${upper[i][0]},${upper[i][1]}`);
  for (let i = lower.length - 1; i >= 0; i--) parts.push(`L ${lower[i][0]},${lower[i][1]}`);
  parts.push("Z");
  return parts.join(" ");
}

/** Prim's MST over the halo centres. Returns pairs of halos forming the
 *  N-1 minimum spanning edges, so we draw exactly enough lines to connect
 *  every tagged node into one tree without visual clutter. */
function mstEdges(halos: { x: number; y: number; w: number; h: number }[]): [
  { x: number; y: number; w: number; h: number },
  { x: number; y: number; w: number; h: number },
][] {
  const n = halos.length;
  if (n < 2) return [];
  const centers = halos.map(centerOf);
  const inTree = new Array(n).fill(false);
  const fromIdx = new Array(n).fill(-1);
  const cost = new Array(n).fill(Infinity);
  inTree[0] = true;
  cost[0] = 0;
  for (let j = 1; j < n; j++) {
    cost[j] = Math.hypot(centers[0][0] - centers[j][0], centers[0][1] - centers[j][1]);
    fromIdx[j] = 0;
  }
  const edges: [typeof halos[number], typeof halos[number]][] = [];
  for (let step = 1; step < n; step++) {
    let best = -1;
    let bestCost = Infinity;
    for (let j = 0; j < n; j++) {
      if (!inTree[j] && cost[j] < bestCost) {
        bestCost = cost[j];
        best = j;
      }
    }
    if (best === -1) break;
    inTree[best] = true;
    edges.push([halos[fromIdx[best]], halos[best]]);
    for (let j = 0; j < n; j++) {
      if (!inTree[j]) {
        const c = Math.hypot(centers[best][0] - centers[j][0], centers[best][1] - centers[j][1]);
        if (c < cost[j]) {
          cost[j] = c;
          fromIdx[j] = best;
        }
      }
    }
  }
  return edges;
}
