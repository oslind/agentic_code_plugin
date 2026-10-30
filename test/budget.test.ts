import { describe, expect, it } from "vitest";
import { estimateTokens, fileTree, fitToBudget } from "../src/context/budget";

describe("fitToBudget", () => {
  it("keeps required sections and drops low priority ones that do not fit", () => {
    const big = "x\n".repeat(5000);
    const out = fitToBudget(
      [
        { name: "req", text: "the request", priority: 100, required: true },
        { name: "files", text: "a.ts\nb.ts", priority: 50 },
        { name: "notes", text: big, priority: 10 },
      ],
      100,
    );
    expect(out.text).toContain("the request");
    expect(out.text).toContain("a.ts");
    expect(out.tokens).toBeLessThanOrEqual(100);
    expect([...out.dropped, ...out.truncated]).toContain("notes");
  });
  it("truncates at a line boundary with a marker", () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const out = fitToBudget([{ name: "files", text, priority: 1 }], 200);
    expect(out.truncated).toEqual(["files"]);
    expect(out.text).toMatch(/line \d+\n\[\.\.\. truncated/);
    expect(estimateTokens(out.text)).toBeLessThanOrEqual(200);
  });
  it("keeps the original section order", () => {
    const out = fitToBudget(
      [
        { name: "a", text: "AAA", priority: 1 },
        { name: "b", text: "BBB", priority: 9 },
      ],
      1000,
    );
    expect(out.text).toBe("AAA\n\nBBB");
  });
});

describe("fileTree", () => {
  it("indents shared directories once", () => {
    expect(fileTree(["src/b.ts", "src/a.ts", "README.md", "src/ui/x.ts"])).toBe(
      ["README.md", "src/", "  a.ts", "  b.ts", "  ui/", "    x.ts"].join("\n"),
    );
  });
});
