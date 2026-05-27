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
