/**
 * Benchmark tasks: the same request done by the agentic chat and by one
 * plain conversation, scored by hidden checks the agents never see.
 *
 * A score is the share of a task's checks that pass (partial credit), so
 * "2 of 3 changes work" counts as 0.67. Fixed tasks use the thermostat
 * project; the ladders grow a generated project (more files) or a request
 * (more changes) to find where each approach stops coping.
 */
import { execFile } from "child_process";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { thermostat } from "../projects";

export interface BenchContext {
  /** A project file as it is now, or undefined if it does not exist. */
  read(rel: string): Promise<string | undefined>;
  /** Runs a command in the project folder. */
  sh(command: string, args: string[]): Promise<{ code: number; output: string }>;
  /** What the agent told the user at the end. */
  answer: string;
}

export interface Part {
  name: string;
  ok: boolean;
}

export interface BenchTask {
  name: string;
  group: "fixed" | "edit-ladder" | "research-ladder";
  /** "change" tasks are judged on the files, "question" tasks on the answer. */
  kind: "change" | "question";
  /** Project size in files, and how many separate things the request asks for. */
  size: { files: number; asks: number };
  files: Record<string, string>;
  prompt: string;
  /** Existing files the request may change. Any other changed file is collateral damage. */
  mayChange: string[];
  /** The hidden checks. */
  score(ctx: BenchContext): Promise<Part[]>;
  /** A correct solution, so the unit tests can prove the checks pass on one (and fail on the untouched project). */
  reference?(files: Record<string, string>): Record<string, string>;
}

/** Runs a short Node script in the project and returns the JSON it prints, or undefined. */
async function nodeJson<T>(ctx: BenchContext, script: string): Promise<T | undefined> {
  const r = await ctx.sh("node", ["-e", script]);
  // The last line that is JSON: modules may print warnings of their own.
  for (const line of r.output.trim().split("\n").reverse()) {
    try {
      return JSON.parse(line) as T;
    } catch {
      // not this line
    }
  }
  return undefined;
}

/** Every part fails when the checker itself cannot run (for example, a file no longer loads). */
const failAll = (names: string[]): Part[] => names.map((name) => ({ name, ok: false }));

// ── The thermostat tasks ─────────────────────────────────────────────────────

const thermostatTests = async (ctx: BenchContext): Promise<Part[]> => {
  const r = await ctx.sh("node", ["test.js"]);
  const names = ["default target is 21", "night is 3 lower", "freezing point", "average of two", "average of three"];
  return names.map((name) => ({ name: `test: ${name}`, ok: new RegExp(`^ok\\s+${name}$`, "m").test(r.output) }));
};

const fixedAverage = (files: Record<string, string>) => ({ ...files, "src/stats.js": files["src/stats.js"]!.replace("return sum / 2;", "return sum / readings.length;") });

const FIXED: BenchTask[] = [
  {
    name: "fix-bug",
    group: "fixed",
    kind: "change",
    size: { files: 6, asks: 1 },
    files: thermostat,
    prompt: "Two of the tests in test.js fail. Find the bug and fix it.",
    mayChange: ["src/stats.js"],
    score: thermostatTests,
    reference: fixedAverage,
  },
  {
    name: "three-changes",
    group: "fixed",
    kind: "change",
    size: { files: 6, asks: 3 },
    files: thermostat,
    prompt:
      "Make three changes: add toKelvin(celsius) returning celsius + 273.15 to src/convert.js and export it; add an 'away' mode to targetTemp in src/thermostat.js that returns 16; add median(readings) to src/stats.js and export it.",
    mayChange: ["src/convert.js", "src/thermostat.js", "src/stats.js"],
    score: async (ctx) => {
      const names = ["toKelvin", "away mode", "median", "old behaviour kept"];
      const r = await nodeJson<boolean[]>(
        ctx,
        `const t=(f)=>{try{return !!f()}catch{return false}};const c=()=>require('./src/convert'),h=()=>require('./src/thermostat'),s=()=>require('./src/stats');` +
          `console.log(JSON.stringify([t(()=>c().toKelvin(0)===273.15&&c().toKelvin(10)===283.15),t(()=>h().targetTemp('away')===16),t(()=>s().median([3,1,2])===2&&s().median([4,1,3,2])===2.5),` +
          `t(()=>h().targetTemp()===21&&h().targetTemp('night')===18&&c().toCelsius(32)===0)]))`,
      );
      return r ? names.map((name, i) => ({ name, ok: r[i] === true })) : failAll(names);
    },
    reference: (f) => ({
      ...f,
      "src/convert.js": "function toCelsius(f) {\n  return ((f - 32) * 5) / 9;\n}\n\nfunction toKelvin(c) {\n  return c + 273.15;\n}\n\nmodule.exports = { toCelsius, toKelvin };\n",
      "src/thermostat.js": f["src/thermostat.js"]!.replace("return mode === 'night'", "if (mode === 'away') return 16;\n  return mode === 'night'"),
      "src/stats.js": f["src/stats.js"]!.replace(
        "module.exports = { average };",
        "function median(readings) {\n  const s = [...readings].sort((a, b) => a - b);\n  const m = Math.floor(s.length / 2);\n  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;\n}\n\nmodule.exports = { average, median };",
      ),
    }),
  },
  {
    name: "config-module",
    group: "fixed",
    kind: "change",
    size: { files: 6, asks: 2 },
    files: thermostat,
    prompt:
      "Create src/config.js that exports NIGHT_DROP = 3 and DEFAULT_TARGET = 21, then change src/thermostat.js to import both from ./config instead of hard-coding them. Behaviour must stay the same.",
    mayChange: ["src/thermostat.js"],
    score: async (ctx) => {
      const t = (await ctx.read("src/thermostat.js")) ?? "";
      const cfg = await nodeJson<{ n?: unknown; d?: unknown }>(ctx, "try{const c=require('./src/config');console.log(JSON.stringify({n:c.NIGHT_DROP,d:c.DEFAULT_TARGET}))}catch{console.log('{}')}");
      const tests = await thermostatTests(ctx);
      return [
        { name: "config.js exports both values", ok: cfg?.n === 3 && cfg?.d === 21 },
        { name: "thermostat.js uses ./config", ok: /require\(\s*['"]\.\/config(\.js)?['"]\s*\)/.test(t) && !/=\s*21\b/.test(t) && !/-\s*3\b/.test(t) },
        { name: "behaviour unchanged", ok: tests.slice(0, 3).every((p) => p.ok) },
      ];
    },
    reference: (f) => ({
      ...f,
      "src/config.js": "module.exports = { NIGHT_DROP: 3, DEFAULT_TARGET: 21 };\n",
      "src/thermostat.js":
        "// The heating target. Night mode lowers it.\nconst { NIGHT_DROP, DEFAULT_TARGET } = require('./config');\n\nfunction targetTemp(mode) {\n  return mode === 'night' ? DEFAULT_TARGET - NIGHT_DROP : DEFAULT_TARGET;\n}\n\nmodule.exports = { targetTemp, DEFAULT_TARGET };\n",
    }),
  },
  {
    name: "document-all",
    group: "fixed",
    kind: "change",
    size: { files: 6, asks: 4 },
    files: thermostat,
    prompt: "Add a JSDoc comment (/** ... */) directly above every function in src/thermostat.js, src/convert.js and src/stats.js. Do not change any code.",
    mayChange: ["src/thermostat.js", "src/convert.js", "src/stats.js"],
    score: async (ctx) => {
      const documented = async (file: string, fn: string) => new RegExp(`\\*/\\s*\\n\\s*function ${fn}\\b`).test((await ctx.read(file)) ?? "");
      const tests = await thermostatTests(ctx);
      return [
        { name: "targetTemp documented", ok: await documented("src/thermostat.js", "targetTemp") },
        { name: "toCelsius documented", ok: await documented("src/convert.js", "toCelsius") },
        { name: "average documented", ok: await documented("src/stats.js", "average") },
        // The average bug is still there: "no code changes" means the same 4 of 5 tests pass as before.
        { name: "code unchanged", ok: tests.filter((p) => p.ok).length === 4 && !tests[4]!.ok },
      ];
    },
    reference: (f) => ({
      ...f,
      "src/thermostat.js": f["src/thermostat.js"]!.replace("function targetTemp", "/** Returns the target temperature for a mode. */\nfunction targetTemp"),
      "src/convert.js": f["src/convert.js"]!.replace("function toCelsius", "/** Returns f Fahrenheit in Celsius. */\nfunction toCelsius"),
      "src/stats.js": f["src/stats.js"]!.replace("function average", "/** Returns the average of the readings. */\nfunction average"),
    }),
  },
  {
    name: "explain-bug",
    group: "fixed",
    kind: "question",
    size: { files: 6, asks: 1 },
    files: thermostat,
    prompt: "Some tests fail when I run node test.js. Which file has the bug, and what exactly is wrong? Don't change anything.",
    mayChange: [],
    score: async (ctx) => [
      { name: "names src/stats.js", ok: /stats\.js|\bstats\b/i.test(ctx.answer) },
      { name: "says it divides by 2 instead of the count", ok: /\/\s*2|by 2|by two|length|number of readings|count/i.test(ctx.answer) },
    ],
  },
];

// ── The generated shop project, for the ladders ─────────────────────────────

const CATEGORIES = ["books", "garden", "kitchen", "toys", "tools", "music", "sports", "shoes", "office", "pets", "games", "lamps", "paint", "bikes", "tea", "coffee", "maps", "rugs", "soap", "tents"];

/**
 * How lineTotal treats a negative quantity, per module. The first three throw,
 * the rest do not, and they are worded so a text search alone does not tell
 * them apart: the question must be answered by reading the code.
 */
const GUARDS = [
  { throws: true, code: "  if (qty < 0) throw new RangeError('negative quantity');" },
  { throws: false, code: "  if (qty < 0) return 0;" },
  { throws: true, code: "  if (!(qty >= 0)) throw new Error('bad quantity: ' + qty);" },
  { throws: false, code: "  qty = Math.max(0, qty);" },
  { throws: true, code: "  assertNonNegative(qty);" },
  { throws: false, code: "  if (qty < 0) console.warn('negative quantity', qty);" },
  { throws: false, code: "  // TODO: throw on negative quantities, like the other modules." },
];

const pad = (i: number) => String(i + 1).padStart(3, "0");
export const modulePath = (i: number) => `src/mod_${pad(i)}.js`;
/** Which guard module i uses: a fixed scramble, so throwing modules are spread out. */
export const guardOf = (i: number) => GUARDS[(i * 5 + 2) % GUARDS.length]!;

function moduleText(i: number): string {
  const cat = CATEGORIES[i % CATEGORIES.length]!;
  const guard = guardOf(i);
  const imports = guard.code.includes("assertNonNegative") ? "roundCents, formatPrice, assertNonNegative" : "roundCents, formatPrice";
  return [
    `// Pricing for ${cat} (module ${pad(i)}).`,
    `const { ${imports} } = require('./util');`,
    "",
    `const TAX_RATE = ${(0.05 + ((i * 7) % 20) / 100).toFixed(2)};`,
    "const DEFAULT_CURRENCY = 'EUR';",
    "",
    "/** Total for one line of an order: quantity times unit price, rounded to cents. */",
    "function lineTotal(qty, unit) {",
    guard.code,
    "  return roundCents(qty * unit);",
    "}",
    "",
    "/** A one-line description for receipts. */",
    "function describe(item) {",
    `  const name = String(item.name || '${cat} item').trim();`,
    "  return `${name} (${formatPrice(item.price, DEFAULT_CURRENCY)})`;",
    "}",
    "",
    "/** The price including this category's tax. */",
    "function grossPrice(net) {",
    "  return roundCents(net * (1 + TAX_RATE));",
    "}",
    "",
    "module.exports = { TAX_RATE, DEFAULT_CURRENCY, lineTotal, describe, grossPrice };",
    "",
  ].join("\n");
}

/** A shop with n pricing modules plus util.js, index.js, package.json and a README. */
export function shopProject(n: number): Record<string, string> {
  const files: Record<string, string> = {
    "README.md": `# Shop\n\nPricing rules, one module per product category in src/ (${n} modules).\n`,
    "package.json": JSON.stringify({ name: "shop", version: "1.0.0", private: true }, null, 2) + "\n",
    "src/util.js": [
      "function roundCents(x) {",
      "  return Math.round(x * 100) / 100;",
      "}",
      "",
      "function formatPrice(price, currency) {",
      "  return `${Number(price).toFixed(2)} ${currency}`;",
      "}",
      "",
      "function assertNonNegative(n) {",
      "  if (n < 0) throw new RangeError('negative: ' + n);",
      "}",
      "",
      "module.exports = { roundCents, formatPrice, assertNonNegative };",
      "",
    ].join("\n"),
    "src/index.js": ["const modules = [", ...Array.from({ length: n }, (_, i) => `  require('./mod_${pad(i)}'),`), "];", "", "module.exports = { modules };", ""].join("\n"),
  };
  for (let i = 0; i < n; i++) files[modulePath(i)] = moduleText(i);
  return files;
}

/** The modules whose lineTotal throws on a negative quantity, by the code itself. */
export const throwingModules = (n: number) => Array.from({ length: n }, (_, i) => i).filter((i) => guardOf(i).throws);

/** Module numbers an answer names (mod_007, mod_7, mod_007.js, module 7 ...). */
export function modulesNamed(answer: string): Set<number> {
  const found = new Set<number>();
  for (const m of answer.matchAll(/mod(?:ule)?[_ -]?0*(\d{1,3})\b/gi)) found.add(Number(m[1]) - 1);
  return found;
}

/** Says a module does not throw: "does not throw", "doesn't throw", "never throws", "returns a negative total". */
const SAYS_NO_THROW = /\b(?:does|do|did|will|would|can)\s*(?:not|n't)\s+(?:\w+\s+){0,2}throw|\b(?:doesn't|don't|won't|never)\s+(?:\w+\s+){0,2}throw|\bno (?:error|exception)s?\b|\bwithout throwing\b|\bnon-?throwing\b|\bdo(?:es)? not\s*:|\breturns? (?:a )?negative\b|\bclamps?\b|\bnot found\b|\bcould not (?:be )?(?:read|opened?|found)\b|\bdoes(?: not|n't) exist\b|\bno lineTotal\b|\b(?:still )?unknown\b|\bnot (?:opened|read)\b|\bunclear\b|\blogs? (?:a |an )?(?:warning|error message)\b|\breturns? (?:0|zero|null|undefined|false|NaN)\b|\binstead of throwing\b/i;
/**
 * A heading that starts a list of modules that do not throw ("Not throwing:", "These do not:"), or whose answer is
 * not known ("Still unknown:"): run 13, the 23 "false alarms" of find-throwing-100 were a "Still unknown:" list.
 */
const NO_THROW_HEADING = /^\s*(?:[#*_>-]+\s*)*(?:modules?|files?|these|others?|the rest|remaining)?[^:]{0,40}\b(?:not|n't|never|no|safe|unknown|unclear|unread|unchecked)\b[^:]{0,40}:\s*$/i;

/**
 * The modules an answer says throw. A module named in a line (or list item, or sentence) that says it does not
 * throw, or under a heading for the ones that do not, is not counted. Run bench pass 1: an agentic answer listed
 * mod_001 and mod_002 and then explained why mod_003 to mod_005 do not throw, and scored 40% for a right answer.
 */
export function modulesSaidToThrow(answer: string): Set<number> {
  const found = new Set<number>();
  let underNoThrow = false;
  for (const line of answer.split("\n")) {
    if (!line.trim()) continue;
    if (NO_THROW_HEADING.test(line)) {
      underNoThrow = true;
      continue;
    }
    // A heading-like line that names no module and does not negate starts a list of throwing ones again.
    if (/:\s*$/.test(line) && modulesNamed(line).size === 0) underNoThrow = false;
    for (const part of line.split(/(?<=[.;])\s+|\s+[-\u2013\u2014]\s+(?=[^-\u2013\u2014]*mod)/)) {
      const named = modulesNamed(part);
      if (!named.size) continue;
      if (underNoThrow || SAYS_NO_THROW.test(part)) continue;
      for (const m of named) found.add(m);
    }
  }
  return found;
}

function researchTask(n: number): BenchTask {
  const truth = throwingModules(n);
  return {
    name: `find-throwing-${n}`,
    group: "research-ladder",
    kind: "question",
    size: { files: n + 4, asks: 1 },
    files: shopProject(n),
    prompt: `Which of the ${n} modules in src/ (mod_${pad(0)}.js to mod_${pad(n - 1)}.js) make lineTotal throw an error when the quantity is negative? Answer with the list of those files only. Don't change anything.`,
    mayChange: [],
    // One part per module: named if it throws, not named if it does not. So the score is the share classified right.
    score: async (ctx) => {
      const named = modulesSaidToThrow(ctx.answer);
      return Array.from({ length: n }, (_, i) => ({ name: `mod_${pad(i)} ${truth.includes(i) ? "named" : "not named"}`, ok: named.has(i) === truth.includes(i) }));
    },
  };
}

interface EditAsk {
  module: number;
  kind: "bulk" | "throw" | "currency";
}

/** k asks spread over an n-module shop: a new function, a new error, a changed constant, in turn. */
export function editAsks(n: number, k: number): EditAsk[] {
  const asks: EditAsk[] = [];
  const kinds: EditAsk["kind"][] = ["bulk", "throw", "currency"];
  for (let j = 0; j < k; j++) {
    const module = Math.floor(((j + 0.5) * n) / k);
    let kind = kinds[j % 3]!;
    if (kind === "throw" && guardOf(module).throws) kind = "bulk";
    asks.push({ module, kind });
  }
  return asks;
}

const askText = (a: EditAsk): string => {
  const file = modulePath(a.module);
  if (a.kind === "bulk") return `In ${file}, add and export bulkTotal(qty, unit): lineTotal(qty, unit) with 10% off when qty is 10 or more, rounded to cents.`;
  if (a.kind === "throw") return `In ${file}, make lineTotal throw a RangeError when qty is negative.`;
  return `In ${file}, change DEFAULT_CURRENCY to 'SEK'.`;
};

function askCheck(a: EditAsk): string {
  const m = `require('./${modulePath(a.module).replace(/\.js$/, "")}')`;
  const keeps = `m.lineTotal(2,1.5)===3&&m.grossPrice(10)===Math.round(10*(1+m.TAX_RATE)*100)/100`;
  if (a.kind === "bulk") return `(()=>{const m=${m};return m.bulkTotal(10,2)===18&&m.bulkTotal(2,3)===6&&${keeps}})()`;
  if (a.kind === "throw") return `(()=>{const m=${m};try{m.lineTotal(-1,5)}catch(e){return e instanceof RangeError&&${keeps}}return false})()`;
  return `(()=>{const m=${m};return m.DEFAULT_CURRENCY==='SEK'&&m.describe({name:'x',price:2})==='x (2.00 SEK)'&&${keeps}})()`;
}

function applyAsk(text: string, a: EditAsk): string {
  if (a.kind === "currency") return text.replace("'EUR'", "'SEK'");
  if (a.kind === "throw") return text.replace(guardOf(a.module).code, "  if (qty < 0) throw new RangeError('negative quantity');");
  return text
    .replace("module.exports = { TAX_RATE, DEFAULT_CURRENCY, lineTotal, describe, grossPrice };", "module.exports = { TAX_RATE, DEFAULT_CURRENCY, lineTotal, describe, grossPrice, bulkTotal };")
    .replace("/** A one-line description", "function bulkTotal(qty, unit) {\n  const t = lineTotal(qty, unit);\n  return qty >= 10 ? roundCents(t * 0.9) : t;\n}\n\n/** A one-line description");
}

function editTask(n: number, k: number): BenchTask {
  const asks = editAsks(n, k);
  return {
    name: `edit-${k}-of-${n}`,
    group: "edit-ladder",
    kind: "change",
    size: { files: n + 4, asks: k },
    files: shopProject(n),
    prompt: k === 1 ? askText(asks[0]!) : `Make these ${k} changes:\n${asks.map((a, i) => `${i + 1}. ${askText(a)}`).join("\n")}`,
    mayChange: [...new Set(asks.map((a) => modulePath(a.module)))],
    score: async (ctx) => {
      const r = await nodeJson<boolean[]>(ctx, `const t=(f)=>{try{return !!f()}catch{return false}};console.log(JSON.stringify([${asks.map((a) => `t(()=>${askCheck(a)})`).join(",")}]))`);
      const names = asks.map((a) => `${a.kind} in mod_${pad(a.module)}`);
      return r ? names.map((name, i) => ({ name, ok: r[i] === true })) : failAll(names);
    },
    reference: (files) => {
      const out = { ...files };
      for (const a of asks) out[modulePath(a.module)] = applyAsk(out[modulePath(a.module)]!, a);
      return out;
    },
  };
}

export const BENCH_TASKS: BenchTask[] = [
  ...FIXED,
  // More changes in one request, in the same 20-module project.
  ...[1, 3, 6, 10].map((k) => editTask(20, k)),
  // The same three changes in a project five times bigger.
  editTask(100, 3),
  // The same question over more and more code.
  ...[5, 20, 50, 100].map((n) => researchTask(n)),
];

// ── Helpers shared by the runners ───────────────────────────────────────────

export function sh(cwd: string, command: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, output: `${stdout}${stderr}` });
    });
  });
}

/** Every file under root by relative path, skipping the extension's own folders. */
export async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if ([".agentic", ".git", "node_modules"].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) out.set(path.relative(root, full).split(path.sep).join("/"), await fs.readFile(full, "utf8").catch(() => ""));
    }
  };
  await walk(root);
  return out;
}

/** Writes a project into a new temporary folder and returns its real path. */
export async function writeProject(files: Record<string, string>, label: string): Promise<{ root: string; tmp: string }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `agentic-bench-${label}-`));
  const ws = path.join(tmp, "project");
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(ws, rel)), { recursive: true });
    await fs.writeFile(path.join(ws, rel), text);
  }
  return { root: await fs.realpath(ws), tmp };
}

/** Says the work is not done, or failed. Without it, an answer to a task that scored below 1 is a false "done". */
export const ADMITS_SHORTFALL =
  /\b(fail(ed|s|ing)?|could ?n[o']t|cannot|can't|unable|not (yet )?(done|finished|complete|completed|fixed|working|pass(ed)?|able)|did ?n[o']t|partial(ly)?|remain(s|ing)?|still (fails?|broken|need)|incomplete|error)\b/i;

export interface Judged {
  score: number;
  parts: Part[];
  /** Existing files changed that the request did not ask for. */
  collateral: string[];
  /** Existing files deleted. */
  deleted: string[];
  /** New files the agent created (not penalized; listed for the reader). */
  created: string[];
  /** A change task scored below 1 while the answer did not admit any shortfall. */
  falseDone: boolean;
}

/** Scores a finished attempt in its project folder. */
export async function judge(task: BenchTask, root: string, answer: string): Promise<Judged> {
  const ctx: BenchContext = {
    read: (rel) => fs.readFile(path.join(root, rel), "utf8").catch(() => undefined),
    sh: (c, a) => sh(root, c, a),
    answer,
  };
  const parts = await task.score(ctx).catch((err: Error) => [{ name: `checker failed: ${err.message}`, ok: false }]);
  const score = parts.length ? parts.filter((p) => p.ok).length / parts.length : 0;
  const now = await snapshot(root);
  const collateral: string[] = [];
  const deleted: string[] = [];
  for (const [rel, text] of Object.entries(task.files)) {
    const after = now.get(rel);
    if (after === undefined) deleted.push(rel);
    else if (after !== text && !task.mayChange.includes(rel)) collateral.push(rel);
  }
  const created = [...now.keys()].filter((rel) => !(rel in task.files));
  // A question has no "done" to claim; a change task that fell short must say so.
  const falseDone = task.kind === "change" && score < 1 && answer.trim().length > 0 && !ADMITS_SHORTFALL.test(answer);
  return { score, parts, collateral, deleted, created, falseDone };
}
