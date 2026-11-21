import { describe, expect, it } from "vitest";
import { buildPlannerMessages, namesNotSaid, numbersNotSaid, planRequest } from "../src/coordinator/planner";
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
  it("merges the extra tasks into the last allowed one instead of rejecting the plan (run 14, python-project)", async () => {
    const tasks = (n: number) => JSON.stringify({ tasks: Array.from({ length: n }, (_, i) => task(`t${i}`, i ? [`t${i - 1}`] : [], `src/f${i}.ts`)) });
    const p = scripted([tasks(5)]);
    const result = await planRequest(p, { request: "do it", maxTasks: 3 });
    expect(p.requests[0]!.messages[0]!.content).toMatch(/Up to 3 tasks/);
    expect(p.requests).toHaveLength(1);
    expect(result.plan.tasks.map((t) => t.id)).toEqual(["t0", "t1", "t2"]);
    const last = result.plan.tasks[2]!;
    expect(last.fileScope).toEqual(["src/f2.ts", "src/f3.ts", "src/f4.ts"]);
    expect(last.instructions).toMatch(/^1\. [\s\S]* 2\. [\s\S]* 3\. /);
    expect(last.dependsOn).toEqual(["t1"]);
  });
});

describe("buildPlannerMessages", () => {
  it("gives the planner the user's own words when the coordinator's request differs", () => {
    // Run 4: the coordinator wrote "27.3.15" for the user's 273.15.
    const user = "Add toKelvin(celsius) to src/convert.js that returns celsius + 273.15";
    const text = buildPlannerMessages({ request: "Add toKelvin returning celsius + 27.3.15", userWords: user }, 16384).messages.map((m) => m.content).join("\n");
    expect(text).toMatch(/in their own words[\s\S]*celsius \+ 273\.15/);
    expect(text).toMatch(/the request has 27\.3\.15, which the user never wrote/);
    expect(buildPlannerMessages({ request: user, userWords: user }, 16384).messages.map((m) => m.content).join("\n")).not.toMatch(/in their own words/);
  });

  it("plans the latest message against the files' real code, with earlier messages only as background", () => {
    // Run 10, two-changes-in-a-row: the request added a toggle, and the plan wrote tasks for a class that does not exist.
    const text = buildPlannerMessages(
      {
        request: "Add 'away' mode to targetTemp in src/thermostat.js that returns 16. Add a way to toggle this mode.",
        userWords: "Now also add an 'away' mode to targetTemp in src/thermostat.js that returns 16.",
        earlierUserWords: ["Add toKelvin(celsius) to src/convert.js returning celsius + 273.15, and export it."],
        outlines: "src/thermostat.js:\n  function targetTemp(mode)\n  module.exports = { targetTemp };",
      },
      16384,
    ).messages.map((m) => m.content).join("\n");
    expect(text).toMatch(/where it adds work, a number or a name that the user's words do not have, leave that out/);
    expect(text).toMatch(/earlier messages[\s\S]*already handled[\s\S]*toKelvin/);
    expect(text).toMatch(/never plan for a class[\s\S]*function targetTemp\(mode\)/);
    expect(numbersNotSaid("returns 16 and 27.15", "returns 16, celsius + 273.15")).toEqual(["27.15"]);
    // Run 10, already-done: "Celsius(212)" for the user's "toCelsius(212)".
    expect(namesNotSaid("Update src/convert.js so Celsius(212) returns 100.", "Make sure toCelsius(212) returns 100 in src/convert.js.")).toEqual(["Celsius"]);
    expect(namesNotSaid("Add targetTemp away mode and fix max_value", "add away mode to targetTemp")).toEqual(["max_value"]);
    expect(buildPlannerMessages({ request: "Update so Celsius(212) returns 100.", userWords: "Make sure toCelsius(212) returns 100." }, 16384).messages.map((m) => m.content).join("\n")).toMatch(/the request names Celsius, which the user never wrote/);
  });

  it("drops the file tree when the context window is tiny", () => {
    const tree = Array.from({ length: 5000 }, (_, i) => `file${i}.ts`).join("\n");
    const { messages, dropped } = buildPlannerMessages({ request: "x", fileTree: tree }, 6000);
    expect(dropped[0]).toMatch(/files/);
    expect(messages[1]!.content.length).toBeLessThan(tree.length);
  });
});
