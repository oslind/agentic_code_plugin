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

const ONLY_CHANGE =
  /(?:\b(?:only|just)\s+(?:\w+\s+)?(?:chang|modif|touch|edit|alter|updat)(?:e|es|ing|y|ying)?\b|\b(?:chang|modif|touch|edit|alter|updat)(?:e|es|ing|y|ying)?\s+(?:only|nothing\s+(?:but|except|other\s+than|outside(?:\s+of)?))(?!\w)|(?:^|[^\p{L}])(?:ändra|rör|redigera)\s+(?:bara|endast|enbart)(?![\p{L}])|(?:^|[^\p{L}])(?:bara|endast|enbart)\s+(?:ändra|röra|redigera)(?![\p{L}]))/iu;

/**
 * The only files the user's message allows to be changed ("Only change src/a.js", "change nothing but test.js"):
 * the files named after those words up to the end of the sentence. Empty when the message sets no such limit, or
 * names no file with it.
 */
export function onlyFilesToChange(userWords: string): string[] {
  const found = new Set<string>();
  for (const sentence of userWords.split(/(?<=[.!?])\s+|\n+/)) {
    const m = ONLY_CHANGE.exec(sentence);
    if (!m) continue;
    for (const f of sentence.slice(m.index + m[0].length).matchAll(FILE)) found.add(f[1]!.replace(/\\/g, "/").replace(/^\.\//, ""));
  }
  return [...found];
}

const NO_NEW_PACKAGES =
  /(?:\b(?:do\s*not|don['’]?t|never|without|no)\s+(?:\w+\s+){0,2}?(?:add(?:ing)?|install(?:ing)?|introduc(?:e|ing)|new|extra|additional|third[- ]party)\s+(?:\w+\s+){0,2}?(?:dependenc(?:y|ies)|packages?|librar(?:y|ies))\b|(?:^|[^\p{L}])(?:inga|inte)\s+(?:[\p{L}]+\s+){0,3}?(?:beroenden|paket|bibliotek)(?![\p{L}]))/iu;

/** Whether the user's message rules out new dependencies ("don't add dependencies", "no new packages"). */
export function forbidsNewPackages(userWords: string): boolean {
  return NO_NEW_PACKAGES.test(userWords);
}

/**
 * Whether a command line adds a package to the project (npm install NAME, pip install NAME, cargo add …).
 * Installing what the project already lists (npm install, npm ci, pip install -r requirements.txt) does not count.
 */
export function addsPackage(command: string): boolean {
  return command.split(/&&|\|\||[;|\n]/).some((part) => {
    const words = part.trim().split(/\s+/).filter((w) => w && !/^\w+=/.test(w));
    while (words[0] === "sudo" || words[0] === "npx" || words[0] === "env") words.shift();
    if (words[0] && /^python[\d.]*$/.test(words[0]) && words[1] === "-m") words.splice(0, 2);
    const [tool, verb, ...rest] = words.map((w) => w.toLowerCase());
    if (!tool || !verb) return false;
    const names = rest.filter((w) => !w.startsWith("-"));
    if (tool === "npm" || tool === "pnpm" || tool === "bun") return (["i", "install", "add"].includes(verb) && names.length > 0) || (tool !== "npm" && verb === "add");
    if (tool === "yarn") return verb === "add";
    if (/^pip[\d.]*$/.test(tool) || tool === "uv") {
      const args = tool === "uv" && verb === "pip" ? rest.slice(1) : rest;
      if (tool === "uv" && verb === "add") return true;
      if (verb !== "install" && !(tool === "uv" && verb === "pip" && rest[0] === "install")) return false;
      // "-r file" and "-e ." install what the project lists.
      const own = args.filter((w, i) => !w.startsWith("-") && !["-r", "--requirement", "-e", "--editable", "-c", "--constraint"].includes(args[i - 1] ?? ""));
      return own.length > 0;
    }
    if (tool === "cargo" || tool === "poetry" || tool === "dotnet") return verb === "add";
    if (tool === "go") return verb === "get";
    if (tool === "gem") return verb === "install" && names.length > 0;
    if (tool === "composer") return verb === "require";
    return false;
  });
}

/** The rules read from the user's own message that the tools enforce for every sub-agent of the run. */
export interface UserRules {
  keep: string[];
  only: string[];
  noNewPackages: boolean;
}

export function userRulesOf(userWords: string): UserRules {
  return { keep: filesNotToChange(userWords), only: onlyFilesToChange(userWords), noNewPackages: forbidsNewPackages(userWords) };
}
