import { describe, expect, it } from "vitest";
import { combineDrafts } from "../src/changes/combine";
import { hasConflictMarkers, merge3 } from "../src/changes/merge";
import { PendingChange } from "../src/state/types";

const lines = (...l: string[]) => l.join("\n") + "\n";
const base = lines("one", "two", "three", "four", "five", "six");

describe("merge3", () => {
  it("combines changes to different parts of a file", () => {
    const a = lines("ONE", "two", "three", "four", "five", "six");
    const b = lines("one", "two", "three", "four", "five", "SIX", "seven");
    expect(merge3(base, a, b)).toEqual({ clean: true, text: lines("ONE", "two", "three", "four", "five", "SIX", "seven"), conflicts: 0 });
  });

  it("takes one side when the other did not change, and identical changes once", () => {
    const a = lines("one", "2", "three", "four", "five", "six");
    expect(merge3(base, a, base).text).toBe(a);
    expect(merge3(base, base, a).text).toBe(a);
    expect(merge3(base, a, a)).toMatchObject({ clean: true, text: a });
  });

  it("keeps insertions and deletions from both sides", () => {
    const a = lines("one", "two", "inserted by a", "three", "four", "five", "six");
    const b = lines("one", "two", "three", "four", "six");
    expect(merge3(base, a, b)).toMatchObject({ clean: true, text: lines("one", "two", "inserted by a", "three", "four", "six") });
  });

  it("marks changes to the same lines as a conflict, with both versions kept", () => {
    const a = lines("one", "TWO from a", "three", "four", "five", "six");
    const b = lines("one", "two from b", "three", "four", "five", "SIX");
    const m = merge3(base, a, b, { a: "Draft by A", b: "Draft by B" });
    expect(m.clean).toBe(false);
    expect(m.conflicts).toBe(1);
    expect(m.text).toBe(lines("one", "<<<<<<< Draft by A", "TWO from a", "=======", "two from b", ">>>>>>> Draft by B", "three", "four", "five", "SIX"));
    expect(hasConflictMarkers(m.text)).toBe(true);
    expect(hasConflictMarkers(a)).toBe(false);
  });

  it("treats changes to neighbouring lines as a conflict, like git", () => {
    const a = lines("one", "TWO", "three", "four", "five", "six");
    const b = lines("one", "two", "THREE", "four", "five", "six");
    expect(merge3(base, a, b).clean).toBe(false);
  });

  it("keeps marker labels on one line", () => {
    const m = merge3("x\n", "a\n", "b\n", { a: "A\n=======", b: "B" });
    expect(m.text.split("\n")[0]).toBe("<<<<<<< A =======");
  });

  it("handles files too big to diff line by line by treating the middle as one change", () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
    const a = ["start a", ...big.map((l) => l + " a"), "end"].join("\n");
    const b = ["start", ...big.map((l) => l + " b"), "end b"].join("\n");
    const m = merge3(["start", ...big, "end"].join("\n"), a, b);
    expect(m.clean).toBe(false);
    expect(m.text).toContain("line 2999 a");
    expect(m.text).toContain("line 2999 b");
  });
});

const draft = (taskId: string, proposed: string, basis?: string | null, extra: Partial<PendingChange> = {}): PendingChange => ({
  path: "f.txt",
  taskId,
  original: base,
  proposed,
  status: "pending",
  basis,
  ...extra,
});
const title = (id: string) => id.toUpperCase();

describe("combineDrafts", () => {
  it("replaces a draft that the new one was built on", () => {
    const a = draft("a", lines("ONE", "two", "three", "four", "five", "six"), base);
    const b = draft("b", lines("ONE", "TWO", "three", "four", "five", "six"), a.proposed);
    expect(combineDrafts(a, b, title)).toMatchObject({ outcome: "replaced", change: { taskId: "b", proposed: b.proposed, combinedWith: ["a"] } });
    // Its own newer draft simply replaces the old one.
    const a2 = draft("a", lines("1", "two", "three", "four", "five", "six"), a.proposed);
    expect(combineDrafts(a, a2, title)).toMatchObject({ outcome: "replaced", change: { proposed: a2.proposed } });
    expect(combineDrafts(a, a2, title).change.combinedWith).toBeUndefined();
  });

  it("combines two drafts that did not see each other", () => {
    const a = draft("a", lines("ONE", "two", "three", "four", "five", "six"), base);
    const b = draft("b", lines("one", "two", "three", "four", "five", "SIX"), base);
    const { change, outcome } = combineDrafts(a, b, title);
    expect(outcome).toBe("combined");
    expect(change).toMatchObject({ proposed: lines("ONE", "two", "three", "four", "five", "SIX"), original: base, taskId: "b", combinedWith: ["a"] });
    // A later draft from A, built on its own earlier one, is combined with B's part again.
    const a2 = draft("a", lines("ONE!", "two", "three", "four", "five", "six"), a.proposed);
    expect(combineDrafts(change, a2, title).change.proposed).toBe(lines("ONE!", "two", "three", "four", "five", "SIX"));
  });

  it("holds a conflict with both drafts kept", () => {
    const a = draft("a", lines("one", "two by a", "three", "four", "five", "six"), base);
    const b = draft("b", lines("one", "two by b", "three", "four", "five", "six"), base);
    const { change, outcome } = combineDrafts(a, b, title);
    expect(outcome).toBe("conflict");
    expect(change.proposed).toBe(b.proposed);
    expect(change.conflict).toMatchObject({ with: "draft", otherTaskId: "a", other: a.proposed, base, regions: 1 });
    expect(change.conflict!.markers).toContain("<<<<<<< Draft by A");
    expect(change.conflict!.markers).toContain(">>>>>>> Draft by B");
    // A sends a newer version that takes B's line on board: nothing is left to pick.
    const a2 = draft("a", lines("one", "two by b", "three", "four", "five", "six by a"), a.proposed);
    expect(combineDrafts(change, a2, title)).toMatchObject({ outcome: "combined", change: { proposed: lines("one", "two by b", "three", "four", "five", "six by a") } });
    expect(combineDrafts(change, a2, title).change.conflict).toBeUndefined();
  });

  it("never drops a version when a third draft conflicts again", () => {
    const a = draft("a", lines("one", "two by a", "three", "four", "five", "six"), base);
    const b = draft("b", lines("one", "two by b", "three", "four", "five", "six"), base);
    const c = draft("c", lines("one", "two by c", "three", "four", "five", "six"), base);
    const { change } = combineDrafts(combineDrafts(a, b, title).change, c, title);
    expect(change.proposed).toBe(c.proposed);
    for (const v of ["two by a", "two by b", "two by c"]) expect(change.conflict!.markers).toContain(v);
  });
});
