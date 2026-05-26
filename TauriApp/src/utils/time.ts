export function parseOrgDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  // Accept "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM"
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  return new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    hh ? Number(hh) : 0,
    mm ? Number(mm) : 0,
  );
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

const MS_PER_DAY = 86_400_000;

/** Fractional day difference (b - a). */
export function dayDiff(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / MS_PER_DAY;
}

export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

export function firstOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function monthLabel(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Today as a local "YYYY-MM-DD" string. */
export function todayStr(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function fmtDate(s: string | null): string {
  const d = parseOrgDate(s);
  if (!d) return "";
  const hasTime = !!s && s.includes("T");
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  if (!hasTime) return base;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${base} ${hh}:${mm}`;
}
