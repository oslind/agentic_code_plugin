import { describe, expect, it } from "vitest";
import { buildPlannerMessages, planRequest } from "../src/coordinator/planner";
import { ChatRequest, ModelProvider } from "../src/providers/types";

function scripted(replies: string[], contextWindow = 32768): ModelProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    model: "test",
    contextWindow,
    requests,
    async chat(req) {
      requests.push({ ...req, messages: [...req.messages] });
      return { content: replies.shift() ?? "" };
    },
  };
}

const task = (id: string, dependsOn: string[], scope: string) =>
  ({ id, title: `Task ${id}`, instructions: `Implement ${id} carefully.`, dependsOn, fileScope: [scope] });

describe("planRequest", () => {
  it("retries when the model returns a cycle, then repairs scope overlaps", async () => {
    const cyclic = JSON.stringify({ tasks: [task("a", ["b"], "src/a.ts"), task("b", ["a"], "src/b.ts")] });
    const good = JSON.stringify({ tasks: [task("a", [], "src/**"), task("b", [], "src/b.ts")] });
    const p = scripted([`<think>hmm</think>${cyclic}`, "```json\n" + good + "\n```"]);
    const result = await planRequest(p, { request: "do it", fileTree: "src/\n  a.ts" });
    expect(p.requests).toHaveLength(2);
    expect(p.requests[1]!.messages.at(-1)!.content).toMatch(/cycle/);
    expect(result.repairs).toHaveLength(1);
    expect(result.plan.tasks[1]!.dependsOn).toEqual(["a"]);
  });
});

describe("task limit", () => {
  it("asks the model to merge tasks when it goes over the configured limit", async () => {
    const tasks = (n: number) => JSON.stringify({ tasks: Array.from({ length: n }, (_, i) => task(`t${i}`, [], `src/f${i}.ts`)) });
    const p = scripted([tasks(5), tasks(3)]);
    const result = await planRequest(p, { request: "do it", maxTasks: 3 });
    expect(p.requests[0]!.messages[0]!.content).toMatch(/Up to 3 tasks/);
    expect(p.requests[1]!.messages.at(-1)!.content).toMatch(/Too many tasks: at most 3/);
    expect(result.plan.tasks).toHaveLength(3);
  });
});

describe("buildPlannerMessages", () => {
  it("drops the file tree when the context window is tiny", () => {
    const tree = Array.from({ length: 5000 }, (_, i) => `file${i}.ts`).join("\n");
    const { messages, dropped } = buildPlannerMessages({ request: "x", fileTree: tree }, 6000);
    expect(dropped[0]).toMatch(/files/);
    expect(messages[1]!.content.length).toBeLessThan(tree.length);
  });
});
