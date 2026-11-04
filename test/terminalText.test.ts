import { describe, expect, it } from "vitest";
import { escapeTerminalLine, TerminalSanitizer, toTerminalText } from "../src/checks/terminalText";
import { commandFooter, commandHeader } from "../src/checks/commandTerminal";
import { checkEnv } from "../src/checks/runner";
import { exec } from "../src/util/exec";

const ESC = "\x1b";

describe("terminal output filter", () => {
  it("keeps text, tabs, line breaks and plain colors", () => {
    expect(toTerminalText("a\nb\r\nc")).toBe("a\r\nb\r\nc");
    expect(toTerminalText(`${ESC}[32m✓ ok${ESC}[0m\tdone`)).toBe(`${ESC}[32m✓ ok${ESC}[0m\tdone`);
    expect(toTerminalText(`${ESC}[1;31mX${ESC}[m`)).toBe(`${ESC}[1;31mX${ESC}[0m`);
    expect(toTerminalText(`${ESC}[2;90mgray${ESC}[22;39m`)).toBe(`${ESC}[2;90mgray${ESC}[22;39m`);
  });

  it("drops screen clears, cursor moves and hidden text, so output cannot fake a result", () => {
    const fake = `real failure\n${ESC}[2J${ESC}[HEverything passed successfully\n`;
    const shown = toTerminalText(fake);
    expect(shown).toBe("real failure\r\nEverything passed successfully\r\n");
    expect(shown).not.toContain(ESC);
    expect(toTerminalText(`${ESC}[1A${ESC}[2K${ESC}[10;1H${ESC}[?1049h${ESC}c${ESC}7${ESC}(Bx`)).toBe("x");
    // Concealed (8) and blinking are removed; the rest of the SGR stays.
    expect(toTerminalText(`${ESC}[1;8;5mX`)).toBe(`${ESC}[1mX`);
    expect(toTerminalText(`${ESC}[8mX`)).toBe("X");
  });

  it("never lets output become invisible: no backgrounds, reverse video or exact colors", () => {
    // The same RGB in front and behind would hide the text completely.
    expect(toTerminalText(`${ESC}[38;2;1;2;3;48;2;1;2;3mTHIS OUTPUT IS INVISIBLE${ESC}[0m`)).toBe(`THIS OUTPUT IS INVISIBLE${ESC}[0m`);
    expect(toTerminalText(`${ESC}[38;5;16;48;5;16mX`)).toBe("X");
    expect(toTerminalText(`${ESC}[30;40mX${ESC}[97;107mY${ESC}[7mZ`)).toBe(`${ESC}[30mX${ESC}[97mYZ`);
    // Extended color arguments are not read as codes of their own (2 = dim, 8 = concealed).
    expect(toTerminalText(`${ESC}[38;2;8;8;8;1mX`)).toBe(`${ESC}[1mX`);
    expect(toTerminalText(`${ESC}[1;31;42mX`)).toBe(`${ESC}[1;31mX`);
  });

  it("removes OSC links, shell-integration markers, titles and DCS strings", () => {
    expect(toTerminalText(`${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\`)).toBe("click");
    expect(toTerminalText(`${ESC}]633;D;0\x07${ESC}]0;title\x07ok`)).toBe("ok");
    expect(toTerminalText(`${ESC}P+q544e${ESC}\\ok`)).toBe("ok");
    expect(toTerminalText("\x9d8;;https://evil\x9cok\x9b2Jx")).toBe("okx");
  });

  it("shows other control characters and text-direction marks as text", () => {
    expect(toTerminalText("a\x07b\x00c\x7fd\x85e")).toBe("a^Gb^@c^?d<U+0085>e");
    expect(toTerminalText("x‮y")).toBe("x<U+202E>y");
    // A lone \r would let a line overwrite itself ("FAILED\rPASSED").
    expect(toTerminalText("FAILED\rPASSED")).toBe("FAILED\r\nPASSED");
  });

  it("handles sequences and \\r\\n split across chunks", () => {
    const s = new TerminalSanitizer();
    const out = [`a${ESC}`, "[3", "2mB", `${ESC}]8;;http`, "://x", `${ESC}\\C\r`, "\nD\r"].map((c) => s.write(c)).join("") + s.end();
    expect(out).toBe(`a${ESC}[32mBC\r\nD\r\n`);
  });

  it("an OSC string that never ends stops hiding output after a while", () => {
    const shown = toTerminalText(`${ESC}]0;${"x".repeat(5000)}visible`);
    expect(shown.endsWith("visible")).toBe(true);
  });

  it("escapes the command and folder in the header and the error in the footer", () => {
    const header = commandHeader("/p", "/p", `echo hi${ESC}[2J${ESC}]8;;http://x${ESC}\\\nrm -rf`);
    expect(header).toContain("$ echo hi^[[2J^[]8;;http://x^[\\^Jrm -rf");
    expect(header.split(ESC).length - 1).toBe(4); // only the extension's own styling
    expect(escapeTerminalLine("a\tb")).toBe("a^Ib");
    const footer = commandFooter({ code: null, error: `Refused to run \`x${ESC}[2J\``, durationMs: 0 });
    expect(footer).toContain("x^[[2J");
  });
});

describe("streamed output limit", () => {
  it("streams at most the limit and then one notice, while the command still finishes", async () => {
    const chunks: string[] = [];
    const res = await exec(process.execPath, ["-e", "for (let i = 0; i < 200; i++) process.stdout.write('x'.repeat(1000))"], {
      cwd: process.cwd(),
      maxStreamed: 50_000,
      onOutput: (c) => chunks.push(c),
    });
    expect(res.code).toBe(0);
    const shown = chunks.join("");
    expect(shown.replace(/\n\[\.\.\. more output not shown[^\]]*\]\n/, "").length).toBe(50_000);
    expect(shown).toContain("more output not shown");
    expect(chunks.filter((c) => c.includes("more output not shown"))).toHaveLength(1);
  });
});

describe("check environment", () => {
  it("leaves out VS Code's own channels and credential helpers", () => {
    const env = checkEnv({
      PATH: "/bin",
      VSCODE_GIT_ASKPASS_MAIN: "x",
      VSCODE_GIT_IPC_HANDLE: "x",
      VSCODE_IPC_HOOK_CLI: "x",
      ELECTRON_RUN_AS_NODE: "1",
      GITHUB_TOKEN: "x",
    });
    expect(env).toEqual({ PATH: "/bin" });
  });
});
