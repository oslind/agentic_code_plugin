/** The run 14 follow-up scenarios' own checks pass on a reference solution and fail on the original project. */
import { describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { MORE_SCENARIOS } from "../e2e/scenarios2";
import { ScenarioRun } from "../e2e/harness";

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
});
