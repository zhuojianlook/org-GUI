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
            {/* MST filaments, ALWAYS visible. Stroke width shrinks with
                distance (inverse decay) so far edges read as ghostly
                whispers and close edges as confident links. */}
            <g filter="url(#org-aura-line)" opacity={0.9}>
              {edges.map(([a, b], i) => {
                const [ax, ay] = centerOf(a);
                const [bx, by] = centerOf(b);
                const d = Math.hypot(ax - bx, ay - by);
                const sw = strokeWidthForDistance(d);
                return (
                  <path
                    key={i}
                    d={curvedPath(ax, ay, bx, by)}
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

/** Inverse-quadratic decay: very close pairs ~6 px, distant pairs trail off
 *  to a hair-thin ~0.4 px line. Always positive so the edge is never
 *  invisible — matches the user's "always present, just thinner". */
function strokeWidthForDistance(d: number): number {
  return Math.max(0.4, 7 / (1 + d / 110));
}

/** Quadratic bezier between (ax,ay) and (bx,by) with a perpendicular offset
 *  for organic curvature. */
function curvedPath(ax: number, ay: number, bx: number, by: number): string {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.max(1, Math.hypot(dx, dy));
  const offset = Math.min(len * 0.15, 60);
  const px = -dy / len;
  const py = dx / len;
  const mx = (ax + bx) / 2 + px * offset;
  const my = (ay + by) / 2 + py * offset;
  return `M ${ax},${ay} Q ${mx},${my} ${bx},${by}`;
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
