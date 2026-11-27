/**
 * Before a fix-up, one investigator call names the changed line that breaks the failing command, from the output
 * with and without the drafts and the diffs (Oskar, 2026-11-26, after run 29 rename-everywhere).
 */
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatSession } from "../src/chat/session";
import { Verifier, withEntryPoints } from "../src/chat/verifier";
import { buildDiagnosisMessages, Cause, checkedCauses, diagnose, diagnosisNote, DraftFile, namedPaths } from "../src/coordinator/diagnose";
import { fixUpRequest } from "../src/coordinator/verify";
import { ChatMessage, ModelProvider } from "../src/providers/types";
import { TaskStore } from "../src/state/taskStore";

const RENAME: DraftFile = {
  path: "src/thermostat.js",
  original: "const { targetTemp } = require('./config');\nfunction heat(t) {\n  return t < targetTemp;\n}\nmodule.exports = { heat };\n",
  proposed: "function warm(t) {\n  return t < targetTemp;\n}\nmodule.exports = { warm };\n",
};
const BROKEN = [{ line: "npm test", output: "ReferenceError: targetTemp is not defined\n    at warm (src/thermostat.js:2:14)", before: "" }];
const cause = (c: Partial<Cause>): Cause => ({ path: RENAME.path, quote: "", kind: "added", why: "w", fix: "f", ...c });

describe("checking the investigator's quotes against the drafts", () => {
  it("keeps a removed line the original had and the draft lacks", () => {
    expect(checkedCauses([cause({ quote: "- const { targetTemp } = require('./config');", kind: "removed" })], [RENAME])).toHaveLength(1);
  });

  it("keeps an added line that is in the draft, with spacing that differs and a ./ path", () => {
    expect(checkedCauses([cause({ path: "./src/thermostat.js", quote: "+ return t <  targetTemp;" })], [RENAME])).toHaveLength(1);
  });

  it("drops an invented line, a removed line still in the draft, a wrong file and a quote too short to check", () => {
    const out = checkedCauses(
      [
        cause({ quote: "const targetTemp = 20;" }),
        cause({ quote: "return t < targetTemp;", kind: "removed" }),
        cause({ path: "src/other.js", quote: "function warm(t) {" }),
        cause({ quote: "}" }),
      ],
      [RENAME],
    );
    expect(out).toEqual([]);
  });

  it("keeps an unchanged line of a file the failure names, and of a draft only where the draft left it (run 30)", () => {
    const test = { path: "test.js", text: "check(targetTemp('night'), 18);\n" };
    expect(checkedCauses([cause({ path: "test.js", quote: "check(targetTemp('night'), 18);", kind: "unchanged" })], [RENAME], [test])).toHaveLength(1);
    expect(checkedCauses([cause({ path: "test.js", quote: "check(targetTemp('night'), 17);", kind: "unchanged" })], [RENAME], [test])).toEqual([]);
    expect(checkedCauses([cause({ quote: "module.exports = { warm };", kind: "unchanged" })], [RENAME])).toEqual([]);
    expect(checkedCauses([cause({ quote: "return t < targetTemp;", kind: "unchanged" })], [RENAME])).toHaveLength(1);
  });

  it("finds the project files a failing command names, not absolute or dependency paths", () => {
    expect(namedPaths([{ line: "node test.js", output: "FAIL night\n    at Object.<anonymous> (/tmp/x/src/thermostat.js:4:9)\n    at node_modules/foo/index.js:1" }])).toEqual(["test.js"]);
  });

  it("finds a file named by its end", () => {
    expect(checkedCauses([cause({ path: "thermostat.js", quote: "function warm(t) {" })], [RENAME])).toHaveLength(1);
  });
});

describe("what the investigator is given", () => {
  it("fences the outputs and the diff, and shows the removed import as a - line", () => {
    const [system, user] = buildDiagnosisMessages({ userWords: "Rename heat to warm everywhere", broken: BROKEN, files: [RENAME] }, 16384);
    expect(system!.content).toMatch(/Find the changed line/);
    expect(user!.content).toMatch(/Rename heat to warm everywhere/);
    expect(user!.content).toMatch(/<untrusted_data[^>]*>[\s\S]*ReferenceError: targetTemp[\s\S]*Without the changes:\n\(passed, no output\)/);
    expect(user!.content).toMatch(/diff of src\/thermostat\.js[\s\S]*- const \{ targetTemp \} = require\('\.\/config'\);/);
  });

  it("shows an unchanged file the failure names after the diffs, and says the requested change is never undone", () => {
    const [system, user] = buildDiagnosisMessages({ userWords: "Make night 4 lower", broken: BROKEN, files: [RENAME], related: [{ path: "test.js", text: "check(night, 18);" }] }, 16384);
    expect(system!.content).toMatch(/never to undo what the user asked/);
    expect(user!.content).toMatch(/did not touch[\s\S]*test\.js \(not changed\)[\s\S]*check\(night, 18\);/);
  });

  it("shows a new file as all added lines", () => {
    const [, user] = buildDiagnosisMessages({ broken: BROKEN, files: [{ path: "src/new.js", original: null, proposed: "a\nb" }] }, 16384);
    expect(user!.content).toMatch(/diff of src\/new\.js \(new file\)[\s\S]*\+ a\n\+ b/);
  });
});

describe("one diagnosis call", () => {
  const provider = (reply: unknown, seen?: ChatMessage[][]): ModelProvider => ({
    model: "t",
    contextWindow: 16384,
    chat: async (req) => {
      seen?.push(req.messages);
      return { content: JSON.stringify(reply) };
    },
  });

  it("returns only the checked causes, and the note names the line to put back and the command to rerun", async () => {
    const seen: ChatMessage[][] = [];
    const causes = await diagnose(
      provider(
        {
          causes: [
            { path: "src/thermostat.js", quote: "const { targetTemp } = require('./config');", kind: "removed", why: "warm uses targetTemp, which is no longer imported.", fix: "Put back const { targetTemp } = require('./config'); at the top." },
            { path: "src/thermostat.js", quote: "const targetTemp = 21;", kind: "added", why: "made up", fix: "x" },
          ],
        },
        seen,
      ),
      { broken: BROKEN, files: [RENAME] },
    );
    expect(seen).toHaveLength(1);
    expect(causes.map((c) => c.quote)).toEqual(["const { targetTemp } = require('./config');"]);
    const note = diagnosisNote(causes, BROKEN);
    expect(note).toMatch(/src\/thermostat\.js: the line `const \{ targetTemp \} = require\('\.\/config'\);` was removed\. warm uses targetTemp/);
    expect(note).toMatch(/run `npm test` afterwards/);
  });

  it("makes no call when nothing is broken or nothing was drafted, and gives no note without causes", async () => {
    const seen: ChatMessage[][] = [];
    expect(await diagnose(provider({ causes: [] }, seen), { broken: [], files: [RENAME] })).toEqual([]);
    expect(await diagnose(provider({ causes: [] }, seen), { broken: BROKEN, files: [] })).toEqual([]);
    expect(seen).toHaveLength(0);
    expect(diagnosisNote([], BROKEN)).toBe("");
  });

  it("tells the fix-up planner to follow the diagnosis only when there is one", () => {
    expect(fixUpRequest("Rename heat", 1, 1, true)).toMatch(/A diagnosis under "What we know so far" names the changed line/);
    expect(fixUpRequest("Rename heat", 1, 1, false)).not.toMatch(/diagnosis/);
  });
});

describe("the verifier diagnoses before a fix-up", () => {
  let tmp: string;
  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it("keeps the output without the drafts, and sends one investigator whose note is shown and returned", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "diagnose-"));
    const root = path.join(tmp, "project");
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "config.js"), "module.exports = { targetTemp: 20 };\n");
    await fs.writeFile(path.join(root, RENAME.path), RENAME.original!);
    await fs.writeFile(path.join(root, "test.js"), "const t = require('./src/thermostat');\nconsole.log((t.warm || t.heat)(10));\n");
    const tasks = new TaskStore(path.join(tmp, "state"));
    const run = await tasks.createRun("rename", root);
    run.changes = [
      { path: RENAME.path, taskId: "t1", original: RENAME.original, proposed: "nothing", status: "rejected" },
      { path: RENAME.path, taskId: "t2", original: RENAME.original, proposed: RENAME.proposed, status: "pending" },
    ];
    await tasks.save(run);
    const appended: { tag?: string; text: string }[] = [];
    const seen: ChatMessage[][] = [];
    const reply = { causes: [{ path: RENAME.path, quote: "const { targetTemp } = require('./config');", kind: "removed", why: "targetTemp is no longer imported.", fix: "Put the require back." }] };
    const session = {
      host: { openFolder: async () => root, scratchLinkDirs: () => [], permissions: () => ({ editFiles: false, sensitiveFiles: false, commands: false }), terminal: () => undefined, log: () => undefined },
      tasks,
      conversations: {},
      allowedFor: () => new Set(["node test.js"]),
      append: async (_c: string, e: { tag?: string; text: string }) => void appended.push(e),
      budget: { exhausted: () => false },
      changed: () => undefined,
      coordinatorProvider: () => ({ model: "t", contextWindow: 16384, chat: async (req: { messages: ChatMessage[] }) => (seen.push(req.messages), { content: JSON.stringify(reply) }) }),
    } as unknown as ChatSession;
    const verifier = new Verifier(session);
    const r = await verifier.compareWithProject("c", root, run.id, withEntryPoints([], ["node test.js"]), [], new AbortController().signal);
    expect(r.failedCommands?.map((f) => [f.line, f.before])).toEqual([["node test.js", ""]]);
    expect(r.failedCommands?.[0]?.output).toMatch(/targetTemp is not defined/);

    const v = { verified: false, missing: ["Make `node test.js` pass again"], evidence: "", broken: r.failedCommands!.map((f) => ({ line: f.line, output: f.output, before: f.before })) };
    const note = await (verifier as unknown as { diagnoseBroken(...a: unknown[]): Promise<string> }).diagnoseBroken("c", root, run.id, v, "Rename heat to warm everywhere", new AbortController().signal);
    expect(seen).toHaveLength(1);
    // Only the newest draft that is not rejected is diffed.
    expect(seen[0]![1]!.content).toMatch(/- const \{ targetTemp \}/);
    expect(seen[0]![1]!.content).not.toMatch(/\+ nothing/);
    expect(note).toMatch(/was removed\. targetTemp is no longer imported\. Fix: Put the require back\./);
    expect(appended).toContainEqual(expect.objectContaining({ tag: "diagnosis", text: expect.stringMatching(/The cause:/) }));
  });
});
