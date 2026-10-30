import * as path from "path";
import picomatch from "picomatch";

/**
 * Normalizes a model-supplied path to a POSIX path relative to the workspace.
 * Returns undefined for anything that could escape it.
 */
export function normalizeWorkspacePath(p: string): string | undefined {
  const trimmed = p.trim().replace(/\\/g, "/");
  if (trimmed === "" || path.posix.isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed)) {
    return undefined;
  }
  const normal = path.posix.normalize(trimmed).replace(/^\.\//, "");
  if (normal === "." || normal === ".." || normal.startsWith("../")) {
    return undefined;
  }
  return normal.replace(/\/+$/, "");
}

export function matchesAny(file: string, globs: string[]): boolean {
  return globs.length > 0 && picomatch(globs, { dot: true })(file);
}

/** The literal directory prefix of a glob, up to its first wildcard segment. */
export function staticPrefix(glob: string): string {
  const segments = glob.split("/");
  const fixed: string[] = [];
  for (const s of segments) {
    if (/[*?[\]{}()!]/.test(s)) break;
    fixed.push(s);
  }
  return fixed.join("/");
}

/**
 * Conservative check for whether two sets of globs could match the same file.
 * It may report overlap that is not real, never the other way round.
 */
export function scopesOverlap(a: string[], b: string[]): boolean {
  return a.some((ga) => b.some((gb) => globsOverlap(ga, gb)));
}

function globsOverlap(a: string, b: string): boolean {
  const pa = staticPrefix(a);
  const pb = staticPrefix(b);
  const aLiteral = pa === a;
  const bLiteral = pb === b;
  if (aLiteral && bLiteral) return a === b;
  if (aLiteral) return matchesAny(a, [b]);
  if (bLiteral) return matchesAny(b, [a]);
  // Two wildcards: they can meet if one fixed directory contains the other.
  return pa === "" || pb === "" || pa === pb || pa.startsWith(pb + "/") || pb.startsWith(pa + "/");
}
