/** Benchmark pass 1: questions about many files are split by rule, and the answer says what was read. */
import { describe, expect, it } from "vitest";
import { batchesOf, batchFilesOf, batchQuestion, batchReview, mentionsFile, coverageNote, coverageOf, filesAskedAbout, filesRead, MAX_BATCH } from "../src/chat/coverage";

const shop = [...Array.from({ length: 100 }, (_, i) => `src/mod_${String(i).padStart(3, "0")}.js`), "src/shop.js", "test.js", "package.json", "README.md", "node_modules/x/index.js"];

describe("filesAskedAbout", () => {
  it("reads a numbered range of files from the question", () => {
    const q = "Which of the 100 modules in src/ (mod_000.js to mod_099.js) make lineTotal throw an error when the quantity is negative?";
    const files = filesAskedAbout(q, shop)!;
    expect(files).toHaveLength(100);
    expect(files[0]).toBe("src/mod_000.js");
    expect(filesAskedAbout("Check mod_010.js to mod_019.js for bugs.", shop)).toHaveLength(10);
  });
  it("takes the code files of a named folder for 'which/all/every ... modules'", () => {
    expect(filesAskedAbout("Which modules in src/ log a warning?", shop)).toHaveLength(101);
    expect(filesAskedAbout("List all files in src that use require.", shop)).toHaveLength(101);
  });
  it("takes the whole project only when the question says so, never node_modules", () => {
    expect(filesAskedAbout("Which files use console.log in the whole project?", shop)).toHaveLength(102);
    expect(filesAskedAbout("Which files use console.log?", shop)).toBeUndefined();
  });
  it("leaves other questions, small sets and questions about the chat alone", () => {
    expect(filesAskedAbout("What does src/shop.js do?", shop)).toBeUndefined();
    expect(filesAskedAbout("Which files did you change in src/?", shop)).toBeUndefined();
    expect(filesAskedAbout("Which modules in src/ throw?", ["src/a.js", "src/b.js", "src/c.js"])).toBeUndefined();
  });
});

describe("batches and coverage", () => {
  it("splits files over researchers, never more than a researcher can open", () => {
    const files = Array.from({ length: 100 }, (_, i) => `f${i}.js`);
    const b = batchesOf(files, 8);
    expect(b).toHaveLength(8);
    expect(b.map((x) => x.length)).toEqual([13, 13, 13, 13, 13, 13, 13, 9]);
    const big = batchesOf(Array.from({ length: 300 }, (_, i) => `f${i}.js`), 8);
    expect(big.every((x) => x.length === MAX_BATCH)).toBe(true);
    expect(big.flat()).toHaveLength(8 * MAX_BATCH);
  });
  it("asks each researcher the user's own question for its files only", () => {
    expect(batchQuestion("Which throw?", ["a.js", "b.js"])).toMatch(/for each of these 2 file\(s\), and only these: "Which throw\?"[\s\S]*read_file[\s\S]*Files: a\.js, b\.js/);
  });
  it("counts only files opened with read_file", () => {
    const read = filesRead([
      { time: "", runId: "r", type: "tool_call", message: "read_file", data: { call: { tool: "read_file", path: "./a.js" } } },
      { time: "", runId: "r", type: "tool_call", message: "search_files", data: { call: { tool: "search_files", query: "throw" } } },
    ]);
    expect([...read]).toEqual(["a.js"]);
    const c = coverageOf(["a.js", "b.js"], read);
    expect(c).toEqual({ files: ["a.js", "b.js"], read: ["a.js"], unread: ["b.js"] });
    expect(coverageNote(c)).toMatch(/^Checked 1 of the 2 files .* \(b\.js\)\.$/);
    expect(coverageNote(coverageOf(["a.js"], read))).toBeUndefined();
  });
});

describe("the review of a batch researcher, by rule", () => {
  const batch = ["src/mod_001.js", "src/mod_002.js"];
  it("reads its own files back from the question", () => {
    expect(batchFilesOf(batchQuestion("Which throw?", batch))).toEqual(batch);
    expect(batchFilesOf("What does src/mod_001.js do?")).toBeUndefined();
  });
  it("accepts a report that opened and names every file", () => {
    expect(batchReview(batch, new Set(batch), "- mod_001.js: throws.\n- src/mod_002.js: returns 0.")).toMatchObject({ accept: true });
  });
  it("sends back, naming what is missing and keeping it to its own files (check 2026-11-09)", () => {
    const r = batchReview(batch, new Set(["src/mod_001.js"]), "mod_001.js throws. mod_002.js: file not found.");
    expect(r.accept).toBe(false);
    expect(r.unread).toEqual(["src/mod_002.js"]);
    expect(r.feedback).toMatch(/only these 2: src\/mod_001\.js, src\/mod_002\.js\. Do not look at other files[\s\S]*not opened src\/mod_002\.js[\s\S]*exactly these paths/);
    expect(batchReview(batch, new Set(batch), "mod_001.js throws.").unreported).toEqual(["src/mod_002.js"]);
  });
  it("matches a file by path or whole file name only", () => {
    expect(mentionsFile("see mod_01.js", "src/mod_01.js")).toBe(true);
    expect(mentionsFile("see mod_010.js", "src/mod_01.js")).toBe(false);
    expect(mentionsFile("see xmod_01.js", "src/mod_01.js")).toBe(false);
  });
});
