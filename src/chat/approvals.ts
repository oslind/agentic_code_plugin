import { TaskStore } from "../state/taskStore";
import { Task } from "../state/types";
import { CheckConfig } from "../checks/runner";
import { ToolCall } from "../tools/protocol";
import { isAutoApproved, isCheckAutoApproved, isChangeAutoAccepted } from "../tools/policy";
import { acceptChange } from "../changes/review";
import { commandLeavesProject } from "../tools/commandGuard";
import { ConversationStore } from "./conversationStore";
import { isUnreviewed } from "../coordinator/review";
import { AgentMonitor } from "../coordinator/monitor";
import { ChatHost, RunHooks } from "./host";
import { ChatSession } from "./session";
import { asSentence } from "./helpers";
import { Oversight } from "./oversight";

/**
 * What a run asks the user before it acts: sub-agents' commands and writes,
 * check commands, and the checks for a folder. A switch that is on gives the
 * authority; a switch that is off queues the step for the user's approval.
 */
export class Approvals {
  private readonly host: ChatHost;
  private readonly tasks: TaskStore;
  private readonly conversations: ConversationStore;

  constructor(
    private readonly s: ChatSession,
    private readonly oversight: Oversight,
  ) {
    this.host = s.host;
    this.tasks = s.tasks;
    this.conversations = s.conversations;
  }

  /**
   * A command a sub-agent wants to run with run_command. With "Run commands"
   * on it runs at once (the chat says so); otherwise a card shows the command
   * and nothing runs until the user allows it. "Allow for the rest of this
   * run" covers the same command again, by any sub-agent of this run.
   */
  async approveAgentCommand(conversationId: string, runId: string, task: Task, call: Extract<ToolCall, { tool: "run_command" }>): Promise<boolean> {
    if (isAutoApproved(call, this.host.permissions()) || this.s.allowedFor(runId).has(call.command)) return true;
    const { decision } = await this.s.waitFor(conversationId, {
      author: "agent",
      kind: "approval",
      runId,
      taskId: task.id,
      agentName: task.title,
      rememberable: true,
      rememberLabel: "Allow for the rest of this run",
      text: `I'd like to run \`${call.command}\`.${call.reason ? ` ${asSentence(call.reason)}` : ""} Nothing runs until you allow it. It runs in a copy of the project, so your files are not touched, but like any command it runs as you and can read files elsewhere or use the network, so only allow it if you trust it. Turn on "Run commands" to stop being asked.`,
    });
    if (decision?.kind !== "allow") return false;
    if (decision.remember) this.s.allowedFor(runId).add(call.command);
    return true;
  }

  hooksFor(conversationId: string, runId: string, checks: CheckConfig[], workspaceRoot: string): RunHooks {
    // The checks the user approved for this run (saved for the folder, or chosen in the checks form).
    // Only these, and commands approved during the run, may run without asking; the same rule as outside the chat.
    const trusted = new Set(checks.map((c) => c.command));
    return {
      checks,
      wrapProvider: (task, provider) => this.s.agentProvider(provider, runId, task.id),
      inbox: (taskId) => this.s.drainInbox(runId, taskId),
      askCoordinator: (task, question, signal) => this.oversight.consultCoordinator(conversationId, runId, task, question, signal),
      reviewResult: (task, summary, drafts, signal, skip) => this.oversight.reviewResult(conversationId, runId, task, summary, drafts, signal, skip),
      attach: (control) => {
        const s = this.oversight.supervised.get(runId);
        if (s) s.control = control;
        if (s && control.maxTurns) s.monitor = new AgentMonitor({ maxTurns: control.maxTurns });
      },
      askUser: async (task, question) => {
        const { decision } = await this.s.waitFor(conversationId, {
          author: "agent",
          kind: "question",
          runId,
          taskId: task.id,
          agentName: task.title,
          text: question,
        });
        return decision?.kind === "answer" ? decision.text : "The user did not answer. Make a reasonable choice and say which in your summary.";
      },
      approveTool: async (task, reason, call, preview) => {
        if (call.tool === "run_command") return this.approveAgentCommand(conversationId, runId, task, call);
        if (isAutoApproved(call, this.host.permissions())) {
          // "Run commands" is on: the user has given this authority for commands sub-agents request.
          if (call.tool === "request_check") this.s.allowedFor(runId).add(call.command);
          await this.s.append(conversationId, {
            author: "system",
            runId,
            taskId: task.id,
            text: `Auto-approved for "${task.title}": ${call.tool === "request_check" ? `run \`${call.command}\`` : reason}`,
          });
          return true;
        }
        const isCommand = call.tool === "request_check";
        const { decision } = await this.s.waitFor(conversationId, {
          author: "agent",
          kind: "approval",
          runId,
          taskId: task.id,
          agentName: task.title,
          rememberable: isCommand,
          rememberLabel: isCommand ? "Allow, and keep it for this folder" : undefined,
          preview,
          text: isCommand
            ? `I'd like to run \`${call.command}\` as check "${call.name}". ${call.reason} Nothing runs until you allow it. It starts in the project folder, but like any command it runs as you and can read files elsewhere or use the network, so only allow it if you trust it.`
            : `${reason}. Nothing is written until you allow it.`,
        });
        if (decision?.kind !== "allow") return false;
        if (decision.remember && isCommand) {
          const info = await this.host.checksFor(workspaceRoot);
          const base = (info.saved ?? info.defaults).filter((c) => c.name !== call.name);
          await this.host.saveChecks(workspaceRoot, [...base, { name: call.name, command: call.command }]);
          this.s.allowedFor(runId).add(call.command);
        }
        return true;
      },
      onChanges: async (task, changes) => {
        const auto = this.host.permissions();
        // Nobody checked this result although a review was due: the user decides, whatever the switches say.
        const outcome = this.oversight.reviewOutcomes.get(`${runId}:${task.id}`);
        const held = isUnreviewed(outcome) ? changes.filter((ch) => isChangeAutoAccepted(ch.path, auto)).length : 0;
        const written: string[] = [];
        for (const ch of changes) {
          if (held || !isChangeAutoAccepted(ch.path, auto)) continue;
          const res = await acceptChange(this.tasks, runId, ch.path, workspaceRoot, { auto: true });
          if (res.ok) written.push(ch.path);
          else this.s.changeNotes.set(`${runId}:${ch.path}`, res.message);
        }
        const waiting = changes.filter((ch) => !written.includes(ch.path));
        await this.s.append(conversationId, {
          author: "agent",
          kind: "review",
          runId,
          taskId: task.id,
          agentName: task.title,
          tone: waiting.length ? "warning" : "success",
          text: waiting.length
            ? `I have ${waiting.length} draft change(s) for you to review under Changes. Nothing is written to your project until you accept.${written.length ? ` ${written.length} other change(s) were accepted and written right away because an auto-approve switch is on.` : ""}${held ? " My result did not pass the coordinator's review, so they were not written automatically even though an auto-approve switch is on." : ""}`
            : `My ${written.length} change(s) were written to your project, because an auto-approve switch is on.`,
        });
        // Open what waits for review, so the user sees it right away.
        for (const ch of waiting.slice(0, 3)) await this.host.showChange(runId, ch.path).catch((err) => this.host.log("warn", (err as Error).message));
      },
      approveCommand: async (task, check) => {
        if (isCheckAutoApproved(this.host.permissions().commands, trusted, check.command) || this.s.allowedFor(runId).has(check.command)) return true;
        const { decision } = await this.s.waitFor(conversationId, {
          author: "agent",
          kind: "approval",
          runId,
          taskId: task.id,
          agentName: task.title,
          rememberable: true,
          rememberLabel: "Allow for the rest of this run",
          text: `I'd like to run \`${check.command}\` (check "${check.name}") to verify my work. It starts in the project folder, but like any command it runs as you and can read files elsewhere or use the network, so only allow it if you trust it. Turn on "Run commands" to stop being asked.`,
        });
        if (decision?.kind !== "allow") return false;
        if (decision.remember) this.s.allowedFor(runId).add(check.command);
        return true;
      },
    };
  }

  /**
   * The checks for a run. If the user has not chosen checks for this folder
   * yet, proposes the defaults plus what the project's files suggest and
   * waits for approval. Resolves undefined if the user stopped.
   */
  async chooseChecks(conversationId: string, workspaceRoot: string, force = false): Promise<CheckConfig[] | undefined> {
    const info = await this.host.checksFor(workspaceRoot);
    if (info.saved && !force) {
      await this.s.append(conversationId, {
        author: "coordinator",
        kind: "checks",
        checks: info.saved,
        decided: "Saved for this folder",
        text: info.saved.length ? "Using the checks saved for this folder to verify the sub-agents' work." : "No checks are saved for this folder, so only the sub-agents' own requested checks will verify their work.",
      });
      return info.saved;
    }
    const proposed: CheckConfig[] = [...(info.saved ?? info.defaults)];
    for (const d of info.detected) if (!proposed.some((c) => c.name === d.name)) proposed.push(d);
    if (proposed.length === 0 && !force) {
      // Nothing to propose: don't stop the user with an empty form. Sub-agents can still request a check if their work needs one.
      await this.s.append(conversationId, {
        author: "system",
        text: "No test, lint or type-check commands were found for this project, so the run starts without checks. Use the beaker button to add some.",
        tone: "warning",
      });
      return [];
    }
    const { decision } = await this.s.waitFor(conversationId, {
      author: "coordinator",
      kind: "checks",
      checks: proposed,
      text: proposed.length
        ? "These commands will verify the sub-agents' work. Edit, add or remove them, then press Use these checks. Sub-agents can also ask you for more checks while they work."
        : "I found no test, lint or type-check commands for this project. Add the ones you use, or run without checks. Sub-agents can also ask you for checks while they work.",
    });
    if (!decision || (decision.kind !== "checks" && decision.kind !== "skip")) return undefined;
    const entered = decision.kind === "checks" ? decision.checks.filter((c) => c.name.trim() && c.command.trim()) : [];
    const refused = entered.filter((c) => commandLeavesProject(c.command));
    const checks = entered.filter((c) => !refused.includes(c));
    for (const c of refused) {
      await this.s.append(conversationId, {
        author: "system",
        tone: "warning",
        text: `The check "${c.name}" (\`${c.command}\`) was left out: ${commandLeavesProject(c.command)}`,
      });
    }
    if (decision.kind === "checks" && decision.remember) await this.host.saveChecks(workspaceRoot, checks);
    return checks;
  }

}
