import { describe, expect, it } from "vitest";
import { normalizeWorkspacePath, scopesOverlap, staticPrefix } from "../src/tools/paths";

describe("normalizeWorkspacePath", () => {
  it.each([
    ["src/a.ts", "src/a.ts"],
    ["./src//a.ts", "src/a.ts"],
    ["src\\win\\a.ts", "src/win/a.ts"],
    ["src/x/../a.ts", "src/a.ts"],
    ["src/", "src"],
  ])("normalizes %s", (input, out) => expect(normalizeWorkspacePath(input)).toBe(out));

  it.each(["/etc/passwd", "../outside", "src/../../x", "C:/Windows", "", "."])("rejects %s", (input) =>
    expect(normalizeWorkspacePath(input)).toBeUndefined(),
  );
});

describe("scopesOverlap", () => {
  it("finds the static prefix of a glob", () => {
    expect(staticPrefix("src/auth/**/*.ts")).toBe("src/auth");
    expect(staticPrefix("**/*.ts")).toBe("");
  });
  it.each([
    [["src/a.ts"], ["src/a.ts"], true],
    [["src/a.ts"], ["src/b.ts"], false],
    [["src/auth/**"], ["src/auth/login.ts"], true],
    [["src/auth/**"], ["src/ui/**"], false],
    [["src/**"], ["src/ui/**"], true],
    [["**/*.css"], ["src/ui/**"], true],
    [["src/*.ts"], ["src/ui/button.ts"], false],
  ])("%j vs %j -> %s", (a, b, expected) => expect(scopesOverlap(a, b)).toBe(expected));
});
