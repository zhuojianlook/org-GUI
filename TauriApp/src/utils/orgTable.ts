// Parsing / serializing org-mode tables for the inline TableEditor.
//
// An org table is a contiguous block of lines starting with `|`. A "separator"
// row matches `|---+---|` (any combo of `-`, `+`, `|`). When a separator
// appears after exactly one data row, that first row is treated as a header.

const TABLE_LINE = /^\s*\|/;
const TABLE_SEP_LINE = /^\s*\|[-+|\s]+\|\s*$/;

export interface TableBlock {
  /** 0-based line index where the table starts within the body. */
  startLine: number;
  /** Exclusive: line index where the table ends. */
  endLine: number;
  /** Data rows only — separator lines are stripped during parsing. */
  rows: string[][];
  /** True when the first row was followed by a separator (header style). */
  hasHeader: boolean;
}

function parseRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** Find every contiguous table block in BODY, in document order. */
export function findTableBlocks(body: string | null | undefined): TableBlock[] {
  if (!body) return [];
  const lines = body.split("\n");
  const blocks: TableBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (TABLE_LINE.test(lines[i])) {
      const startLine = i;
      const rows: string[][] = [];
      let dataRowsBefore = 0;
      let hasHeader = false;
      while (i < lines.length && TABLE_LINE.test(lines[i])) {
        if (TABLE_SEP_LINE.test(lines[i])) {
          // First separator that follows exactly one data row → header.
          if (dataRowsBefore === 1 && !hasHeader) hasHeader = true;
        } else {
          rows.push(parseRow(lines[i]));
          dataRowsBefore++;
        }
        i++;
      }
      if (rows.length > 0) blocks.push({ startLine, endLine: i, rows, hasHeader });
    } else {
      i++;
    }
  }
  return blocks;
}

/**
 * Render ROWS as an org-mode table string. Pads cells to the widest value in
 * each column so the raw text is readable; Emacs will re-align it on first TAB
 * inside the table anyway, so we don't worry about strict org formatting.
 */
export function serializeTable(rows: string[][], hasHeader: boolean): string {
  if (rows.length === 0) return "";
  const colCount = Math.max(...rows.map((r) => r.length), 1);
  const widths: number[] = Array(colCount).fill(3);
  for (const row of rows) {
    for (let c = 0; c < colCount; c++) {
      const cell = row[c] ?? "";
      if (cell.length > widths[c]) widths[c] = cell.length;
    }
  }
  const out: string[] = [];
  rows.forEach((row, idx) => {
    const padded = Array(colCount)
      .fill(0)
      .map((_, c) => (row[c] ?? "").padEnd(widths[c]));
    out.push("| " + padded.join(" | ") + " |");
    if (idx === 0 && hasHeader) {
      out.push("|" + widths.map((w) => "-".repeat(w + 2)).join("+") + "|");
    }
  });
  return out.join("\n");
}

/** Replace BLOCK's lines in BODY with NEW_TABLE_TEXT. Returns the new body string. */
export function replaceTableInBody(
  body: string,
  block: TableBlock,
  newTableText: string,
): string {
  const lines = body.split("\n");
  const newLines = newTableText.split("\n");
  return [...lines.slice(0, block.startLine), ...newLines, ...lines.slice(block.endLine)].join("\n");
}

/** Insert/remove a row at INDEX (0-based among data rows). */
export function withRowInserted(rows: string[][], index: number, fill = ""): string[][] {
  const colCount = Math.max(...rows.map((r) => r.length), 1);
  const newRow = Array(colCount).fill(fill);
  return [...rows.slice(0, index), newRow, ...rows.slice(index)];
}

export function withRowRemoved(rows: string[][], index: number): string[][] {
  if (rows.length <= 1) return rows; // never leave zero rows
  return [...rows.slice(0, index), ...rows.slice(index + 1)];
}

export function withColumnInserted(rows: string[][], index: number, fill = ""): string[][] {
  return rows.map((r) => [...r.slice(0, index), fill, ...r.slice(index)]);
}

export function withColumnRemoved(rows: string[][], index: number): string[][] {
  const colCount = Math.max(...rows.map((r) => r.length), 1);
  if (colCount <= 1) return rows; // never leave zero columns
  return rows.map((r) => [...r.slice(0, index), ...r.slice(index + 1)]);
}

export function withCellEdited(
  rows: string[][],
  ri: number,
  ci: number,
  value: string,
): string[][] {
  return rows.map((r, i) =>
    i === ri ? r.map((c, j) => (j === ci ? value : c)) : r,
  );
}
