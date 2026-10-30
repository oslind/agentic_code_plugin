import { describe, expect, it } from "vitest";
import { checkToolCall } from "../src/tools/policy";
import { toolCallSchema, workerTurnSchema } from "../src/tools/protocol";

const ctx = { fileScope: ["src/auth/**", "package.json"], allowedChecks: ["test", "lint"] };
const verdict = (call: unknown) => checkToolCall(toolCallSchema.parse(call), ctx).verdict;

describe("checkToolCall", () => {
  it("allows writes inside the task's scope", () => {
    expect(verdict({ tool: "write_file", path: "src/auth/login.ts", content: "" })).toBe("allow");
  });
  it("denies writes outside the scope and outside the workspace", () => {
    expect(verdict({ tool: "write_file", path: "src/ui/x.ts", content: "" })).toBe("deny");
    expect(verdict({ tool: "replace_in_file", path: "../x", search: "a", replace: "b" })).toBe("deny");
    expect(verdict({ tool: "write_file", path: "src/auth/../../etc/x", content: "" })).toBe("deny");
  });
  it("denies secrets and git internals even in scope", () => {
    expect(checkToolCall({ tool: "write_file", path: ".git/config", content: "" }, { ...ctx, fileScope: ["**"] }).verdict).toBe("deny");
    expect(verdict({ tool: "read_file", path: "src/auth/.env" })).toBe("deny");
  });
  it("asks before changing sensitive files", () => {
    expect(verdict({ tool: "write_file", path: "package.json", content: "{}" })).toBe("ask");
  });
  it("only runs configured checks", () => {
    expect(verdict({ tool: "run_check", name: "test" })).toBe("allow");
    expect(verdict({ tool: "run_check", name: "rm -rf /" })).toBe("deny");
  });
  it("allows reads anywhere in the workspace", () => {
    expect(verdict({ tool: "read_file", path: "src/ui/x.ts" })).toBe("allow");
  });
});

describe("workerTurnSchema", () => {
  it("rejects unknown tools", () => {
    expect(workerTurnSchema.safeParse({ thought: "x", call: { tool: "shell", cmd: "ls" } }).success).toBe(false);
  });
});
