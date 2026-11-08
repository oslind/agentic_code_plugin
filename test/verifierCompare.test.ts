/**
 * Whether a failing command is the drafts' fault is decided on the drafts as
 * they are now, not on what a sub-agent saw halfway through its task.
 */
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatSession } from "../src/chat/session";
import { Verifier } from "../src/chat/verifier";
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
  const session = {
    host: { openFolder: async () => root, scratchLinkDirs: () => [], permissions: () => ({ editFiles: false, sensitiveFiles: false, commands: false }), terminal: () => undefined, log: (_l: string, m: string) => void logs.push(m) },
    tasks,
    conversations: {},
    allowedFor: () => new Set(["node test.js"]),
  } as unknown as ChatSession;
  return { verifier: new Verifier(session), root, runId: run.id };
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
    const { verifier, root, runId } = await setup("module.exports = { v: 1, w: 3 };\n");
    const r = await verifier.compareWithProject("c", root, runId, stale, [], new AbortController().signal);
    expect(r.failedCommands?.map((f) => f.output)).toEqual([expect.stringMatching(/FAIL a\.w is 2/)]);
  });
});
