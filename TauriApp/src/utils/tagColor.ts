// Helpers for applying user-assigned tag colors to nodes.

/** Parse a "#rrggbb" string into an [r,g,b] tuple. */
function parseHex(hex: string): [number, number, number] | null {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/**
 * Average a list of CSS hex colors into a single `rgb(...)` string. Used to
 * "fuse" multiple tag colors on a node carrying more than one coloured tag.
 * Empty input returns null.
 */
export function blendColors(colors: string[]): string | null {
  const parsed = colors.map(parseHex).filter((p): p is [number, number, number] => p !== null);
  if (parsed.length === 0) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const [pr, pg, pb] of parsed) {
    r += pr;
    g += pg;
    b += pb;
  }
  const n = parsed.length;
  return `rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})`;
}

/**
 * Same as blendColors but returns an `rgba(...)` string with the given alpha.
 */
export function blendColorsRgba(colors: string[], alpha: number): string | null {
  const parsed = colors.map(parseHex).filter((p): p is [number, number, number] => p !== null);
  if (parsed.length === 0) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const [pr, pg, pb] of parsed) {
    r += pr;
    g += pg;
    b += pb;
  }
  const n = parsed.length;
  return `rgba(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)}, ${alpha})`;
}

/** "#rrggbb" + alpha → "rgba(r,g,b,a)". Falls back to the input when it isn't a
 *  plain hex (so an already-rgb/rgba string passes through unchanged). */
export function hexToRgba(hex: string, alpha: number): string {
  const p = parseHex(hex);
  if (!p) return hex;
  return `rgba(${p[0]}, ${p[1]}, ${p[2]}, ${alpha})`;
}

/** Resolve the coloured tags assigned to a node, dropping any without a color. */
export function nodeTagColors(
  tagsAll: string[] | null | undefined,
  tagColors: Record<string, string>,
): string[] {
  if (!tagsAll || tagsAll.length === 0) return [];
  const out: string[] = [];
  for (const t of tagsAll) {
    const c = tagColors[t];
    if (c) out.push(c);
  }
  return out;
}

/**
 * Andrew's monotone-chain convex hull. Returns the input list (de-duped &
 * sorted) when it has ≤2 points; otherwise returns the hull vertices in
 * counter-clockwise order. Used to draw the "river" overlay that visually
 * groups tagged nodes together.
 */
export function convexHull(points: [number, number][]): [number, number][] {
  const ps = [...points]
    .map(([x, y]) => [x, y] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  // De-dup identical coords (they make the cross product degenerate).
  const uniq: [number, number][] = [];
  for (const p of ps) {
    const last = uniq[uniq.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) uniq.push(p);
  }
  if (uniq.length <= 2) return uniq;

  const cross = (
    o: [number, number],
    a: [number, number],
    b: [number, number],
  ) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: [number, number][] = [];
  for (const p of uniq) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    )
      lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    )
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/** SVG path "d" for a closed hull. For 1 or 2 points, produces a tiny segment
 *  so a wide round-capped stroke renders as a circle / capsule. */
export function hullToSvgPath(hull: [number, number][]): string | null {
  if (hull.length === 0) return null;
  if (hull.length === 1) {
    const [x, y] = hull[0];
    // A zero-length subpath with linecap:round draws a circle.
    return `M ${x},${y} L ${x},${y}`;
  }
  const [first, ...rest] = hull;
  const tail = rest.map(([x, y]) => `L ${x},${y}`).join(" ");
  return `M ${first[0]},${first[1]} ${tail}${hull.length >= 3 ? " Z" : ""}`;
}
