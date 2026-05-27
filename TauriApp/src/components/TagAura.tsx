import { useMemo } from "react";
import { ViewportPortal, useStore } from "@xyflow/react";
import { useOrgStore } from "../store/useOrgStore";

/**
 * Ephemeral "neuron" overlay that links tagged nodes with glowing colored
 * filaments. For each coloured tag we:
 *   1. Collect the centre point of every tagged-and-visible node.
 *   2. Build a minimum spanning tree (Prim's, O(n²) — tagged-node counts are
 *      tiny) over those centres so we draw N-1 strokes instead of all pairs,
 *      avoiding visual clutter.
 *   3. Render each MST edge as a perpendicular-offset quadratic bezier so the
 *      filaments curve organically instead of running straight lines through
 *      the canvas.
 *   4. Drop a small "soma" dot at each tagged node centre.
 *   5. Pump the whole tag group through a multi-stage Gaussian-blur+feMerge
 *      filter — true additive glow, not the alpha-threshold blobs that the
 *      previous goo filter produced.
 *
 * Respects the same global toggle and filter-override semantics as before:
 * OFF + no filter → render nothing; OFF + filter set → only the filtered
 * tag's filaments draw; ON → every coloured tag glows.
 */
export default function TagAura() {
  const tagColors = useOrgStore((s) => s.tagColors);
  const tagFilter = useOrgStore((s) => s.tagFilter);
  const tagAuraEnabled = useOrgStore((s) => s.tagAuraEnabled);
  const doc = useOrgStore((s) => s.doc);
  const flowNodes = useStore((s) => s.nodes);

  const groups = useMemo(() => {
    if (!doc) return [] as { tag: string; color: string; centers: [number, number][]; edges: [[number, number], [number, number]][] }[];
    if (!tagAuraEnabled && tagFilter == null) return [];

    const nodeById = new Map<string, typeof doc.nodes[number]>();
    for (const n of doc.nodes) nodeById.set(n.id, n);

    const buckets = new Map<string, [number, number][]>();
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
        const arr = buckets.get(t) ?? [];
        arr.push([cx, cy]);
        buckets.set(t, arr);
      }
    }

    const out = [];
    for (const [tag, centers] of buckets) {
      out.push({
        tag,
        color: tagColors[tag],
        centers,
        edges: minimumSpanningTreeEdges(centers),
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
        }}
        width="1"
        height="1"
      >
        <defs>
          {/* Luminous glow: two blur scales merged with the sharp source on top.
              The wider blur is the soft halo, the narrower blur is the core
              glow, and the original strokes sit crisp at the centre. */}
          <filter id="org-neuron-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="g1" />
            <feGaussianBlur in="SourceGraphic" stdDeviation="9" result="g2" />
            <feMerge>
              <feMergeNode in="g2" />
              <feMergeNode in="g1" />
              <feMergeNode in="g1" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {groups.map(({ tag, color, centers, edges }) => (
          <g key={tag} filter="url(#org-neuron-glow)">
            {/* Filaments — thin curved strokes along the MST. */}
            {edges.map(([a, b], i) => (
              <path
                key={i}
                d={curvedPath(a, b)}
                stroke={color}
                strokeWidth={1.6}
                strokeLinecap="round"
                fill="none"
                opacity={0.85}
              />
            ))}
            {/* Somata — a small glowing dot at every tagged node's centre. */}
            {centers.map(([x, y], i) => (
              <circle key={`s${i}`} cx={x} cy={y} r={4} fill={color} opacity={0.95} />
            ))}
          </g>
        ))}
      </svg>
    </ViewportPortal>
  );
}

/** Quadratic bezier between A and B with a small perpendicular offset so the
 *  filament reads as a curve, not a straight line. Offset is proportional to
 *  the segment length, capped so very long links don't fly off the canvas. */
function curvedPath(a: [number, number], b: [number, number]): string {
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.max(1, Math.hypot(dx, dy));
  const offset = Math.min(len * 0.18, 60);
  // Rotate (dx,dy)/len by 90° to get the perpendicular unit vector.
  const px = -dy / len;
  const py = dx / len;
  const mx = (ax + bx) / 2 + px * offset;
  const my = (ay + by) / 2 + py * offset;
  return `M ${ax},${ay} Q ${mx},${my} ${bx},${by}`;
}

/** Prim's MST over a list of points. Returns the N-1 edges connecting them as
 *  pairs of original point coordinates. O(n²) — fine for the tens of nodes
 *  any single tag will ever realistically span. */
function minimumSpanningTreeEdges(
  points: [number, number][],
): [[number, number], [number, number]][] {
  const n = points.length;
  if (n < 2) return [];
  const inTree = new Array(n).fill(false);
  const fromIdx = new Array(n).fill(-1);
  const cost = new Array(n).fill(Infinity);
  inTree[0] = true;
  cost[0] = 0;
  for (let j = 1; j < n; j++) {
    cost[j] = dist(points[0], points[j]);
    fromIdx[j] = 0;
  }
  const edges: [[number, number], [number, number]][] = [];
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
    edges.push([points[fromIdx[best]], points[best]]);
    for (let j = 0; j < n; j++) {
      if (!inTree[j]) {
        const c = dist(points[best], points[j]);
        if (c < cost[j]) {
          cost[j] = c;
          fromIdx[j] = best;
        }
      }
    }
  }
  return edges;
}

function dist(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
