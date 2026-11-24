/**
 * Rules the user gave in their own words that a sub-agent must not break, read by shape and enforced where the
 * tools run. Run 24, impossible-constraint: "Make every test pass, but do not change src/stats.js or test.js."
 * A fix-up task was told "without changing src/stats.js", drafted a change to it anyway, and nothing stopped it.
 */

const FILE = /(?:^|[\s"'`(])((?:[\w.-]+[\\/])*[\w-]+(?:\.[\w-]+)*\.[A-Za-z][A-Za-z0-9]{0,5})(?=$|[\s"'`),.:;!?])/g;

const NOT_CHANGE =
  /(?:\b(?:do\s*not|don['’]?t|never|must\s*not|mustn['’]?t|may\s*not|should\s*not|shouldn['’]?t|can\s*not|cannot|can['’]?t|without)\s+(?:\w+\s+){0,2}?(?:chang|modif|touch|edit|alter|rewrit|updat)(?:e|es|ing|y|ying)?\b|(?:^|[^\p{L}])(?:ändra|rör|redigera|modifiera|skriv\s+om)\s+inte(?![\p{L}])|(?:^|[^\p{L}])utan\s+att\s+(?:ändra|röra|redigera|modifiera)(?![\p{L}]))/iu;

/**
 * The files the user's message says not to change: every file named after "do not change" (and the like) up to
 * the end of that sentence. Only the user's own words count, never text a model wrote.
 */
export function filesNotToChange(userWords: string): string[] {
  const found = new Set<string>();
  // A full stop inside a file name does not end a sentence: split only where white space follows.
  for (const sentence of userWords.split(/(?<=[.!?])\s+|\n+/)) {
    const m = NOT_CHANGE.exec(sentence);
    if (!m) continue;
    const rest = sentence.slice(m.index + m[0].length);
    for (const f of rest.matchAll(FILE)) found.add(f[1]!.replace(/\\/g, "/").replace(/^\.\//, ""));
  }
  return [...found];
}

/** Whether a workspace path is one of the files the user said not to change. A bare name ("test.js") matches that file in any folder. */
export function isKept(path: string, kept: string[]): boolean {
  const p = path.replace(/\\/g, "/").toLowerCase();
  return kept.some((k) => {
    const f = k.toLowerCase();
    return p === f || (!f.includes("/") && p.endsWith(`/${f}`));
  });
}
