import { keymap, EditorView } from "@codemirror/view";
import { EditorSelection, Prec } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";

// ── Org subtree motions (operate on the editor text) ───────────────────────

function headingLevel(text: string): number | null {
  const m = text.match(/^(\*+)\s/);
  return m ? m[1].length : null;
}

/** The line range (1-based, inclusive) of the subtree containing the cursor. */
function subtreeAt(view: EditorView): { h: number; end: number; lvl: number } | null {
  const { doc } = view.state;
  const cur = doc.lineAt(view.state.selection.main.head);
  let h = cur.number;
  while (h >= 1 && headingLevel(doc.line(h).text) === null) h--;
  if (h < 1) return null;
  const lvl = headingLevel(doc.line(h).text)!;
  let end = h + 1;
  while (end <= doc.lines) {
    const l = headingLevel(doc.line(end).text);
    if (l !== null && l <= lvl) break;
    end++;
  }
  return { h, end: end - 1, lvl };
}

function moveSubtreeUp(view: EditorView): boolean {
  const st = subtreeAt(view);
  if (!st) return false;
  const { doc } = view.state;
  const { h, end, lvl } = st;
  let p = h - 1;
  while (p >= 1) {
    const l = headingLevel(doc.line(p).text);
    if (l !== null) {
      if (l < lvl) return false;
      if (l === lvl) break;
    }
    p--;
  }
  if (p < 1) return false;
  const prevStart = doc.line(p).from;
  const prevEnd = doc.line(h - 1).to;
  const ourStart = doc.line(h).from;
  const ourEnd = doc.line(end).to;
  const sep = doc.sliceString(prevEnd, ourStart);
  const ourText = doc.sliceString(ourStart, ourEnd);
  const prevText = doc.sliceString(prevStart, prevEnd);
  view.dispatch({
    changes: { from: prevStart, to: ourEnd, insert: ourText + sep + prevText },
    selection: EditorSelection.cursor(prevStart),
  });
  return true;
}

function moveSubtreeDown(view: EditorView): boolean {
  const st = subtreeAt(view);
  if (!st) return false;
  const { doc } = view.state;
  const { h, end, lvl } = st;
  const n = end + 1;
  if (n > doc.lines) return false;
  const nl = headingLevel(doc.line(n).text);
  if (nl === null || nl < lvl) return false;
  let nend = n + 1;
  while (nend <= doc.lines) {
    const l = headingLevel(doc.line(nend).text);
    if (l !== null && l <= lvl) break;
    nend++;
  }
  nend--;
  const ourStart = doc.line(h).from;
  const ourEnd = doc.line(end).to;
  const nextStart = doc.line(n).from;
  const nextEnd = doc.line(nend).to;
  const sep = doc.sliceString(ourEnd, nextStart);
  const ourText = doc.sliceString(ourStart, ourEnd);
  const nextText = doc.sliceString(nextStart, nextEnd);
  view.dispatch({
    changes: { from: ourStart, to: nextEnd, insert: nextText + sep + ourText },
    selection: EditorSelection.cursor(ourStart + nextText.length + sep.length),
  });
  return true;
}

function shiftSubtree(view: EditorView, delta: number): boolean {
  const st = subtreeAt(view);
  if (!st) return false;
  const { doc } = view.state;
  const changes: { from: number; to?: number; insert?: string }[] = [];
  for (let i = st.h; i <= st.end; i++) {
    const line = doc.line(i);
    const m = line.text.match(/^(\*+)(\s)/);
    if (!m) continue;
    if (delta > 0) changes.push({ from: line.from, insert: "*" });
    else if (m[1].length > 1) changes.push({ from: line.from, to: line.from + 1 });
    else return false; // can't promote a level-1 heading
  }
  if (changes.length) view.dispatch({ changes });
  return true;
}

/** Org structural keybindings, highest precedence so they beat Vim. */
export const orgMotionKeymap = Prec.highest(
  keymap.of([
    { key: "Alt-ArrowUp", run: moveSubtreeUp, preventDefault: true },
    { key: "Alt-ArrowDown", run: moveSubtreeDown, preventDefault: true },
    { key: "Alt-Shift-ArrowRight", run: (v) => shiftSubtree(v, 1), preventDefault: true },
    { key: "Alt-Shift-ArrowLeft", run: (v) => shiftSubtree(v, -1), preventDefault: true },
  ]),
);

// ── Minimal org syntax highlighting ────────────────────────────────────────

const TODO_RE = /^(TODO|NEXT|STRT|WAIT|HOLD|PROJ|LOOP|IDEA)\b/;
const DONE_RE = /^(DONE|KILL)\b/;

export const orgLanguage = StreamLanguage.define<{ heading: boolean }>({
  startState: () => ({ heading: false }),
  token(stream, state) {
    if (stream.sol()) {
      state.heading = false;
      if (stream.match(/^\*+\s+/)) {
        state.heading = true;
        return "heading";
      }
      if (stream.match(/^\s*(SCHEDULED|DEADLINE|CLOSED):/)) return "keyword";
      if (stream.match(/^\s*:[A-Za-z0-9_]+:.*$/)) return "meta";
    }
    if (state.heading) {
      if (stream.match(TODO_RE)) return "keyword";
      if (stream.match(DONE_RE)) return "string";
      if (stream.match(/\[#[A-Za-z0-9]\]/)) return "atom";
      if (stream.match(/:[A-Za-z0-9_@#%:]+:\s*$/)) return "meta";
    }
    if (stream.match(/<\d{4}-\d{2}-\d{2}[^>]*>|\[\d{4}-\d{2}-\d{2}[^\]]*\]/)) return "number";
    stream.next();
    return null;
  },
});
