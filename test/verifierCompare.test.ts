/**
 * Whether a failing command is the drafts' fault is decided on the drafts as
 * they are now, not on what a sub-agent saw halfway through its task.
 */
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatSession } from "../src/chat/session";
import { Verifier, withEntryPoints } from "../src/chat/verifier";
import { fixUpNotes, guardVerification } from "../src/coordinator/verify";
import { TaskStore } from "../src/state/taskStore";

const TEST = [
  "const a = require('./a');",
  "if (a.v !== 1) console.log('FAIL a.v is 1');",
  "if (a.w !== undefined && a.w !== 2) console.log('FAIL a.w is 2');",
  "console.log('FAIL old bug');",
  "process.exit(1);",
  "",
].join("\n");

let tmp: string;
afterEach(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

async function setup(draft: string) {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "verifier-compare-"));
  const root = path.join(tmp, "project");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "test.js"), TEST);
  await fs.writeFile(path.join(root, "a.js"), "module.exports = { v: 1 };\n");
  const tasks = new TaskStore(path.join(tmp, "state"));
  const run = await tasks.createRun("add w", root);
  run.changes = [{ path: "a.js", taskId: "t1", original: "module.exports = { v: 1 };\n", proposed: draft, status: "pending" }];
  await tasks.save(run);
  const logs: string[] = [];
  const appended: { tag?: string; text: string }[] = [];
  const session = {
    host: { openFolder: async () => root, scratchLinkDirs: () => [], permissions: () => ({ editFiles: false, sensitiveFiles: false, commands: false }), terminal: () => undefined, log: (_l: string, m: string) => void logs.push(m) },
    tasks,
    conversations: {},
    allowedFor: () => new Set(["node test.js", "node index.js"]),
    append: async (_c: string, e: { tag?: string; text: string }) => void appended.push(e),
  } as unknown as ChatSession;
  return { verifier: new Verifier(session), root, runId: run.id, appended };
}

// What a sub-agent saw halfway through: its draft had broken a.js too.
const stale = [{ line: "node test.js", output: "FAIL a.v is 1\nFAIL old bug" }];

describe("comparing a failed command with the project without the drafts", () => {
  it("calls a failure from before the request pre-existing, though the sub-agent saw a worse one mid-task", async () => {
    const { verifier, root, runId } = await setup("module.exports = { v: 1, w: 2 };\n");
    const r = await verifier.compareWithProject("c", root, runId, stale, [], new AbortController().signal);
    expect(r.preexistingFailures?.map((f) => f.line)).toEqual(["node test.js"]);
    expect(r.failedCommands).toEqual([]);
  });

  it("still blames the drafts when they break something now", async () => {
    const { verifier, root, runId, appended } = await setup("module.exports = { v: 1, w: 3 };\n");
    const r = await verifier.compareWithProject("c", root, runId, stale, [], new AbortController().signal);
    expect(r.failedCommands?.map((f) => f.output)).toEqual([expect.stringMatching(/FAIL a\.w is 2/)]);
    // The rerun on all drafts is shown, so the final reply goes by the latest result.
    expect(appended).toEqual([expect.objectContaining({ tag: "rerun", text: expect.stringMatching(/still fails/) })]);
  });
});

describe("a saved check that fails on all drafts together (run 16, old-test-pins-value)", () => {
  const check = [{ name: "tests", command: "node test.js" }];
  it("is marked as failing before when it fails only the way it did without the drafts", async () => {
    const { verifier, root, runId } = await setup("module.exports = { v: 1, w: 2 };\n");
    const [r] = await verifier.runVerifyChecks("c", root, runId, check, new AbortController().signal);
    expect(r!.passed).toBe(false);
    expect(r!.failedBefore).toBe("before");
    const v = guardVerification({ verdict: "done", verified: "ok", missing: [] }, { checks: [r!], tasks: [] });
    expect(v.verified).toBe(true);
    expect(v.missing).toEqual([]);
  });

  it("names only the new failure when the drafts broke something and an old failure is there too", async () => {
    const { verifier, root, runId } = await setup("module.exports = { v: 2 };\n");
    const [r] = await verifier.runVerifyChecks("c", root, runId, check, new AbortController().signal);
    expect(r!.failedBefore).toBe("new");
    expect(r!.newFailures).toEqual(["FAIL a.v is 1"]);
    expect(r!.oldFailures).toEqual(["FAIL old bug"]);
    const v = guardVerification({ verdict: "done", verified: "ok", missing: [] }, { checks: [r!], tasks: [] });
    expect(v.verified).toBe(false);
    expect(v.missing[0]).toMatch(/where the drafts broke it: FAIL a\.v is 1\. Leave these alone.*FAIL old bug/);
    expect(fixUpNotes(v as never, [r!], [])).toMatch(/failed before this request too and are not to be touched: FAIL old bug/);
  });
});

describe("running the program the drafts are part of (run 16)", () => {
  it("finds a script that loads a drafted module, and leaves modules and servers out", async () => {
    const { verifier, root } = await setup("module.exports = { v: 1, w: 2 };\n");
    await fs.writeFile(path.join(root, "index.js"), "const a = require('./a');\nconsole.log(a.v);\n");
    await fs.writeFile(path.join(root, "app.js"), "const a = require('./a');\nrequire('http').createServer().listen(3000);\n");
    const drafted = new Map([["a.js", { path: "a.js", taskId: "t1", original: "module.exports = { v: 1 };\n", proposed: "module.exports = { v: 1, w: 2 };\n", status: "pending" as const }]]);
    const found = await (verifier as unknown as { entryPoints(r: string, c: unknown[], d: unknown): Promise<string[]> }).entryPoints(root, [...drafted.values()], drafted);
    expect(found).toEqual(["node index.js"]);
    expect(withEntryPoints([{ line: "node  index.js", output: "x" }], found)).toEqual([{ line: "node  index.js", output: "x" }]);
    expect(withEntryPoints([], found)).toEqual([{ line: "node index.js", output: "" }]);
  });

  it("blames the drafts when the program crashes with them and ran before", async () => {
    const { verifier, root, runId } = await setup("module.exports = { v: 1 };\n");
    await fs.writeFile(path.join(root, "index.js"), "const a = require('./a');\nconsole.log(a.v.toFixed(1));\n");
    const run = await (verifier as unknown as { tasks: TaskStore }).tasks.load(runId);
    run.changes = [{ path: "a.js", taskId: "t1", original: "module.exports = { v: 1 };\n", proposed: "module.exports = {};\n", status: "pending" }];
    await (verifier as unknown as { tasks: TaskStore }).tasks.save(run);
    const r = await verifier.compareWithProject("c", root, runId, withEntryPoints([], ["node index.js"]), [], new AbortController().signal);
    expect(r.failedCommands?.map((f) => f.line)).toEqual(["node index.js"]);
    expect(r.failedCommands?.[0]?.output).toMatch(/TypeError/);
    const v = guardVerification({ verdict: "done", verified: "Read the drafts.", missing: [] }, { checks: [], tasks: [], failedCommands: r.failedCommands });
    expect(v.verified).toBe(false);
    expect(v.missing[0]).toMatch(/Make `node index\.js` pass again: it fails with the drafts and not without them: TypeError/);
  });
});

describe("the coordinator runs the project's test suite on all drafts (Oskar, 2026-11-26)", () => {
  it("adds the test command after the programs, once, and not when a sub-agent's failed run of it is there", () => {
    expect(withEntryPoints([], ["node index.js"], "npm test").map((f) => f.line)).toEqual(["node index.js", "npm test"]);
    expect(withEntryPoints([{ line: "npm  test", output: "1 failed" }], [], "npm test")).toEqual([{ line: "npm  test", output: "1 failed" }]);
    expect(withEntryPoints([], ["node test.js"], "node test.js").map((f) => f.line)).toEqual(["node test.js"]);
  });

  it("finds a new test failure the drafts cause and leaves an old one alone", async () => {
    const { verifier, root, runId } = await setup("module.exports = { v: 1 };\n");
    await fs.writeFile(path.join(root, "test.js"), "const a = require('./a');\nif (a.v !== 1) { console.log('FAIL v is 1'); process.exitCode = 1; }\nconsole.log('FAIL old');\nprocess.exitCode = 1;\n");
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }));
    const run = await (verifier as unknown as { tasks: TaskStore }).tasks.load(runId);
    run.changes = [{ path: "a.js", taskId: "t1", original: "module.exports = { v: 1 };\n", proposed: "module.exports = { v: 2 };\n", status: "pending" }];
    await (verifier as unknown as { tasks: TaskStore }).tasks.save(run);
    const found = await (verifier as unknown as { testCommand(r: string): Promise<string | undefined> }).testCommand(root);
    expect(found).toBe("npm test");
    const r = await verifier.compareWithProject("c", root, runId, withEntryPoints([], [], "node test.js"), [], new AbortController().signal);
    expect(r.failedCommands?.map((f) => f.line)).toEqual(["node test.js"]);
    expect(r.failedCommands?.[0]?.output).toMatch(/new with the drafts: FAIL v is 1/);
  });
});

import { misusedCommand } from "../src/chat/verifier";

describe("run 29: a command that cannot work as written is not blamed on the drafts", () => {
  it("knows a wrong command line from a real failure", () => {
    expect(misusedCommand("ImportError: Failed to import test module: tests/test_calc\nModuleNotFoundError: No module named 'tests/test_calc'\nFAILED (errors=1)")).toBe(true);
    expect(misusedCommand("usage: python3 -m unittest [-h]\npython3 -m unittest: error: unrecognized arguments: -x")).toBe(true);
    expect(misusedCommand("bash: pytest: command not found")).toBe(true);
    expect(misusedCommand("ModuleNotFoundError: No module named 'calc'")).toBe(false);
    expect(misusedCommand("FAIL freezing point: fahrenheitToCelsius is not a function")).toBe(false);
  });
});

describe("every program run on the drafts is kept for the expected-output check (run 30)", () => {
  it("keeps a run whose output the drafts did not change, with its output before", async () => {
    const { verifier, root, runId } = await setup("module.exports = { v: 1 };\n");
    await fs.writeFile(path.join(root, "index.js"), "const a = require('./a');\nconsole.log('v is ' + a.v);\n");
    const r = await verifier.compareWithProject("c", root, runId, withEntryPoints([], ["node index.js"]), [], new AbortController().signal);
    expect(r.programOutputs).toBeUndefined();
    expect(r.programRuns).toEqual([{ line: "node index.js", before: "v is 1", now: "v is 1" }]);
  });
});
