/** Run 14, find-throwing-100: the combined answer left out modules the reports named as throwing. */
import { describe, expect, it } from "vitest";
import { fileFindings, picksFiles, sortFact, sortFiles, withSortedFiles } from "../src/chat/perFile";
import { ChatRequest, ModelProvider } from "../src/providers/types";

const files = ["src/mod_001.js", "src/mod_002.js", "src/mod_003.js", "src/mod_004.js"];
const reports = [
  "src/mod_001.js (line 9): throws new Error('bad quantity')\nsrc/mod_002.js: clamps to 0, does not throw",
  "src/mod_003.js: uses assertNonNegative, which likely throws\nThe rest is fine.",
];

describe("per-file sort", () => {
  it("collects each file's own report lines and leaves out files no line names", () => {
    const f = fileFindings(files, reports);
    expect([...f.keys()]).toEqual(["src/mod_001.js", "src/mod_002.js", "src/mod_003.js"]);
    expect(f.get("src/mod_001.js")).toMatch(/line 9/);
  });

  it("only applies to questions that pick files out", () => {
    expect(picksFiles("Which of the 100 modules throw?")).toBe(true);
    expect(picksFiles("What does each module do?")).toBe(false);
  });

  it("sorts in batches, fences the reports, and counts a file the model skipped or invented as unclear", async () => {
    const requests: ChatRequest[] = [];
    const provider: ModelProvider = {
      model: "t",
      contextWindow: 16384,
      async chat(req) {
        requests.push(req);
        return { content: JSON.stringify({ files: [{ path: "src/mod_001.js", answer: "yes" }, { path: "src/mod_002.js", answer: "no" }, { path: "src/other.js", answer: "yes" }] }) };
      },
    };
    const sorted = await sortFiles(provider, "Which modules throw?", fileFindings(files, reports));
    expect([...sorted]).toEqual([["src/mod_001.js", "yes"], ["src/mod_002.js", "no"], ["src/mod_003.js", "unclear"]]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.messages[1]!.content).toMatch(/<untrusted_data[\s\S]*src\/mod_003\.js: uses assertNonNegative/);
    expect(sortFact(sorted)).toMatch(/1 matches the question, 1 do not, 1 unclear\.\nMatches: src\/mod_001\.js\.\nUnclear[^\n]*src\/mod_003\.js/);
  });

  it("adds a match or unclear file the answer left out, by rule, and nothing when it named them all", () => {
    const sorted = new Map([["src/mod_001.js", "yes"], ["src/mod_002.js", "no"], ["src/mod_003.js", "unclear"]] as const);
    expect(withSortedFiles("Only src/mod_002.js is safe.", new Map(sorted), files)).toBe(
      "Only src/mod_002.js is safe.\n\nChecked by rule: Also matching, from the reports file by file (left out above): src/mod_001.js. Unclear from the reports (they hedge or do not say): src/mod_003.js.",
    );
    expect(withSortedFiles("mod_001.js throws; mod_003.js is unclear.", new Map(sorted), files)).toBe("mod_001.js throws; mod_003.js is unclear.");
  });
});
