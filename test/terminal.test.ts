import { ScratchCopy } from "../src/changes/scratch";
import { mkdir, mkdtemp, realpath, rm } from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandTerminals, ScreenEvents, shownFolder, toTerminalText } from "../src/checks/commandTerminal";
import { runAllChecks, runCheck } from "../src/checks/runner";

const node = (code: string) => `node -e ${JSON.stringify(code)}`;

interface FakeScreen {
  name: string;
  text: string;
  shown: number;
  disposed: boolean;
  events: ScreenEvents;
}

function fakeTerminals(root: string) {
  const screens: FakeScreen[] = [];
  const terminals = new CommandTerminals(root, (name, events) => {
    const s: FakeScreen = { name, text: "", shown: 0, disposed: false, events };
    screens.push(s);
    return {
      write: (t) => void (s.text += t),
      show: () => void s.shown++,
      dispose: () => void (s.disposed = true),
    };
  });
  return { terminals, screens };
}

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "term-")));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("project terminal", () => {
  it("runs the command in the project folder, not where the extension or another terminal is", async () => {
    const { terminals, screens } = fakeTerminals(root);
    const res = await runCheck({ name: "where", command: node("console.log(process.cwd())") }, root, undefined, 4000, terminals);
    expect(res.passed).toBe(true);
    expect(res.output.trim()).toBe(root);
    expect(process.cwd()).not.toBe(root);
    // Shown in the extension's own terminal: the folder, the command, its output and the result.
    expect(screens).toHaveLength(1);
    expect(screens[0].name).toBe("Agentic Code");
    expect(screens[0].shown).toBe(1);
    expect(screens[0].text).toContain(path.basename(root));
    expect(screens[0].text).toContain(`$ ${node("console.log(process.cwd())")}`);
    expect(screens[0].text).toContain(`${root}\r\n`);
    expect(screens[0].text).toContain("Passed in");
  });

  it("reuses one terminal and opens another only while it is busy", async () => {
    const { terminals, screens } = fakeTerminals(root);
    await runCheck({ name: "a", command: node("1") }, root, undefined, 4000, terminals);
    await runCheck({ name: "b", command: node("1") }, root, undefined, 4000, terminals);
    expect(screens).toHaveLength(1);
    // Two sub-agents at once: their output must not mix.
    await Promise.all([
      runCheck({ name: "c", command: node("setTimeout(()=>console.log('C'),200)") }, root, undefined, 4000, terminals),
      runCheck({ name: "d", command: node("console.log('D')") }, root, undefined, 4000, terminals),
    ]);
    expect(screens.map((s) => s.name)).toEqual(["Agentic Code", "Agentic Code (2)"]);
    expect(screens[0].text).toContain("C\r\n");
    expect(screens[0].text).not.toContain("D\r\n");
    expect(screens[1].text).toContain("D\r\n");
  });

  it("shows failures, and a refused command never runs", async () => {
    const { terminals, screens } = fakeTerminals(root);
    const failed = await runCheck({ name: "f", command: node("process.exit(3)") }, root, undefined, 4000, terminals);
    expect(failed.passed).toBe(false);
    expect(screens[0].text).toContain("exit code 3");
    const refused = await runCheck({ name: "x", command: "cat ../secret" }, root, undefined, 4000, terminals);
    expect(refused.passed).toBe(false);
    expect(screens[0].text).toContain("Refused to run");
  });

  it("Stop ends a command running in the terminal", async () => {
    const { terminals, screens } = fakeTerminals(root);
    const stop = new AbortController();
    const started = Date.now();
    const pending = runCheck({ name: "slow", command: node("setTimeout(()=>{},30000)") }, root, stop.signal, 4000, terminals);
    setTimeout(() => stop.abort(), 300);
    const res = await pending;
    expect(res.passed).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(screens[0].text).toContain("Stopped after");
  });

  it("Ctrl+C or closing the terminal stops only that command", async () => {
    const { terminals, screens } = fakeTerminals(root);
    const pending = runCheck({ name: "slow", command: node("setTimeout(()=>{},30000)") }, root, undefined, 4000, terminals);
    setTimeout(() => screens[0].events.onInterrupt(), 300);
    const res = await pending;
    expect(res.passed).toBe(false);
    expect(res.output).toBe("Stopped from the terminal.");

    const again = runCheck({ name: "slow", command: node("setTimeout(()=>{},30000)") }, root, undefined, 4000, terminals);
    setTimeout(() => screens[0].events.onClose(), 300);
    expect((await again).passed).toBe(false);
    // The next command opens a new terminal, since the user closed the old one.
    await runCheck({ name: "a", command: node("1") }, root, undefined, 4000, terminals);
    expect(screens).toHaveLength(2);
  });

  it("an unapproved command is not shown or run", async () => {
    const { terminals, screens } = fakeTerminals(root);
    const res = await runAllChecks([{ name: "t", command: node("1") }], root, undefined, async () => false, terminals);
    expect(res[0].skipped).toBe(true);
    expect(screens).toHaveLength(0);
  });

  it("shows folders relative to the project and marks the scratch copy", async () => {
    const copy = new ScratchCopy(root, ["abc", "t1"], []);
    const scratch = await copy.sync(new Map());
    await mkdir(path.join(scratch, "sub"));
    expect(shownFolder(root, root)).toBe(path.basename(root));
    expect(shownFolder(root, scratch)).toBe(`${path.basename(root)} (scratch copy)`);
    expect(shownFolder(root, path.join(scratch, "sub"))).toBe(`${path.basename(root)} (scratch copy)/sub`);
    const { terminals, screens } = fakeTerminals(root);
    await runCheck({ name: "a", command: node("1") }, scratch, undefined, 4000, terminals);
    expect(screens[0].text).toContain("pending changes");
    await copy.remove();
    // A removed copy is no longer marked as one.
    expect(shownFolder(root, scratch)).toBe(scratch);
    expect(toTerminalText("a\nb\r\nc")).toBe("a\r\nb\r\nc");
  });
});
