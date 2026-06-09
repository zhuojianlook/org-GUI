import { useMemo, useRef } from "react";
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

  // Last computed groups, reused verbatim while a node is mid-drag so we don't
  // rebuild every tagged node's MST on every animation frame.
  const lastGroups = useRef<Group[]>([]);

  const groups = useMemo(() => {
    if (!doc) return [] as Group[];
    if (!tagAuraEnabled && tagFilter == null) return [];

    // While the user is dragging a node, React Flow rewrites `s.nodes` every
    // frame. Recomputing the aura (per-tag halos + Prim's MST) that often is
    // wasteful and the decorative glow snapping to the new spot on release is
    // imperceptible — so freeze it during the drag. Returning the SAME array
    // reference also skips re-rendering the (blur-filtered) SVG entirely.
    if (flowNodes.some((n) => n.dragging)) return lastGroups.current;

    const nodeById = new Map<string, typeof doc.nodes[number]>();
    for (const n of doc.nodes) nodeById.set(n.id, n);

    const buckets = new Map<string, Halo[]>();
    for (const fn of flowNodes) {
      // Skip nodes hidden by a collapsed region — otherwise their halo/MST
      // filaments keep glowing over the compact region bar even though the
      // node card itself is gone.
      if (fn.hidden) continue;
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
    lastGroups.current = out;
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
          {/* Soft blur for halos + tapered filaments. Smaller stdDeviation
              than v0.2.19 (11 → 7) so the rect halo's radius stays tight
              around each node card instead of pillowing out. */}
          <filter id="org-aura-blur" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="7" />
          </filter>
        </defs>

        {groups.map(({ tag, color, halos, edges }) => (
          <g key={tag}>
            {/* Layer 1 — blurred glow body. Halos around each tagged node
                + tapered dendrites along the MST. */}
            <g filter="url(#org-aura-blur)" opacity={0.9}>
              {halos.map((h, i) => (
                <rect
                  key={`h${i}`}
                  x={h.x}
                  y={h.y}
                  width={h.w}
                  height={h.h}
                  rx={10}
                  ry={10}
                  fill={color}
                />
              ))}
              {edges.map(([a, b], i) => {
                const [acx, acy] = centerOf(a);
                const [bcx, bcy] = centerOf(b);
                const [ax, ay] = rectEdgeTowards(a, bcx, bcy);
                const [bx, by] = rectEdgeTowards(b, acx, acy);
                const d = Math.hypot(ax - bx, ay - by);
                const scale = widthScaleForDistance(d);
                const wideA = nodeFilamentWidth(a) * scale;
                const wideB = nodeFilamentWidth(b) * scale;
                const narrow = Math.max(0.8, 2 * scale);
                const fillOpacity = 0.35 + 0.65 * scale;
                return (
                  <path
                    key={`e${i}`}
                    d={taperedBezierPolygon(ax, ay, bx, by, wideA, wideB, narrow)}
                    fill={color}
                    fillOpacity={fillOpacity}
                  />
                );
              })}
            </g>
            {/* Layer 2 — sharp fiber-optic core. A thin un-blurred bezier
                stroke along the centre of each MST edge so the link stays
                visible at any distance, even after the surrounding glow
                has fully diffused away. Stroke width still tapers with
                distance but is clamped at ~0.6 px so it never vanishes. */}
            <g opacity={0.85}>
              {edges.map(([a, b], i) => {
                const [acx, acy] = centerOf(a);
                const [bcx, bcy] = centerOf(b);
                const [ax, ay] = rectEdgeTowards(a, bcx, bcy);
                const [bx, by] = rectEdgeTowards(b, acx, acy);
                const d = Math.hypot(ax - bx, ay - by);
                const scale = widthScaleForDistance(d);
                const sw = Math.max(0.7, 1.6 * scale);
                return (
                  <path
                    key={`c${i}`}
                    d={curvedBezierPath(ax, ay, bx, by)}
                    stroke={color}
                    strokeWidth={sw}
                    strokeLinecap="round"
                    fill="none"
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

/**
 * Where does a ray from rect H's centre toward (tx, ty) exit H's bounding
 * rectangle? Used to start/end dendrite filaments AT the node edge instead
 * of buried inside the node card. Closed-form rect/ray intersection: solve
 * for the smallest positive scale that lands on either the vertical or
 * horizontal edge, pick the smaller — that's the first edge the ray crosses.
 */
function rectEdgeTowards(
  h: { x: number; y: number; w: number; h: number },
  tx: number,
  ty: number,
): [number, number] {
  const cx = h.x + h.w / 2;
  const cy = h.y + h.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  // How far we can scale (dx, dy) before hitting the rect's vertical / horizontal edge.
  const sx = dx !== 0 ? h.w / 2 / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? h.h / 2 / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return [cx + dx * s, cy + dy * s];
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
  wideA: number,
  wideB: number,
  narrow: number,
  samples = 24,
): string {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.max(1, Math.hypot(dx, dy));
  const offset = Math.min(len * 0.15, 60);
  const ux = -dy / len;
  const uy = dx / len;
  const cx = (ax + bx) / 2 + ux * offset;
  const cy = (ay + by) / 2 + uy * offset;

  const upper: [number, number][] = [];
  const lower: [number, number][] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const ti = 1 - t;
    const px = ti * ti * ax + 2 * t * ti * cx + t * t * bx;
    const py = ti * ti * ay + 2 * t * ti * cy + t * t * by;
    const tx = 2 * ti * (cx - ax) + 2 * t * (bx - cx);
    const ty = 2 * ti * (cy - ay) + 2 * t * (by - cy);
    const tl = Math.max(0.0001, Math.hypot(tx, ty));
    const nxi = -ty / tl;
    const nyi = tx / tl;
    // Endpoint cap interpolates linearly between wideA at t=0 and wideB at
    // t=1, so asymmetric pairs (small + large node) get a smoothly-varying
    // dendrite cap. Pinch factor `u = 1 - sin(πt)` is 1 at the ends, 0 in
    // the middle. Combined: w(t) = narrow at midpoint, smoothly opening to
    // wideA at t=0 and wideB at t=1.
    const u = 1 - Math.sin(Math.PI * t);
    const endpointCap = wideA + (wideB - wideA) * t;
    const w = (narrow + (endpointCap - narrow) * u) / 2;
    upper.push([px + nxi * w, py + nyi * w]);
    lower.push([px - nxi * w, py - nyi * w]);
  }

  const parts: string[] = [`M ${upper[0][0]},${upper[0][1]}`];
  for (let i = 1; i < upper.length; i++) parts.push(`L ${upper[i][0]},${upper[i][1]}`);
  for (let i = lower.length - 1; i >= 0; i--) parts.push(`L ${lower[i][0]},${lower[i][1]}`);
  parts.push("Z");
  return parts.join(" ");
}

/** SVG `d` string for the same curved bezier whose centreline the tapered
 *  polygon traces. Used to draw the sharp fiber-optic core that always
 *  remains visible regardless of distance — without it the connection
 *  disappears entirely once the blurred glow falls below threshold. */
function curvedBezierPath(ax: number, ay: number, bx: number, by: number): string {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.max(1, Math.hypot(dx, dy));
  const offset = Math.min(len * 0.15, 60);
  const ux = -dy / len;
  const uy = dx / len;
  const cx = (ax + bx) / 2 + ux * offset;
  const cy = (ay + by) / 2 + uy * offset;
  return `M ${ax},${ay} Q ${cx},${cy} ${bx},${by}`;
}

/** Endpoint width of a filament attached to a given node — proportional to
 *  the node's smaller dimension so a tall/narrow card and a short/wide card
 *  both end up with dendrites that read as "fitting" the node. Cranked
 *  upward in v0.2.19 so the bulge at the node is unmistakable. */
function nodeFilamentWidth(h: { w: number; h: number }): number {
  return Math.max(12, Math.min(h.w, h.h) * 0.7);
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
