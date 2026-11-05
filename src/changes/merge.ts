/**
 * A three-way line merge, so two drafts of one file (or a draft and a newer
 * file on disk) can be combined without losing either side. Without git this
 * replaces a merge: changes to different parts of the file are combined, and
 * changes to the same or neighbouring lines are a conflict for the user.
 */

export interface MergeResult {
  /** True when every change could be combined. */
  clean: boolean;
  /** The combined text. When not clean, conflicting parts carry git-style markers. */
  text: string;
  /** How many places conflict. */
  conflicts: number;
}

/** A change one side made: base lines [start, end) became `lines`. */
interface Hunk {
  start: number;
  end: number;
  lines: string[];
  side: "a" | "b";
}

/** Above this many line pairs left after trimming, the middle is treated as one change instead of being diffed. */
const MAX_CELLS = 4_000_000;

/** Index pairs [baseLine, otherLine] of the lines the two texts share, in order (a longest common subsequence). */
function matches(base: string[], other: string[]): [number, number][] {
  let start = 0;
  while (start < base.length && start < other.length && base[start] === other[start]) start++;
  let endB = base.length;
  let endO = other.length;
  while (endB > start && endO > start && base[endB - 1] === other[endO - 1]) {
    endB--;
    endO--;
  }
  const pairs: [number, number][] = [];
  for (let i = 0; i < start; i++) pairs.push([i, i]);
  const n = endB - start;
  const m = endO - start;
  if (n > 0 && m > 0 && n * m <= MAX_CELLS) {
    // Lines become numbers first, so the table compares integers.
    const ids = new Map<string, number>();
    const id = (s: string) => {
      let v = ids.get(s);
      if (v === undefined) ids.set(s, (v = ids.size));
      return v;
    };
    const a = base.slice(start, endB).map(id);
    const b = other.slice(start, endO).map(id);
    // table[i][j] = length of the common subsequence of a[i..] and b[j..].
    const w = m + 1;
    const table = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * w + j] = a[i] === b[j] ? table[(i + 1) * w + j + 1]! + 1 : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        pairs.push([start + i, start + j]);
        i++;
        j++;
      } else if (table[(i + 1) * w + j]! >= table[i * w + j + 1]!) i++;
      else j++;
    }
  }
  for (let k = 0; k < base.length - endB; k++) pairs.push([endB + k, endO + k]);
  return pairs;
}

/** The changes that turn `base` into `other`. */
function hunks(base: string[], other: string[], side: "a" | "b"): Hunk[] {
  const out: Hunk[] = [];
  let bi = 0;
  let oi = 0;
  for (const [mb, mo] of [...matches(base, other), [base.length, other.length] as [number, number]]) {
    if (mb > bi || mo > oi) out.push({ start: bi, end: mb, lines: other.slice(oi, mo), side });
    bi = mb + 1;
    oi = mo + 1;
  }
  return out;
}

/** One side's version of base lines [lo, hi), given its changes inside that range. */
function applyIn(base: string[], lo: number, hi: number, changes: Hunk[]): string[] {
  const out: string[] = [];
  let at = lo;
  for (const h of changes) {
    out.push(...base.slice(at, h.start), ...h.lines);
    at = h.end;
  }
  out.push(...base.slice(at, hi));
  return out;
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((l, i) => l === b[i]);
}

/** Keeps a label on one line, so it cannot break the marker. */
function markerLabel(label: string): string {
  return label.replace(/[\r\n]+/g, " ").trim().slice(0, 80);
}

/**
 * Combines `a` and `b`, two edits of `base`. Changes to separate parts of the
 * file are both kept. Changes that touch the same or adjacent lines are kept
 * too, between `<<<<<<<`, `=======` and `>>>>>>>` lines (the markers VS Code
 * shows Accept Current / Accept Incoming buttons for), with `a` first.
 */
export function merge3(base: string, a: string, b: string, labels: { a: string; b: string } = { a: "current", b: "incoming" }): MergeResult {
  if (a === b) return { clean: true, text: a, conflicts: 0 };
  if (a === base) return { clean: true, text: b, conflicts: 0 };
  if (b === base) return { clean: true, text: a, conflicts: 0 };
  const baseLines = base.split("\n");
  const all = [...hunks(baseLines, a.split("\n"), "a"), ...hunks(baseLines, b.split("\n"), "b")].sort((x, y) => x.start - y.start || x.end - y.end);
  const out: string[] = [];
  let at = 0;
  let conflicts = 0;
  for (let i = 0; i < all.length; ) {
    // A group is every change that touches or overlaps the ones before it. Touching counts, like in git:
    // a change right next to another one may depend on it.
    const group = [all[i]!];
    const lo = all[i]!.start;
    let hi = all[i]!.end;
    for (i++; i < all.length && all[i]!.start <= hi; i++) {
      group.push(all[i]!);
      hi = Math.max(hi, all[i]!.end);
    }
    out.push(...baseLines.slice(at, lo));
    at = hi;
    const fromA = group.filter((h) => h.side === "a");
    const fromB = group.filter((h) => h.side === "b");
    const textA = applyIn(baseLines, lo, hi, fromA);
    const textB = applyIn(baseLines, lo, hi, fromB);
    if (fromB.length === 0) out.push(...textA);
    else if (fromA.length === 0) out.push(...textB);
    else if (sameLines(textA, textB)) out.push(...textA);
    else {
      conflicts++;
      out.push(`<<<<<<< ${markerLabel(labels.a)}`, ...textA, "=======", ...textB, `>>>>>>> ${markerLabel(labels.b)}`);
    }
  }
  out.push(...baseLines.slice(at));
  return { clean: conflicts === 0, text: out.join("\n"), conflicts };
}

/** True if the text still has a conflict block from {@link merge3}. */
export function hasConflictMarkers(text: string): boolean {
  return /^<<<<<<< .*$[\s\S]*?^=======$[\s\S]*?^>>>>>>> /m.test(text);
}
