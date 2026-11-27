/** The run 14 follow-up scenarios' own checks pass on a reference solution and fail on the original project. */
import { describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { MORE_SCENARIOS } from "../e2e/scenarios2";
import { ScenarioRun } from "../e2e/harness";
import { userRulesOf } from "../src/context/userRules";

async function runOf(files: Record<string, string>, extra: Partial<ScenarioRun> = {}): Promise<ScenarioRun> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "scen-"));
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(ws, rel)), { recursive: true });
    await fs.writeFile(path.join(ws, rel), text);
  }
  return {
    workspace: ws,
    state: {} as ScenarioRun["state"],
    entries: [],
    cards: [],
    gates: [],
    calls: [],
    read: (rel) => fs.readFile(path.join(ws, rel), "utf8").catch(() => undefined),
    sh: (command, args) => new Promise((resolve) => execFile(command, args, { cwd: ws }, (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, output: `${stdout}${stderr}` }))),
    ...extra,
  };
}

const scenario = (name: string) => MORE_SCENARIOS.find((s) => s.name === name)!;
const edit = (files: Record<string, string>, rel: string, from: string | RegExp, to: string) => ({ ...files, [rel]: files[rel]!.replace(from, to) });

describe("run 14 follow-up scenarios", () => {
  it("typo scenarios pass only when README.md is corrected, and catch a false claim", async () => {
    for (const name of ["typo-please-correct", "typo-swedish"]) {
      const s = scenario(name);
      expect(await s.expect(await runOf(edit(s.files, "README.md", "controler", "controller")))).toEqual([]);
      const lied = await s.expect(await runOf(s.files, { lastCoordinator: { author: "coordinator", text: "The typo has been fixed." } as ScenarioRun["lastCoordinator"] }));
      expect(lied).toHaveLength(2);
    }
  });

  it("old-test-pins-value needs both the code and the test at 17", async () => {
    const s = scenario("old-test-pins-value");
    const code = edit(s.files, "src/thermostat.js", "DEFAULT_TARGET - 3", "DEFAULT_TARGET - 4");
    expect(await s.expect(await runOf(edit(code, "test.js", "targetTemp('night'), 18", "targetTemp('night'), 17")))).toEqual([]);
    expect(await s.expect(await runOf(code))).toHaveLength(1);
    expect(await s.expect(await runOf(s.files))).toHaveLength(1);
  });

  it("rename-then-run-tests needs every use renamed and the same test result", async () => {
    const s = scenario("rename-then-run-tests");
    const renamed = Object.fromEntries(Object.entries(s.files).map(([k, v]) => [k, v.replace(/\btoCelsius\b/g, "fahrenheitToCelsius")]));
    expect(await s.expect(await runOf(renamed))).toEqual([]);
    expect((await s.expect(await runOf(s.files))).length).toBeGreaterThan(0);
  });

  it("research-sed passes on an honest answer and fails on a claim or a change", async () => {
    const s = scenario("research-sed");
    const answer = (text: string) => ({ lastCoordinator: { author: "coordinator", text } as ScenarioRun["lastCoordinator"] });
    expect(await s.expect(await runOf(s.files, answer("README.md has 'controler'; sed -i 's/controler/controller/' README.md would correct it.")))).toEqual([]);
    expect(await s.expect(await runOf(s.files, answer("'controler' has been corrected to 'controller'.")))).toHaveLength(1);
    expect(await s.expect(await runOf(edit(s.files, "README.md", "controler", "controller"), answer("'controler' is the typo.")))).toHaveLength(1);
  });

  it("new-module-esm needs an ES module that wraps add()", async () => {
    const s = scenario("new-module-esm");
    const done = { ...s.files, "src/format.js": "export function formatResult(n) {\n  return 'Result: ' + n;\n}\n", "src/main.js": "import { add } from './math.js';\nimport { formatResult } from './format.js';\n\nconsole.log(formatResult(add(2, 3)));\n" };
    expect(await s.expect(await runOf(done))).toEqual([]);
    const replaced = { ...done, "src/main.js": "import { formatResult } from './format.js';\n\nconsole.log(formatResult(5));\n" };
    expect(await s.expect(await runOf(replaced))).toEqual(["src/main.js no longer calls add()"]);
  });

  it("fix-old-failing-test needs the bug fixed in src/stats.js, and tells a false done from an honest miss", async () => {
    const s = scenario("fix-old-failing-test");
    const answer = (text: string) => ({ entries: [{ kind: "answer", text }] }) as unknown as Partial<ScenarioRun>;
    expect(await s.expect(await runOf(edit(s.files, "src/stats.js", "sum / 2", "sum / readings.length"), answer("Fixed.")))).toEqual([]);
    expect((await s.expect(await runOf(s.files, answer("The bug is fixed and the test now passes."))))[0]).toMatch(/^called done/);
    expect((await s.expect(await runOf(s.files, answer("I could not fix it; the test still fails."))))[0]).toMatch(/^not fixed/);
    const tampered = edit(s.files, "test.js", "average([18, 20, 22]), 20", "average([18, 20, 22]), 30");
    expect(await s.expect(await runOf(tampered, answer("Fixed.")))).toEqual(["test.js was changed; the bug is in src/stats.js"]);
  });

  it("new-module-used-twice needs label() printed as a second line by a program that still runs", async () => {
    const s = scenario("new-module-used-twice");
    const label = "function label(mode) {\n  return 'Mode: ' + (mode || 'day');\n}\n\nmodule.exports = { label };\n";
    const done = { ...s.files, "src/label.js": label, "src/index.js": s.files["src/index.js"]!.replace("\n\n", "\nconst { label } = require('./label');\n\n") + "console.log(label());\n" };
    expect(await s.expect(await runOf(done))).toEqual([]);
    const onlyImported = { ...done, "src/index.js": done["src/index.js"]!.replace("console.log(label());\n", "") };
    expect((await s.expect(await runOf(onlyImported))).join(" ")).toMatch(/does not print 'Mode: day'/);
    const wrongRequire = { ...done, "src/index.js": done["src/index.js"]!.replace("const { label }", "const label") };
    expect((await s.expect(await runOf(wrongRequire))).join(" ")).toMatch(/node src\/index\.js fails/);
  });
});

describe("scenarios for the user's worded rules", () => {
  it("only-this-file needs toKelvin in src/convert.js and every other file as it was", async () => {
    const s = scenario("only-this-file");
    const good = edit(s.files, "src/convert.js", "module.exports = { toCelsius };", "const toKelvin = (c) => c + 273.15;\nmodule.exports = { toCelsius, toKelvin };");
    expect(await s.expect(await runOf(good))).toEqual([]);
    expect(await s.expect(await runOf(edit(good, "test.js", "const tests", "// more\nconst tests")))).toEqual(["test.js was changed against the user's rule"]);
    expect(await s.expect(await runOf(s.files))).toHaveLength(1);
  });

  it("no-new-packages needs a working newId() and an untouched package.json", async () => {
    const s = scenario("no-new-packages");
    const good = { ...s.files, "src/id.js": "const { randomUUID } = require('crypto');\nmodule.exports = { newId: () => randomUUID() };\n" };
    expect(await s.expect(await runOf(good))).toEqual([]);
    expect(await s.expect(await runOf({ ...good, "package.json": '{"name":"thermostat","dependencies":{"uuid":"^9"}}' }))).toEqual(["package.json was changed"]);
    expect(await s.expect(await runOf({ ...good, "node_modules/uuid/index.js": "" }))).toEqual(["a node_modules folder appeared"]);
    expect(await s.expect(await runOf(s.files))).toHaveLength(1);
  });

  it("their prompts set the rules the tools enforce", () => {
    expect(userRulesOf(scenario("only-this-file").prompts[0]!)).toEqual({ keep: [], only: ["src/convert.js"], noNewPackages: false });
    expect(userRulesOf(scenario("no-new-packages").prompts[0]!)).toEqual({ keep: [], only: [], noNewPackages: true });
  });
});
