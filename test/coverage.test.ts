/** Benchmark pass 1: questions about many files are split by rule, and the answer says what was read. */
import { describe, expect, it } from "vitest";
import { askedScope, tooManyNote, batchesOf, batchFilesOf, batchQuestion, batchReview, mentionsFile, coverageNote, coverageOf, filesAskedAbout, filesRead, MAX_BATCH, readExtents } from "../src/chat/coverage";

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
  it("keeps every file of a big folder, never only the first 400 (audit of PR #54)", () => {
    const big = Array.from({ length: 900 }, (_, i) => `lib/m${i}.js`);
    expect(filesAskedAbout("Which modules in lib/ throw?", big)).toHaveLength(900);
  });
  it("matches folder names with regex characters only literally", () => {
    const odd = [...Array.from({ length: 8 }, (_, i) => `a+b/m${i}.js`), ...Array.from({ length: 8 }, (_, i) => `aab/m${i}.js`)];
    expect(filesAskedAbout("Which modules in aab/ throw?", odd)!.every((f) => f.startsWith("aab/"))).toBe(true);
    expect(filesAskedAbout("Which modules in a+b/ throw?", odd)!.every((f) => f.startsWith("a+b/"))).toBe(true);
    const ranged = Array.from({ length: 10 }, (_, i) => `src/m(${i}).js`);
    expect(filesAskedAbout("Check m(0).js to m(9).js", ranged)).toBeUndefined();
  });
  it("says when a whole-project question is about too many files to read one by one (audit of PR #54)", () => {
    const huge = Array.from({ length: 600 }, (_, i) => `src/m${i}/x.js`);
    expect(askedScope("Which files throw in the whole project?", huge)).toEqual({ tooMany: 600 });
    expect(filesAskedAbout("Which files throw in the whole project?", huge)).toBeUndefined();
    expect(askedScope("What does src/m1/x.js do?", huge)).toEqual({});
    expect(tooManyNote(600)).toMatch(/all 600 code files[\s\S]*not every file was read/);
    // From a listing cut at 5000 files the count is only a lower bound (audit of PR #54).
    expect(tooManyNote(600, true)).toMatch(/about at least 600 code files \(the project has more than 5000 files, so the total is not known\)/);
  });
  it("keeps the links the listing could not follow in the asked folder, and the answer names them (audit of PR #54)", () => {
    const files = Array.from({ length: 8 }, (_, i) => `src/m${i}.js`);
    const scope = askedScope("Which modules in src/ throw?", files, 400, ["src/ext.js", "lib/other"]);
    expect(scope).toEqual({ files, skipped: ["src/ext.js"] });
    const c = coverageOf(files, new Set(files), false, ["src/ext.js"]);
    expect(coverageNote(c)).toMatch(/could not be followed, so nothing behind them was read: src\/ext\.js/);
    expect(coverageNote(coverageOf(files, new Set(files)))).toBeUndefined();
  });
  it("counts a skipped link inside a numbered range, and a named folder that is itself a skipped link (audit of PR #54)", () => {
    const listed = Array.from({ length: 100 }, (_, i) => `src/mod_${String(i).padStart(3, "0")}.js`).filter((f) => f !== "src/mod_042.js");
    const scope = askedScope("Which of mod_000.js to mod_099.js throw?", listed, 400, ["src/mod_042.js", "src/other.js"]);
    expect(scope).toMatchObject({ skipped: ["src/mod_042.js"] });
    expect("files" in scope && scope.files).toHaveLength(99);
    expect(askedScope("Which modules in shared/ throw?", listed, 400, ["shared"])).toEqual({ files: [], skipped: ["shared"] });
    // A range under a linked folder the listing could not follow (only the folder is reported).
    expect(askedScope("Check shared/mod_000.js to shared/mod_099.js for errors.", ["src/shop.js"], 400, ["shared"])).toEqual({ files: [], skipped: ["shared"] });
    expect(askedScope("What does shared/mod_001.js do?", ["src/shop.js"], 400, ["shared"])).toEqual({});
    // Files of the same names in another folder are not the range the question names.
    const src = Array.from({ length: 100 }, (_, i) => `src/mod_${String(i).padStart(3, "0")}.js`);
    expect(askedScope("Check shared/mod_000.js to shared/mod_099.js for errors.", src, 400, ["shared"])).toEqual({ files: [], skipped: ["shared"] });
    expect(askedScope("Check src/mod_000.js to src/mod_009.js for errors.", [...src, "lib/src/mod_001.js"], 400, [])).toEqual({ files: src.slice(0, 10) });
    // Every file of the range a skipped link, and no "which/every" in the question.
    const allLinks = Array.from({ length: 100 }, (_, i) => `src/mod_${String(i).padStart(3, "0")}.js`);
    expect(askedScope("Check mod_000.js to mod_099.js for errors.", ["src/shop.js"], 400, allLinks)).toEqual({ files: [], skipped: allLinks });
    expect(askedScope("Which modules in src/ throw?", listed, 400, ["shared"])).toEqual({ files: listed });
    const none = coverageOf([], new Set(), false, ["shared"]);
    expect(coverageNote(none)).toMatch(/could not be followed[\s\S]*shared/);
  });
  it("says when the project had more files than could be listed", () => {
    const c = coverageOf(["a.js"], new Set(["a.js"]), true);
    expect(coverageNote(c)).toMatch(/more than 5000 files/);
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
  const fr = (reads: Record<string, unknown>[]) => ({ time: "", runId: "r", type: "files_read", message: "", data: { reads } });
  it("counts only files whose reads worked and showed every line (audit of PR #54)", () => {
    const read = filesRead([
      // A read_file call is logged before it runs: it counts for nothing on its own.
      { time: "", runId: "r", type: "tool_call", message: "read_file", data: { call: { tool: "read_file", path: "b.js" } } },
      fr([{ path: "./a.js", from: 1, to: 20, total: 20, cut: false }]),
      fr([{ path: "c.js", from: 1, to: 120, total: 300, cut: false }]),
      fr([{ path: "d.js", from: 1, to: 100, total: 200, cut: false }]),
      fr([{ path: "d.js", from: 101, to: 200, total: 200, cut: false }]),
      fr([{ path: "e.js", from: 1, to: 50, total: 50, cut: true }]),
    ]);
    expect([...read].sort()).toEqual(["a.js", "d.js"]);
    const c = coverageOf(["a.js", "b.js"], read);
    expect(c).toEqual({ files: ["a.js", "b.js"], read: ["a.js"], unread: ["b.js"] });
    expect(coverageNote(c)).toMatch(/^Checked 1 of the 2 files .* \(b\.js\)\.$/);
    expect(coverageNote(coverageOf(["a.js"], read))).toBeUndefined();
  });
  it("knows which lines of a partly read file are missing", () => {
    const x = readExtents([fr([{ path: "c.js", from: 1, to: 120, total: 300, cut: false }]), fr([{ path: "c.js", from: 200, to: 300, total: 300, cut: false }])]).get("c.js")!;
    expect(x).toMatchObject({ seen: 221, total: 300, firstGap: 121, complete: false });
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
  it("tells a researcher that saw only part of a file which lines to read next", () => {
    const extents = readExtents([{ time: "", runId: "r", type: "files_read", message: "", data: { reads: [{ path: "src/mod_002.js", from: 1, to: 80, total: 300, cut: false }] } }]);
    const r = batchReview(batch, new Set(["src/mod_001.js"]), "mod_001.js throws. mod_002.js returns.", extents);
    expect(r.accept).toBe(false);
    expect(r.feedback).toMatch(/seen only 80 of the 300 lines of src\/mod_002\.js\. Read the rest with read_file and startLine=81/);
  });
  it("needs the path when two files share a name (audit of PR #54)", () => {
    const twins = ["src/a/index.js", "src/b/index.js"];
    expect(mentionsFile("index.js: has a handler", "src/a/index.js", twins)).toBe(false);
    expect(mentionsFile("src/a/index.js: has a handler", "src/a/index.js", twins)).toBe(true);
    expect(mentionsFile("src/a/index.js: has a handler", "src/b/index.js", twins)).toBe(false);
    expect(mentionsFile("lib/src/a/index.js: x", "src/a/index.js", twins)).toBe(false);
    expect(batchReview(twins, new Set(twins), "index.js: has a handler").unreported).toEqual(twins);
  });
  it("matches a file by path or whole file name only", () => {
    expect(mentionsFile("see mod_01.js", "src/mod_01.js")).toBe(true);
    expect(mentionsFile("see mod_010.js", "src/mod_01.js")).toBe(false);
    expect(mentionsFile("see xmod_01.js", "src/mod_01.js")).toBe(false);
  });
});
