// Chat sidebar page: an orchestration dashboard with Overview, Agents, Drafts and Checks tabs
// and a prompt fixed at the bottom. It renders state from the extension and sends user actions back.
// Everything from the model is inserted as text, never as HTML. Replies are shown as markdown
// through markdown.js, which only returns plain objects that are built here with createElement.
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const saved = vscode.getState() || {};
  let state = null;
  let draft = typeof saved.draft === "string" ? saved.draft : "";
  let attachments = Array.isArray(saved.attachments) ? saved.attachments.filter((x) => typeof x === "string") : [];
  const TABS = ["overview", "agents", "changes", "settings"];
  let tab = TABS.includes(saved.tab) ? saved.tab : "overview";
  /** The sub-agent whose conversation is open in the Agents tab, as "runId:taskId". */
  let agentView = typeof saved.agentView === "string" ? saved.agentView : null;
  let filesBy = saved.filesBy === "agent" ? "agent" : "file";
  // Which collapsible parts are open, so re-rendering does not close them.
  const open = new Set(Array.isArray(saved.open) ? saved.open : []);
  /** Model calls in flight, by "coordinator" or "runId:taskId". Updated many times a second while a model streams. */
  let live = {};

  function persist() {
    vscode.setState({ draft, attachments, tab, agentView, filesBy, open: [...open].slice(-80) });
  }

  // ---- small helpers ----

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children.flat(Infinity)) {
      if (c === undefined || c === null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function post(msg) {
    vscode.postMessage(msg);
  }

  function timeLabel(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const today = new Date();
    return d.toDateString() === today.toDateString()
      ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function folderName(p) {
    return (p || "").split(/[\\/]/).filter(Boolean).pop() || p;
  }

  function baseName(p) {
    return (p || "").split("/").pop() || p;
  }

  function dirName(p) {
    const i = (p || "").lastIndexOf("/");
    return i > 0 ? p.slice(0, i) : "";
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many || one + "s"}`;
  }

  /** Views that read like a chat: they open at the latest message. */
  function followsLatest() {
    return tab === "overview" || (tab === "agents" && !!agentView);
  }

  function setTab(t) {
    tab = t;
    persist();
    render();
    const main = document.getElementById("main");
    if (main) main.scrollTop = followsLatest() ? main.scrollHeight : 0;
  }

  // ---- live model output ----

  const LIVE_PHASE = {
    queued: "Waiting for the model server",
    waiting: "Model is reading the prompt",
    thinking: "Thinking",
    writing: "Writing its reply",
  };

  function duration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
  }

  function liveMeta(item) {
    const now = Date.now();
    const parts = [duration(now - item.startedAt)];
    if (item.tokens) parts.push(`~${item.tokens} tokens`);
    // Tokens stopped coming: say so, so a stalled server is told apart from a slow one.
    const quiet = now - item.updatedAt;
    if (item.tokens && quiet >= 15000) parts.push(`nothing new for ${duration(quiet)}`);
    return parts.join(" · ");
  }

  function fillLive(box, item) {
    if (!item) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    box.hidden = false;
    const tail = item.tail ? el("pre", { class: "live-tail" + (item.phase === "thinking" ? " is-thinking" : "") }, item.tail) : null;
    box.replaceChildren(
      el(
        "div",
        { class: "live-head" },
        el("span", { class: "spinner" }),
        el("span", { class: "live-phase" }, LIVE_PHASE[item.phase] || "Working"),
        el("span", { class: "spacer" }),
        el("span", { class: "live-meta" }, liveMeta(item)),
      ),
      tail,
    );
    if (tail) tail.scrollTop = tail.scrollHeight;
  }

  /** Where a model call shows live: what it is doing, for how long, and the end of its train of thought. */
  function liveBox(key) {
    const box = el("div", { class: "live", "data-live": key, "aria-live": "off" });
    fillLive(box, live[key]);
    return box;
  }

  function patchLive() {
    for (const box of document.querySelectorAll("[data-live]")) fillLive(box, live[box.getAttribute("data-live")]);
  }

  // The clock keeps moving between tokens, so a long wait still shows it is alive.
  setInterval(() => {
    for (const box of document.querySelectorAll("[data-live]")) {
      const item = live[box.getAttribute("data-live")];
      const meta = item && box.querySelector(".live-meta");
      if (meta) meta.textContent = liveMeta(item);
    }
  }, 1000);

  function details(key, label, body, cls) {
    const d = el("details", { class: cls || "fold", open: open.has(key) }, el("summary", {}, label), body);
    d.addEventListener("toggle", () => {
      if (d.open) open.add(key);
      else open.delete(key);
      persist();
    });
    return d;
  }

  /** A status pill. Colors come from one table so every view uses the same ones. */
  function pill(tone, text, title) {
    return el("span", { class: "pill tone-" + tone, title }, text);
  }

  // One color per state, used everywhere: gray queued, blue working, green done, red failed, amber stopped, orange waiting on you.
  const AGENT_TONE = {
    planned: "muted",
    queued: "muted",
    initializing: "info",
    working: "info",
    verifying: "info",
    asking: "info",
    needs_you: "attention",
    completed: "success",
    failed: "error",
    stopped: "warning",
  };
  const AGENT_ICON = { planned: "○", queued: "○", completed: "✓", failed: "✕", stopped: "■", needs_you: "!" };
  const COORD_TONE = {
    idle: "muted",
    thinking: "info",
    supervising: "info",
    needs_you: "attention",
    stopping: "warning",
    finished: "success",
    partial: "warning",
    stopped: "warning",
    failed: "error",
  };
  const DRAFT_TONE = { proposed: "muted", draft: "attention", applied: "success", discarded: "muted", reverted: "muted" };
  const DRAFT_LABEL = { proposed: "Proposed", draft: "Draft", applied: "Accepted", discarded: "Rejected", reverted: "Reverted" };
  const REVERT_TITLE = {
    new: "Undo this accept: delete the file the sub-agent created. Only this file is touched.",
    edit: "Undo this accept: put the file back as it was before the draft was written. Only this file is touched.",
  };

  function stateIcon(s) {
    if (s === "initializing" || s === "working" || s === "verifying" || s === "asking") return el("span", { class: "spinner", "aria-hidden": "true" });
    return el("span", { class: "state-icon tone-" + (AGENT_TONE[s] || "muted"), "aria-hidden": "true" }, AGENT_ICON[s] || "○");
  }

  function dash() {
    return state.dashboard;
  }

  function allChanges() {
    const out = [];
    for (const [runId, plan] of Object.entries(state.plans || {})) {
      for (const c of plan.changes || []) out.push({ ...c, runId });
    }
    return out;
  }

  function isWaiting(entry) {
    return state.waiting && state.waiting.includes(entry.id);
  }

  // ---- header ----

  function header() {
    const d = state.current && dash();
    const status = d ? pill(COORD_TONE[d.coordinator.state], d.coordinator.label, "Coordinator: " + d.coordinator.activity) : pill("muted", "Ready");
    const select = el(
      "select",
      {
        class: "history",
        title: "Switch conversation",
        "aria-label": "Conversation",
        disabled: !!state.busy,
        onchange: (e) => {
          const v = e.target.value;
          if (v === "__new") post({ type: "newTask" });
          else if (v) post({ type: "open", id: v });
        },
      },
      el("option", { value: "__new", selected: !state.current }, "+ New task"),
      state.conversations.map((c) =>
        el("option", { value: c.id, selected: state.current && state.current.id === c.id }, `${c.title} · ${timeLabel(c.updatedAt)}`),
      ),
    );
    return el(
      "header",
      { class: "top" },
      el(
        "div",
        { class: "top-row" },
        el("span", { class: "brand" }, "AGENTIC"),
        status,
        el("span", { class: "spacer" }),
        el("button", { class: "icon-btn", title: "New task", "aria-label": "New task", disabled: !!state.busy, onclick: () => post({ type: "newTask" }) }, "+"),
        el("button", { class: "icon-btn" + (tab === "settings" ? " on" : ""), title: "Settings: oversight, auto-approval and checks", "aria-label": "Settings", onclick: () => (state.current ? setTab(tab === "settings" ? "overview" : "settings") : post({ type: "settings" })) }, "⚙"),
      ),
      el("div", { class: "top-row" }, select),
    );
  }

  // ---- tabs ----

  function tabs() {
    const d = dash();
    const working = d.agents.filter((a) => ["initializing", "working", "verifying", "asking", "needs_you"].includes(a.state)).length;
    const items = [
      ["overview", "Overview", null],
      ["agents", "Agents", working ? el("span", { class: "badge tone-info" }, working) : null],
      ["changes", "Changes", d.drafts.awaiting ? el("span", { class: "badge tone-attention" }, d.drafts.awaiting) : null],
    ];
    return el(
      "nav",
      { class: "tabs", role: "tablist" },
      items.map(([id, label, badge]) =>
        el(
          "button",
          { class: "tab" + (tab === id ? " on" : ""), role: "tab", "aria-selected": tab === id ? "true" : "false", onclick: () => setTab(id) },
          el("span", { class: "tab-label" }, label),
          badge,
        ),
      ),
    );
  }

  // ---- Needs you: everything waiting on the user, on every view ----

  const NEED_KIND = { checks: "Checks", question: "Question" };

  function needKind(e) {
    if (e.kind === "approval") return e.rememberable ? "Command" : "Permission";
    return NEED_KIND[e.kind] || "Question";
  }

  function needText(e) {
    if (e.kind === "approval") {
      const cmd = /`([^`]+)`/.exec(e.text || "");
      if (cmd) return el("code", { class: "need-cmd" }, cmd[1]);
    }
    if (e.kind === "checks") return plural((e.checks || []).length, "command") + " to verify the work";
    return e.quote || e.text;
  }

  function needRow(e) {
    const key = "need:" + e.id;
    const expanded = open.has(key);
    const toggle = () => {
      if (expanded) open.delete(key);
      else open.add(key);
      persist();
      render();
    };
    const quick =
      e.kind === "approval"
        ? el("button", { class: "primary small", title: e.rememberable ? "Run this command once" : "Allow this change", onclick: (ev) => { ev.stopPropagation(); decide(e, { kind: "allow" }); } }, e.rememberable ? "Run" : "Allow")
        : el("button", { class: "ghost small", onclick: toggle }, e.kind === "checks" ? "Review" : "Answer");
    return el(
      "div",
      { class: "need" + (expanded ? " open" : "") },
      el(
        "div",
        { class: "need-row" },
        el("button", { class: "need-main", "aria-expanded": expanded ? "true" : "false", title: expanded ? "Hide" : "Show the whole request", onclick: toggle },
          el("span", { class: "need-chevron", "aria-hidden": "true" }, expanded ? "▾" : "▸"),
          el("span", { class: "need-kind" }, needKind(e)),
          el("span", { class: "need-text" }, needText(e)),
        ),
        expanded ? null : quick,
      ),
      el("div", { class: "need-who muted small" }, e.author === "coordinator" && e.agentName ? `Coordinator, for "${e.agentName}"` : e.agentName || "Coordinator"),
      expanded ? waitingCard(e, "ny") : null,
    );
  }

  function needsYou() {
    if (!state.current || !dash() || tab === "settings") return null;
    const waiting = state.current.entries.filter(isWaiting);
    const draftsWaiting = allChanges().filter((c) => c.state === "draft");
    const awaiting = draftsWaiting.length;
    const conflicts = draftsWaiting.filter((c) => c.conflict).length;
    const draftRow = awaiting && tab !== "changes";
    const total = waiting.length + (draftRow ? 1 : 0);
    if (!total) return null;
    return el(
      "section",
      { class: "needs", "aria-label": "Needs you" },
      el("div", { class: "needs-head" }, el("span", { class: "needs-dot", "aria-hidden": "true" }), el("span", { class: "needs-title" }, "Needs you"), el("span", { class: "badge tone-attention" }, total)),
      waiting.map(needRow),
      draftRow
        ? el(
            "div",
            { class: "need" },
            el(
              "div",
              { class: "need-row" },
              el("button", { class: "need-main", onclick: () => setTab("changes") }, el("span", { class: "need-chevron", "aria-hidden": "true" }, "▸"), el("span", { class: "need-kind" }, "Drafts"), el("span", { class: "need-text" }, plural(awaiting, "draft") + " ready for review" + (conflicts ? ` · ${plural(conflicts, "conflict")}` : ""))),
              el("button", { class: "ghost small", onclick: () => setTab("changes") }, "Review"),
            ),
          )
        : null,
    );
  }

  // ---- Overview ----

  const KIND_TITLE = { analysis: "Project analysis", changes: "Code changes", chat: "Conversation" };

  function stopAll() {
    const stopping = state.busy === "Stopping…";
    return el(
      "button",
      {
        class: "stop-all small",
        disabled: stopping,
        title: "Stop the coordinator and all sub-agents now (Esc). Drafts are kept for review; nothing is written.",
        onclick: () => post({ type: "cancel" }),
      },
      el("span", { class: "stop-square", "aria-hidden": "true" }),
      stopping ? "Stopping…" : "Stop",
    );
  }

  /** One compact block: what the prompt is, how far it got, and what the coordinator is doing. */
  function summaryLine() {
    const d = dash();
    const k = d.counts;
    const busy = !!state.busy;
    const pct = (n) => (k.total ? (100 * n) / k.total : 0) + "%";
    const tally = k.total
      ? [`${k.completed} of ${k.total} done`, k.running ? `${k.running} running` : "", k.queued ? `${k.queued} queued` : "", k.failed ? `${k.failed} failed` : "", k.stopped ? `${k.stopped} stopped` : ""].filter(Boolean).join(" · ")
      : "";
    return el(
      "section",
      { class: "sumline" },
      el(
        "div",
        { class: "sumline-head" },
        el("span", { class: "sumline-title", title: d.kind === "changes" ? "Sub-agents draft changes. Nothing is written until you accept it." : d.kind === "analysis" ? "Read-only: nothing in your project changes." : "" }, KIND_TITLE[d.kind]),
        el("span", { class: "muted small" }, tally),
        el("span", { class: "spacer" }),
        busy ? stopAll() : null,
      ),
      k.total
        ? el(
            "div",
            { class: "progress thin", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(k.total), "aria-valuenow": String(k.completed) },
            el("span", { class: "seg tone-success", style: "width:" + pct(k.completed) }),
            el("span", { class: "seg tone-error", style: "width:" + pct(k.failed + k.stopped) }),
            el("span", { class: "seg tone-info", style: "width:" + pct(k.running) }),
          )
        : null,
      d.finished
        ? null
        : el("div", { class: "coord-line" }, ["thinking", "supervising"].includes(d.coordinator.state) ? el("span", { class: "spinner" }) : el("span", { class: "dot tone-" + COORD_TONE[d.coordinator.state] }), el("span", { class: "coord-who" }, "Coordinator"), el("span", { class: "coord-what" }, d.coordinator.activity)),
      d.finished ? null : liveBox("coordinator"),
    );
  }

  /** Coordinator steps that belong to one sub-agent: shown folded under its task, not in the feed. */
  function isOversight(e) {
    if (!e.taskId) return false;
    return e.kind === "checkin" || e.kind === "consult" || (e.author === "agent" && e.kind === "command");
  }

  const VERIFY_TAGS = ["verifying", "verified", "not verified", "manual review required"];
  function isVerify(e) {
    return e.author === "coordinator" && VERIFY_TAGS.includes(e.tag);
  }

  /** The run the result card is about, once the prompt is dealt with. */
  function resultRunId() {
    if (!dash().finished) return null;
    const o = [...state.current.entries].reverse().find((e) => e.kind === "outcome" || (e.kind === "answer" && e.tag === "final reply"));
    return o ? o.runId : null;
  }

  function feedEntry(e) {
    if (isWaiting(e)) return false;
    if (e.kind === "spawn" || e.kind === "direct") return false;
    if (isOversight(e)) return false;
    if (e.author === "agent") return e.kind === "question" || e.kind === "approval";
    return true;
  }

  function overview() {
    const rr = resultRunId();
    const inResult = (e) => rr && e.runId === rr && (e.kind === "outcome" || isVerify(e) || (e.kind === "answer" && e.tag === "final reply"));
    const entries = state.current.entries.filter((e) => feedEntry(e) && !inResult(e));
    return [
      el("div", { class: "sticky-top" }, summaryLine()),
      el("section", { class: "feed" }, entries.map(message)),
      // A stopped run that ended this prompt offers Resume on its result card instead.
      rr && state.plans[rr] && state.plans[rr].resumable ? null : resumeBanner(),
      resultCard(rr),
    ];
  }

  /** A run VS Code closed under, or one that was stopped, with a button to continue it. */
  function resumeBanner() {
    if (state.busy) return null;
    const runId = Object.keys(state.plans).reverse().find((id) => state.plans[id].resumable);
    if (!runId) return null;
    const plan = state.plans[runId];
    const interrupted = plan.resumable === "interrupted";
    const drafts = (plan.changes || []).filter((c) => c.state === "draft").length;
    return el(
      "section",
      { class: "card finished done-partial", role: "status" },
      el("div", { class: "card-head" }, el("span", { class: "done-icon" }, "■"), el("span", { class: "card-title" }, interrupted ? "Interrupted when VS Code closed" : "Stopped before it was done")),
      el(
        "div",
        { class: "finished-text" },
        `${plural(plan.tasksLeft || 0, "task")} left. Resume continues where it stopped: sub-agents that were cut off pick up from their last step.` + (drafts ? ` ${plural(drafts, "draft")} from before wait under Drafts.` : ""),
      ),
      el(
        "div",
        { class: "row" },
        el("button", { class: "primary", onclick: () => post({ type: "resumeRun", runId }) }, "Resume"),
        drafts ? el("button", { class: "ghost", onclick: () => setTab("changes") }, "Review drafts") : null,
      ),
    );
  }

  // ---- result card: one place for how the prompt ended ----

  const VERDICT = {
    verified: ["success", "✓", "Verified"],
    "manual review required": ["attention", "!", "Manual review"],
    "not verified": ["warning", "!", "Not verified"],
    stopped: ["warning", "■", "Stopped"],
    failed: ["error", "✕", "Failed"],
    finished: ["success", "✓", "Finished"],
    partial: ["warning", "!", "Partly done"],
  };

  function resultCard(runId) {
    const f = dash().finished;
    if (!f) return null;
    const entries = state.current.entries.filter((e) => e.runId === runId);
    const verdictEntry = [...entries].reverse().find((e) => isVerify(e) && e.tag !== "verifying");
    const reply = [...entries].reverse().find((e) => e.kind === "answer" && e.tag === "final reply");
    const vKey = f.status === "stopped" || f.status === "failed" ? f.status : verdictEntry ? verdictEntry.tag : f.status;
    const [tone, icon, label] = VERDICT[vKey] || VERDICT.finished;
    const plan = state.plans[runId] || { tasks: [], changes: [] };
    const failed = plan.tasks.filter((t) => t.status === "failed" || t.status === "cancelled");
    const unfinished = plan.tasks.length - failed.length - plan.tasks.filter((t) => t.status === "done").length;
    const changes = (plan.changes || []).map((c) => ({ ...c, runId }));
    const pending = changes.filter((c) => c.state === "draft");
    const ready = pending.filter((c) => !c.conflict);
    const written = changes.filter((c) => c.state === "applied");
    return el(
      "section",
      { class: "card result tone-border-" + tone, role: "status" },
      el(
        "div",
        { class: "card-head" },
        el("span", { class: "result-icon tone-" + tone }, icon),
        el("span", { class: "card-title" }, "Result"),
        pill(tone, label, verdictEntry ? verdictEntry.text : f.text),
        el("span", { class: "spacer" }),
        el("span", { class: "time" }, timeLabel(f.time)),
      ),
      el(
        "div",
        { class: "muted small" },
        [
          `${plan.tasks.filter((t) => t.status === "done").length} of ${plan.tasks.length} tasks done`,
          failed.length ? `${failed.length} failed: ${failed.map((t) => t.title).join(", ")}` : "",
          unfinished ? `${unfinished} not finished` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      ),
      reply ? markdown(reply.text, "msg-text result-reply") : el("div", { class: "msg-text" }, f.text),
      verdictEntry ? details("rv:" + verdictEntry.id, "How it was verified", el("div", { class: "msg-text small" }, verdictEntry.text)) : null,
      changes.length
        ? el(
            "div",
            { class: "result-drafts" },
            el("div", { class: "row-between" }, el("span", { class: "section-title small" }, pending.length ? `${plural(pending.length, "draft")} to review` : "All drafts decided"), written.length ? el("span", { class: "muted small" }, `${written.length} written`) : null),
            el("ul", { class: "file-rows" }, changes.map((c) => fileRow(c, false))),
          )
        : null,
      el(
        "div",
        { class: "row end wrap" },
        el("button", { class: "ghost", title: "Every step the sub-agents took", onclick: () => post({ type: "runCommand", command: "showTaskLog", runId }) }, "Details"),
        failed.length && f.status !== "stopped" ? el("button", { class: "ghost", title: "Start the failed tasks again; they are told why they failed", onclick: () => post({ type: "runCommand", command: "retryFailed", runId }) }, "Retry failed") : null,
        plan.resumable && !state.busy ? el("button", { class: "ghost", title: "Continue the tasks that were stopped or cut off", onclick: () => post({ type: "resumeRun", runId }) }, "Resume") : null,
        ready.length ? el("button", { class: "primary", title: ready.length < pending.length ? "Drafts with a conflict wait until you pick what to keep" : undefined, onclick: () => post({ type: "review", runId, action: "accept" }) }, ready.length > 1 ? `Accept all ${ready.length}` : "Accept draft") : null,
      ),
    );
  }

  // ---- messages in the activity feed ----

  const STATUS_ICON = { pending: "○", running: "◐", verifying: "◐", awaiting_approval: "!", done: "✓", failed: "✕", cancelled: "■" };

  /** The coordinator's exchanges with one sub-agent, as one folded line under its task. */
  function activityFold(runId, taskId) {
    const items = state.current.entries.filter((e) => e.runId === runId && e.taskId === taskId && isOversight(e) && !isWaiting(e));
    if (items.length === 0) return null;
    const n = (pred) => items.filter(pred).length;
    const checks = n((e) => e.kind === "checkin" && (e.tag === "progress check" || e.tag === "check-in"));
    const notes = n((e) => e.tag === "note from coordinator");
    const asked = n((e) => e.author === "agent" && e.kind === "consult");
    const cmds = n((e) => e.kind === "command");
    const sentBack = n((e) => e.tag === "sent back");
    const lastReview = [...items].reverse().find((e) => ["reviewed", "sent back", "not accepted", "review unavailable"].includes(e.tag));
    const parts = [
      checks ? plural(checks, "check-in") : "",
      notes ? plural(notes, "note") : "",
      asked ? plural(asked, "question") : "",
      cmds ? plural(cmds, "command") : "",
      sentBack ? `sent back ${sentBack === 1 ? "once" : sentBack + "×"}` : "",
    ].filter(Boolean);
    const review = lastReview ? (lastReview.tag === "reviewed" ? el("span", { class: "tone-success" }, " · reviewed ✓") : el("span", { class: "tone-warning" }, " · " + lastReview.tag)) : null;
    return details("act:" + runId + ":" + taskId, el("span", { class: "act-sum" }, "↔ ", parts.join(" · "), review), el("div", { class: "act-items" }, items.map(streamItem)), "fold act");
  }

  function planCard(entry) {
    const plan = state.plans[entry.runId];
    if (!plan) return el("div", { class: "muted" }, "This plan is no longer saved.");
    const rows = plan.tasks.map((t) =>
      el(
        "li",
        { class: "task status-" + t.status, title: t.status.replace("_", " ") },
        el("div", { class: "task-line" },
          el("span", { class: "icon" }, STATUS_ICON[t.status] || "○"),
          el("span", { class: "task-title" }, t.title),
          el("span", { class: "task-meta", title: t.fileScope.join(", ") }, t.fileScope.length ? plural(t.fileScope.length, "file") : "read-only"),
        ),
        activityFold(entry.runId, t.id),
      ),
    );
    const canRun = plan.kind !== "research" && !plan.started && !state.busy;
    return el(
      "div",
      { class: "plan" },
      el("div", { class: "plan-head muted small" }, plan.kind === "research" ? `${plural(plan.tasks.length, "read-only question")}` : `${plural(plan.tasks.length, "task")} in ${plural(plan.waves, "wave")}`),
      el("ol", { class: "tasks" }, rows),
      canRun || (plan.resumable && !state.busy)
        ? el(
            "div",
            { class: "row" },
            canRun ? el("button", { class: "primary", onclick: () => post({ type: "runPlan", runId: entry.runId }) }, "Run it") : null,
            plan.resumable && !state.busy ? el("button", { class: "primary", title: "Continue the tasks that were stopped or cut off", onclick: () => post({ type: "resumeRun", runId: entry.runId }) }, "Resume") : null,
          )
        : null,
    );
  }

  function outcomeActions(entry) {
    const cmd = (command, label, title) => el("button", { class: "ghost", title, onclick: () => post({ type: "runCommand", command, runId: entry.runId }) }, label);
    const o = entry.outcome || { changedFiles: [null], failed: 1 };
    // The text above is how things stood when the run ended; this line is how its drafts stand now.
    const changes = ((state.plans[entry.runId] || {}).changes || []);
    const n = (st) => changes.filter((c) => c.state === st).length;
    const now = changes.length
      ? [n("draft") ? `${n("draft")} awaiting review` : "", n("applied") ? `${n("applied")} accepted and written` : "", n("discarded") ? `${n("discarded")} rejected` : "", n("reverted") ? `${n("reverted")} reverted` : ""].filter(Boolean).join(" · ")
      : "";
    return el(
      "div",
      {},
      now ? el("div", { class: "muted small drafts-now" }, el("span", {}, "Drafts now: " + now), n("draft") ? el("button", { class: "linkish", onclick: () => setTab("changes") }, " Review") : null) : null,
      el("div", { class: "row" }, o.failed ? cmd("retryFailed", "Retry failed tasks", "Start the failed tasks again; they are told why they failed") : null, cmd("showTaskLog", "Details", "Every step the sub-agents took")),
    );
  }

  // ---- markdown ----

  const MD = window.AgenticMarkdown;
  const ALIGN = new Set(["left", "center", "right"]);

  /** A model reply as markdown. Only these fixed tags are made, and all text goes in as text nodes. */
  function markdown(text, cls) {
    if (!MD) return el("div", { class: cls || "msg-text" }, text);
    let tree;
    try {
      tree = MD.parse(text);
    } catch {
      return el("div", { class: cls || "msg-text" }, text);
    }
    return el("div", { class: "md " + (cls || "msg-text") }, tree.map(mdBlock));
  }

  function mdBlock(b) {
    switch (b.t) {
      case "p":
        return el("p", {}, b.c.map(mdInline));
      case "h":
        return el("h" + Math.min(6, Math.max(1, b.level | 0)), { class: "md-h" }, b.c.map(mdInline));
      case "hr":
        return el("hr");
      case "code":
        return codeBox(b.text, b.lang);
      case "quote":
        return el("blockquote", {}, b.c.map(mdBlock));
      case "list":
        return el(
          b.ordered ? "ol" : "ul",
          { start: b.ordered && b.start !== 1 ? String(b.start | 0) : undefined },
          b.items.map((item) => el("li", {}, item.map(mdBlock))),
        );
      case "table":
        return el(
          "div",
          { class: "md-table" },
          el(
            "table",
            {},
            el("thead", {}, el("tr", {}, b.head.map((c, k) => el("th", { class: ALIGN.has(b.align[k]) ? "al-" + b.align[k] : undefined }, c.map(mdInline))))),
            el("tbody", {}, b.rows.map((row) => el("tr", {}, row.map((c, k) => el("td", { class: ALIGN.has(b.align[k]) ? "al-" + b.align[k] : undefined }, c.map(mdInline)))))),
          ),
        );
      default:
        return null;
    }
  }

  const HL = window.AgenticHighlight;

  /** A code block: a box with the language, a Copy button and colored tokens (each one a text node in a span). */
  function codeBox(text, lang) {
    const code = String(text || "");
    const toks = HL ? HL.tokens(code, lang) : [{ k: null, v: code }];
    const name = HL ? HL.label(lang) : lang || "";
    const copy = el("button", { class: "md-copy", title: "Copy the code", "aria-label": "Copy the code" }, "Copy");
    copy.addEventListener("click", () => {
      const done = (ok) => {
        copy.textContent = ok ? "Copied" : "Copy failed";
        setTimeout(() => (copy.textContent = "Copy"), 1500);
      };
      try {
        navigator.clipboard.writeText(code).then(() => done(true), () => done(false));
      } catch {
        done(false);
      }
    });
    return el(
      "div",
      { class: "md-codebox" },
      el("div", { class: "md-codehead" }, el("span", { class: "md-lang" }, name || "code"), el("span", { class: "spacer" }), copy),
      el(
        "pre",
        { class: "md-code" },
        el(
          "code",
          {},
          toks.map((t) => (t.k && HL.KINDS.includes(t.k) ? el("span", { class: "tok-" + t.k }, t.v) : t.v)),
        ),
      ),
    );
  }

  function mdInline(n) {
    switch (n.t) {
      case "text":
        return n.v;
      case "br":
        return el("br");
      case "code":
        return el("code", {}, n.v);
      case "strong":
        return el("strong", {}, n.c.map(mdInline));
      case "em":
        return el("em", {}, n.c.map(mdInline));
      case "del":
        return el("del", {}, n.c.map(mdInline));
      case "link": {
        // The link has no href attribute: the page never navigates. A click asks the extension, which checks the address
        // again and shows a confirmation with the real site and full address before anything opens.
        const url = MD.safeUrl(n.href);
        if (!url) return el("span", {}, n.c.map(mdInline));
        const openIt = (ev) => {
          ev.preventDefault();
          post({ type: "openLink", url });
        };
        return el(
          "a",
          { class: "md-link", role: "link", tabindex: "0", title: url, onclick: openIt, onkeydown: (ev) => (ev.key === "Enter" ? openIt(ev) : undefined) },
          n.c.map(mdInline),
        );
      }
      default:
        return null;
    }
  }

  /** Long text is cut to a summary with the rest behind "Show more". Model text is shown as markdown. */
  function longText(key, text, cls, plain) {
    const t = String(text || "");
    const show = (x) => (plain ? el("div", { class: cls || "msg-text" }, x) : markdown(x, cls));
    const lines = t.split("\n");
    if (t.length <= 420 && lines.length <= 8) return show(t);
    const short = lines.slice(0, 6).join("\n").slice(0, 400);
    return el("div", {}, show(short + "…"), details(key, "Show more", show(t), "fold more"));
  }

  function message(entry) {
    const who = { user: "You", coordinator: "Coordinator", agent: entry.agentName || "Sub-agent", system: "Agentic" }[entry.author];
    const kind = entry.kind || "message";
    let label = who;
    if (kind === "question") label = who + " asks";
    if (kind === "approval") label = who + " asked for permission";
    if (kind === "checks") label = "Coordinator · checks";
    if (kind === "consult") label = entry.author === "agent" ? who + " asks the coordinator" : "Coordinator → " + (entry.agentName || "sub-agent");
    if (kind === "checkin") label = "Coordinator · checked on " + (entry.agentName || "a sub-agent");
    if (kind === "command") label = who + " ran a command";
    if (kind === "question" && entry.author === "coordinator" && entry.agentName) label = "Coordinator asks, for " + entry.agentName;
    return el(
      "div",
      { class: `msg from-${entry.author} ${entry.tone ? "tone-" + entry.tone : ""} kind-${kind}` },
      el("div", { class: "msg-head" }, el("span", { class: "who" }, label), el("span", { class: "spacer" }), el("span", { class: "time" }, timeLabel(entry.time))),
      entry.thought && entry.thought !== entry.text ? el("div", { class: "thought" }, entry.thought) : null,
      entry.quote ? el("div", { class: "quote" }, entry.quote) : null,
      // The answer that combines the research reports is what the user asked for, so it is never folded.
      kind === "answer" ? markdown(entry.text) : longText("x:" + entry.id, entry.text, undefined, entry.author === "user"),
      entry.thinking && String(entry.thinking).trim() ? details("t:" + entry.id, "Thinking", el("pre", { class: "thinking-text" }, entry.thinking)) : null,
      kind === "plan" || kind === "research" ? planCard(entry) : null,
      kind === "outcome" && entry.runId ? outcomeActions(entry) : null,
      kind === "checks" ? checkList(entry) : null,
      commandBlock(entry),
      entry.decided ? el("div", { class: "decided" }, "✓ " + entry.decided) : null,
    );
  }

  /**
   * A command a sub-agent ran, as the terminal shows it: the command, then the
   * end of its output. Both come from the project, so they are only ever text.
   */
  function commandBlock(entry) {
    const c = entry.kind === "command" && entry.command;
    if (!c) return null;
    const out = String(c.output || "").trim();
    const lines = out.split("\n");
    const body = out ? el("pre", { class: "command-output" }, out) : el("div", { class: "muted small" }, "(no output)");
    return el(
      "div",
      { class: "command-run" },
      el("code", { class: "command" }, "$ " + String(c.line || "")),
      // Short output is shown open; long output folds, keeping the chat readable.
      out && lines.length > 12 ? details("co:" + entry.id, "Output (" + lines.length + " lines)", body) : body,
    );
  }

  // ---- Agents ----

  /** How the coordinator kept tabs on its sub-agents, in one line. Nothing when it had nothing to do. */
  function oversightLine(o) {
    if (!o) return null;
    const parts = [
      o.answered ? plural(o.answered, "question") + " answered" : "",
      o.askedYou ? plural(o.askedYou, "question") + " passed to you" : "",
      o.checkIns ? plural(o.checkIns, "check-in") : "",
      o.notes ? plural(o.notes, "note") + " sent" : "",
      o.stopped ? plural(o.stopped, "sub-agent") + " stopped" : "",
    ].filter(Boolean);
    if (parts.length === 0) return null;
    return el("div", { class: "muted small oversight", title: "Sub-agents can ask the coordinator questions, and it checks on any that seem stuck" }, "Keeping tabs: " + parts.join(" · "));
  }

  /** A sub-agent's exchanges with the coordinator, in one line. */
  function exchangeLine(a) {
    const x = a.coordinator;
    if (!x || (!x.questions && !x.notes && !x.stopped && !x.review)) return null;
    const parts = [
      x.questions ? "asked the coordinator " + (x.questions === 1 ? "once" : x.questions + " times") : "",
      x.notes ? plural(x.notes, "note") + " from the coordinator" : "",
      x.stopped ? "stopped by the coordinator" : "",
      x.review === "accepted" ? "result reviewed" : "",
    ].filter(Boolean);
    const line = parts.length ? el("div", { class: "muted small exchange" }, "↔ " + parts.join(" · ")) : null;
    const warning = reviewWarning(x.review);
    if (!warning) return line;
    return line ? el("div", {}, line, warning) : warning;
  }

  /** A result that did not pass review gets its own line: its drafts wait for the user, whatever auto-approve says. */
  function reviewWarning(review) {
    if (review === "unavailable") {
      return el("div", { class: "small exchange review-warning", title: "The coordinator could not review this result. Nothing it drafted is written without you, even with auto-approve on." }, "⚠ Review unavailable: drafts wait for you");
    }
    if (review === "not_accepted") {
      return el("div", { class: "small exchange review-warning", title: "The coordinator found something missing but could not send it back. Nothing it drafted is written without you, even with auto-approve on." }, "⚠ Not accepted by the coordinator's review: drafts wait for you");
    }
    return null;
  }

  function agentKey(a) {
    return a.runId + ":" + a.taskId;
  }

  function miniFile(c) {
    return el(
      "li",
      {},
      el("button", { class: "file-link", title: c.path, onclick: () => post({ type: "review", runId: c.runId, action: "show", path: c.path }) }, baseName(c.path)),
      pill(DRAFT_TONE[c.state], DRAFT_LABEL[c.state]),
      c.state === "applied" && c.revertable ? el("button", { class: "ghost danger small", title: REVERT_TITLE[c.kind], onclick: () => post({ type: "review", runId: c.runId, action: "revert", path: c.path }) }, c.note ? "Revert anyway" : "Revert") : null,
    );
  }

  function openAgent(a) {
    agentView = agentKey(a);
    tab = "agents";
    persist();
    render();
    const main = document.getElementById("main");
    if (main) main.scrollTop = main.scrollHeight;
  }

  function agentDot(s) {
    if (s === "initializing" || s === "working" || s === "verifying" || s === "asking") return el("span", { class: "spinner", "aria-hidden": "true" });
    return el("span", { class: "dot tone-" + (AGENT_TONE[s] || "muted"), "aria-hidden": "true" });
  }

  /** The one line under a sub-agent: what streams from the model right now, or what it did last. */
  function liveLine(a) {
    const item = live[agentKey(a)];
    if (item && item.tail) return item.tail.replace(/\s+/g, " ").trim().slice(-160);
    return a.activity;
  }

  function agentRow(a) {
    const key = "ag:" + agentKey(a);
    const expanded = open.has(key);
    const toggle = () => {
      if (expanded) open.delete(key);
      else open.add(key);
      persist();
      render();
    };
    const mine = allChanges().filter((c) => c.runId === a.runId && c.taskId === a.taskId);
    const files = a.draftFiles ? plural(a.draftFiles, "draft") : a.fileScope.length ? "" : "read-only";
    return el(
      "div",
      { class: "arow state-" + a.state + (expanded ? " open" : "") },
      el(
        "button",
        { class: "arow-main", "aria-expanded": expanded ? "true" : "false", onclick: toggle },
        el("span", { class: "arow-line" }, agentDot(a.state), el("span", { class: "arow-title" }, a.title), a.state === "needs_you" || a.state === "failed" ? pill(AGENT_TONE[a.state], a.label) : null, el("span", { class: "arow-files" + (a.drafts ? " tone-attention" : "") }, files)),
        el("span", { class: "arow-live" + (live[agentKey(a)] ? " is-live" : "") }, liveLine(a)),
      ),
      expanded
        ? el(
            "div",
            { class: "arow-more" },
            el("div", { class: "muted small" }, a.label + " · " + (a.fileScope.length ? "may change " + a.fileScope.join(", ") : "read-only")),
            liveBox(agentKey(a)),
            exchangeLine(a),
            a.report ? details("rp:" + agentKey(a), "Report to the coordinator", longText("rpx:" + agentKey(a), a.report)) : null,
            a.thinking ? details("th:" + agentKey(a), "Latest thinking", el("pre", { class: "thinking-text" }, a.thinking)) : null,
            mine.length ? el("ul", { class: "mini-files" }, mine.map((c) => miniFile(c))) : null,
            el("div", { class: "row end" }, el("button", { class: "ghost small", title: "Open this sub-agent's conversation", onclick: () => openAgent(a) }, "Chat")),
          )
        : null,
    );
  }

  function agentsTab() {
    const d = dash();
    const current = agentView && d.agents.find((a) => agentKey(a) === agentView);
    if (current) return agentConversation(current);
    const groups = [];
    for (const a of d.agents) {
      const g = groups.at(-1);
      if (g && g.runId === a.runId) g.items.push(a);
      else groups.push({ runId: a.runId, research: a.research, items: [a] });
    }
    const c = d.coordinator;
    return [
      el(
        "div",
        { class: "arow coordinator" },
        el("div", { class: "arow-main static" },
          el("span", { class: "arow-line" }, ["thinking", "supervising"].includes(c.state) ? el("span", { class: "spinner" }) : el("span", { class: "dot tone-" + COORD_TONE[c.state] }), el("span", { class: "arow-title" }, "Coordinator"), el("span", { class: "arow-files" }, c.label)),
          el("span", { class: "arow-live" }, c.activity),
        ),
        el("div", { class: "arow-more" }, liveBox("coordinator"), oversightLine(c.oversight)),
      ),
      d.agents.length === 0 ? el("div", { class: "empty" }, "No sub-agents yet. In Act mode the coordinator starts them when your request needs work on the project.") : null,
      groups.map((g, i) =>
        el(
          "div",
          { class: "agent-group" },
          el("div", { class: "group-name" }, (g.research ? "Research" : "Changes") + (i === 0 ? " · latest" : "")),
          g.items.map(agentRow),
        ),
      ),
    ];
  }

  const drafts = {}; // unsent text in inputs, by input id

  /** One sub-agent's own conversation: its steps, its questions and your direct messages to it. */
  function agentConversation(a) {
    const entries = state.current.entries.filter((e) => e.runId === a.runId && e.taskId === a.taskId && e.kind !== "spawn");
    const back = el("button", { class: "ghost back", onclick: () => { agentView = null; persist(); render(); } }, "‹ All agents");
    const id = `m-${a.runId}-${a.taskId}`;
    const reopen = a.reopenable && !a.followUp;
    const placeholder = !a.canMessage
      ? a.followUp === "ending"
        ? "It is passing what it learned to the coordinator…"
        : a.reopenable
          ? "You can talk with it again once its run is done."
          : "It has not started yet, so it cannot get messages."
      : reopen
        ? "Ask a follow-up question to reopen this conversation (Enter to send)"
        : "Message this sub-agent (Enter to send)";
    const input = el("textarea", { id, rows: "2", class: "card-input", placeholder, disabled: !a.canMessage });
    input.value = drafts[id] || "";
    input.addEventListener("input", () => (drafts[id] = input.value));
    const sendIt = () => {
      if (!input.value.trim()) return;
      post({ type: "messageAgent", runId: a.runId, taskId: a.taskId, text: input.value.trim() });
      delete drafts[id];
      input.value = "";
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendIt();
      }
    });
    return [
      el("div", { class: "row" }, back),
      el(
        "div",
        { class: "card agent-card state-" + a.state },
        el("div", { class: "card-head" }, stateIcon(a.state), el("span", { class: "card-title" }, a.title), el("span", { class: "spacer" }), pill(AGENT_TONE[a.state], a.label)),
        el("div", { class: "activity" }, a.activity),
        liveBox(agentKey(a)),
        el("div", { class: "muted small", title: a.fileScope.join(", ") }, a.fileScope.length ? "May change: " + a.fileScope.join(", ") : "Read-only: it may not change any files."),
      ),
      el(
        "div",
        { class: "stream" },
        entries.length === 0 ? el("div", { class: "empty" }, "Nothing yet.") : null,
        entries.map((e) => (isWaiting(e) ? waitingCard(e, "ag") : streamItem(e))),
      ),
      a.reopenable
        ? el(
            "div",
            { class: "muted small follow-note" },
            a.followUp
              ? "This conversation is open again. Edits stay drafts for your review, as usual. When you are done, press End chat (or message the coordinator) and it sends what is new to the coordinator."
              : "Its task has ended. Send a message to reopen the conversation: it remembers its work and can answer, look again or draft more changes for your review.",
          )
        : null,
      el(
        "div",
        { class: "agent-input" },
        input,
        el(
          "div",
          { class: "row end" },
          a.followUp
            ? el(
                "button",
                { class: "ghost", disabled: a.followUp === "ending", title: "Close this conversation and send what is new to the coordinator", onclick: () => post({ type: "endAgentChat", runId: a.runId, taskId: a.taskId }) },
                "End chat and update coordinator",
              )
            : null,
          el("button", { class: "primary", disabled: !a.canMessage, onclick: sendIt }, reopen ? "Reopen and send" : "Send"),
        ),
      ),
    ];
  }

  function streamItem(e) {
    const mine = e.author === "user";
    const coord = e.author === "coordinator";
    const tag = mine ? "You" : e.kind === "report" ? "Report" : coord ? "Coordinator · " + (e.tag || "message") : e.tag || e.kind || "step";
    return el(
      "div",
      { class: "step" + (mine ? " from-user" : "") + (coord ? " from-coordinator" : "") + (e.tone ? " tone-" + e.tone : "") },
      el("div", { class: "step-head" }, el("span", { class: "step-tag" }, tag), el("span", { class: "spacer" }), el("span", { class: "time" }, timeLabel(e.time))),
      e.thought && e.thought !== e.text ? el("div", { class: "thought" }, e.thought) : null,
      coord && e.quote ? el("div", { class: "quote" }, e.quote) : null,
      longText("s:" + e.id, e.text, undefined, mine),
      commandBlock(e),
      e.thinking ? details("t:" + e.id, "Thinking", el("pre", { class: "thinking-text" }, e.thinking)) : null,
      e.decided ? el("div", { class: "decided" }, "✓ " + e.decided) : null,
    );
  }

  // ---- Changes: every drafted file in the conversation, one row each ----

  function review(c, action, choice) {
    post({ type: "review", runId: c.runId, action, path: c.path, choice });
  }

  /** Why a conflicted draft waits, in words. */
  function conflictText(c) {
    const where = c.conflict.regions === 1 ? "one place" : `${c.conflict.regions} places`;
    return c.conflict.with === "disk"
      ? `Conflict: this file changed on disk after "${c.agentName}" read it, and both changed the same lines in ${where}. Nothing was written. Pick what to keep.`
      : `Conflict: "${c.conflict.otherAgent}" and "${c.agentName}" changed the same lines in ${where}. Both drafts are kept. Pick what to keep.`;
  }

  /** The choices for a conflicted draft. Each one leaves a draft to Accept, except keeping your file, which rejects the draft. */
  function conflictButtons(c) {
    const disk = c.conflict.with === "disk";
    return [
      el("button", { class: "ghost", title: "Open both versions side by side", onclick: () => review(c, "show") }, "Compare"),
      el("button", { class: "ghost", title: disk ? "Keep the file as it is on disk and reject this draft" : `Use the draft by "${c.conflict.otherAgent}" and drop the other one`, onclick: () => review(c, "resolve", "other") }, disk ? "Keep my file" : `Keep "${c.conflict.otherAgent}"`),
      el("button", { class: "ghost", title: disk ? "Use the draft instead of the newer file on disk" : `Use the draft by "${c.agentName}" and drop the other one`, onclick: () => review(c, "resolve", "draft") }, disk ? "Keep the draft" : `Keep "${c.agentName}"`),
      el(
        "button",
        {
          class: "primary",
          title: "Keep both versions with <<<<<<< / >>>>>>> markers around each conflict. After you accept, VS Code shows Accept Current / Accept Incoming above each one.",
          onclick: () => review(c, "resolve", "both"),
        },
        "Keep both",
      ),
    ];
  }


  function fileRow(c, showAgent) {
    const isNew = c.kind === "new";
    const pending = c.state === "draft";
    const conflict = pending && c.conflict;
    return el(
      "li",
      { class: "frow state-" + c.state + (conflict ? " has-conflict" : "") },
      el(
        "div",
        { class: "frow-line" },
        el("span", { class: "file-icon", "aria-hidden": "true" }, isNew ? "+" : "‹›"),
        el("button", { class: "file-link frow-name", title: (isNew ? "Open the drafted new file: " : "Open the side-by-side diff: ") + c.path, onclick: () => review(c, "show") }, baseName(c.path)),
        el("span", { class: "counts" }, c.added ? el("span", { class: "add" }, "+" + c.added) : null, c.removed ? el("span", { class: "del" }, "−" + c.removed) : null),
        el("span", { class: "spacer" }),
        conflict ? pill("attention", "Conflict") : null,
        pending ? el("button", { class: "icon-btn danger", title: "Reject: discard this draft. Nothing is written.", "aria-label": "Reject " + c.path, onclick: () => review(c, "reject") }, "✕") : null,
        pending && !conflict ? el("button", { class: "icon-btn accept", title: c.note ? "Accept anyway: " + c.note : "Accept: write this draft to your project", "aria-label": "Accept " + c.path, onclick: () => review(c, "accept") }, "✓") : null,
        c.state === "applied" && c.revertable ? el("button", { class: "ghost small", title: REVERT_TITLE[c.kind], onclick: () => review(c, "revert") }, c.note ? "Revert anyway" : "Revert") : null,
        pending ? null : pill(DRAFT_TONE[c.state], c.state === "applied" && c.auto ? "Accepted (auto)" : DRAFT_LABEL[c.state]),
      ),
      el("div", { class: "frow-sub muted small", title: c.path }, [dirName(c.path) ? dirName(c.path) + "/" : "", showAgent ? c.agentName : ""].filter(Boolean).join(" · ")),
      c.combinedWith && c.combinedWith.length ? el("div", { class: "frow-sub muted small" }, "Combined with the draft by " + c.combinedWith.map((n) => `"${n}"`).join(", ")) : null,
      c.combinedWithDisk ? el("div", { class: "frow-sub muted small" }, "Combined with your newer file on disk") : null,
      conflict ? el("div", { class: "note tone-warning small" }, conflictText(c)) : c.note ? el("div", { class: "note tone-warning small" }, c.note) : null,
      pending && c.markers ? el("div", { class: "note tone-warning small" }, "Has conflict markers. After you accept, VS Code shows Accept Current / Accept Incoming above each one, or edit the file by hand.") : null,
      conflict ? el("div", { class: "row end conflict-actions" }, conflictButtons(c)) : null,
    );
  }

  function changesTab() {
    const changes = allChanges();
    const pending = changes.filter((c) => c.state === "draft");
    const accepted = changes.filter((c) => c.state === "applied");
    const rejected = changes.filter((c) => c.state === "discarded");
    const reverted = changes.filter((c) => c.state === "reverted");
    const seg = (by, label) => el("button", { class: "seg-btn" + (filesBy === by ? " on" : ""), "aria-pressed": filesBy === by ? "true" : "false", onclick: () => { filesBy = by; persist(); render(); } }, label);
    const list = (items) => {
      if (filesBy === "file") return el("ul", { class: "file-rows" }, items.map((c) => fileRow(c, true)));
      const groups = new Map();
      for (const c of items) {
        const key = c.runId + ":" + c.taskId;
        if (!groups.has(key)) groups.set(key, { name: c.agentName, items: [] });
        groups.get(key).items.push(c);
      }
      return [...groups.values()].map((g) => el("div", { class: "agent-group" }, el("div", { class: "group-name" }, g.name), el("ul", { class: "file-rows" }, g.items.map((c) => fileRow(c, false)))));
    };
    const runsWithPending = [...new Set(pending.map((c) => c.runId))];
    const all = (action) => runsWithPending.forEach((runId) => post({ type: "review", runId, action }));
    // Conflicts wait for a pick, so Accept all leaves them out.
    const ready = pending.filter((c) => !c.conflict).length;
    const conflicts = pending.length - ready;
    const group = (title, tone, items, extra) =>
      items.length ? el("div", { class: "fgroup" }, el("div", { class: "section-head" }, el("span", { class: "section-title" }, title), pill(tone, String(items.length)), el("span", { class: "spacer" }), extra), list(items)) : null;
    return [
      changes.length
        ? el("div", { class: "row-between" }, el("span", { class: "muted small" }, "Nothing is written until you accept it. Click a file for its diff."), el("div", { class: "segmented small" }, seg("file", "Files"), seg("agent", "By agent")))
        : el("div", { class: "empty" }, "No changes yet. When a sub-agent drafts a change, it shows here for review."),
      group("To review", "attention", pending, pending.length ? el("span", { class: "row" }, el("button", { class: "ghost danger small", onclick: () => all("reject") }, "Reject all"), ready ? el("button", { class: "primary small", title: conflicts ? "Drafts with a conflict wait until you pick what to keep" : undefined, onclick: () => all("accept") }, ready === pending.length ? "Accept all" : `Accept ${ready}`) : null) : null),
      group("Written to your project", "success", accepted),
      rejected.length ? details("decided", `Rejected · ${rejected.length}`, list(rejected), "fold decided-group") : null,
      reverted.length ? details("reverted", `Reverted · ${reverted.length}`, list(reverted), "fold decided-group") : null,
    ];
  }

  // ---- Checks ----

  function checkList(entry) {
    return (entry.checks || []).length
      ? el("ul", { class: "check-list" }, entry.checks.map((c) => el("li", {}, el("span", { class: "check-name" }, c.name), el("code", {}, c.command))))
      : el("div", { class: "muted small" }, "No checks.");
  }

  const PERMS = [
    ["editFiles", "File edits", "Sub-agents' drafts are written to your project without review. Ask first: each draft waits for your Accept."],
    ["sensitiveFiles", "Sensitive files", "The same for package.json files, lockfiles, CI, dev containers, git hooks and .vscode files."],
    ["commands", "Commands", "Check commands (tests, lint, ...) run without asking. Ask first: each command is shown to you and only runs if you approve it. Commands run as you, so they can read files elsewhere and use the network."],
  ];

  function segRow(label, help, options, current, onPick) {
    return el(
      "div",
      { class: "perm-row", title: help },
      el("span", { class: "perm-label" }, label),
      el("span", { class: "spacer" }),
      el(
        "span",
        { class: "segmented small", role: "radiogroup", "aria-label": label },
        options.map(([value, text, warn]) => el("button", { class: "seg-btn" + (current === value ? " on" + (warn ? " warn" : "") : ""), role: "radio", "aria-checked": current === value ? "true" : "false", onclick: () => current !== value && onPick(value) }, text)),
      ),
    );
  }

  const CHECKS_EXPLAINED =
    "Checks are commands such as tests, lint or a type check. After a sub-agent finishes, they run on a scratch copy of the project with its drafts, so your files are not touched. If one fails, the sub-agent gets the error and fixes its work. Each command asks before it runs unless Commands is set to Auto under Settings.";

  const OVERSIGHT = [
    ["off", "Off", "No check-ins, reviews or verification. Changes still wait for your review."],
    ["light", "Light", "Looks once at a stuck sub-agent. No result reviews. Verifies with one fix-up round."],
    ["standard", "Standard", "Looks at progress every 8 steps, reviews each result once, verifies with up to two fix-up rounds."],
    ["thorough", "Thorough", "Progress every 4 steps, results sent back up to twice, up to four fix-up rounds. The most model calls."],
  ];

  function settingsView() {
    const p = state.permissions || {};
    const level = state.oversight || "standard";
    const entries = state.current.entries;
    const lastChecks = [...entries].reverse().find((e) => e.kind === "checks" && !isWaiting(e));
    const results = entries.filter((e) => e.author === "agent" && e.tag === "checks").slice(-5).reverse();
    return [
      el("div", { class: "row" }, el("button", { class: "ghost back", onclick: () => setTab("overview") }, "‹ Back")),
      el(
        "section",
        { class: "card perms" },
        el("div", { class: "card-head" }, el("span", { class: "card-title" }, "Oversight")),
        el("div", { class: "muted small" }, "How closely the coordinator watches, reviews and verifies its sub-agents. Higher levels make more model calls."),
        el("div", { class: "segmented wide", role: "radiogroup", "aria-label": "Oversight level" }, OVERSIGHT.map(([v, label]) => el("button", { class: "seg-btn" + (level === v ? " on" : ""), role: "radio", "aria-checked": level === v ? "true" : "false", onclick: () => post({ type: "setOversight", level: v }) }, label))),
        el("div", { class: "small level-help" }, OVERSIGHT.find(([v]) => v === level)[2]),
      ),
      el(
        "section",
        { class: "card perms" },
        el("div", { class: "card-head" }, el("span", { class: "card-title" }, "Auto-approval")),
        PERMS.map(([key, label, help]) => segRow(label, help, [[false, "Ask first"], [true, "Auto", true]], !!p[key], (value) => post({ type: "setPermission", key, value }))),
        el("div", { class: "muted small" }, "Saved in your user settings. Agents can never reach files outside this folder, .git or secrets."),
      ),
      el(
        "section",
        { class: "card perms" },
        el("div", { class: "card-head" }, el("span", { class: "card-title" }, "Checks for this folder"), el("span", { class: "spacer" }), el("button", { class: "ghost small", disabled: !!state.busy, onclick: () => post({ type: "editChecks" }) }, lastChecks ? "Edit" : "Set up")),
        lastChecks ? checkList(lastChecks) : el("div", { class: "muted small" }, "None yet. The first plan that runs here proposes commands found in the project."),
        results.length ? details("ck-results", "Recent results", el("ul", { class: "results" }, results.map((e) => el("li", { class: "tone-" + (e.tone || "info") }, el("span", { class: "result-icon" }, e.tone === "success" ? "✓" : "!"), el("span", { class: "result-text" }, e.agentName + ": " + e.text))))) : null,
      ),
      el("div", { class: "row end" }, el("button", { class: "linkish small", onclick: () => post({ type: "settings" }) }, "All settings…")),
    ];
  }

  // ---- cards that wait for the user ----

  function decide(entry, decision) {
    post({ type: "decide", entryId: entry.id, decision });
  }

  function waitingCard(entry, scope) {
    const who = entry.agentName || "Coordinator";
    let title = "Question";
    let body;
    if (entry.kind === "checks") {
      title = "Checks to verify the work";
      body = [el("div", { class: "muted small" }, CHECKS_EXPLAINED), checksForm(entry, scope)];
    } else if (entry.kind === "approval") {
      const cmd = /`([^`]+)`/.exec(entry.text || "");
      title = entry.rememberable ? "Command" : "Permission";
      body = [
        cmd ? el("code", { class: "command" }, cmd[1]) : null,
        // A permission request is shown exactly as written, so nothing in it can be hidden by formatting.
        longText("ap:" + entry.id, entry.text, "msg-text small", true),
        entry.preview ? el("pre", { class: "change-preview" }, entry.preview) : null,
        el(
          "div",
          { class: "row end wrap" },
          el("button", { class: "ghost danger", onclick: () => decide(entry, { kind: "deny" }) }, "Reject"),
          entry.rememberable ? el("button", { class: "ghost", onclick: () => decide(entry, { kind: "allow", remember: true }) }, entry.rememberLabel || "Allow and remember") : null,
          el("button", { class: "primary", onclick: () => decide(entry, { kind: "allow" }) }, entry.rememberable ? "Approve and run" : "Allow"),
        ),
      ];
    } else {
      body = [
        entry.quote ? el("div", { class: "quote" }, entry.quote) : null,
        longText("q:" + entry.id, entry.text),
        answerBox(entry, scope),
      ];
    }
    return el(
      "div",
      { class: "card waiting" },
      el("div", { class: "card-head" }, el("span", { class: "card-title" }, title), el("span", { class: "spacer" }), pill("attention", "Approval required")),
      el(
        "div",
        { class: "muted small" },
        entry.kind === "checks"
          ? "Proposed by the coordinator"
          : entry.author === "coordinator" && entry.agentName
            ? `The coordinator could not answer "${entry.agentName}" from what it knows, so it asks you. Your answer goes to the sub-agent.`
            : "Requested by " + who,
      ),
      body,
    );
  }

  function answerBox(entry, scope) {
    const id = scope + "-q-" + entry.id;
    const ta = el("textarea", { id, rows: "2", class: "card-input", placeholder: "Your answer (Enter to send)" });
    ta.value = drafts["q-" + entry.id] || "";
    const sendIt = () => {
      const text = ta.value.trim();
      if (!text) return;
      delete drafts["q-" + entry.id];
      decide(entry, { kind: "answer", text });
    };
    ta.addEventListener("input", () => (drafts["q-" + entry.id] = ta.value));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendIt();
      }
    });
    return el("div", {}, ta, el("div", { class: "row end" }, el("button", { class: "primary", onclick: sendIt }, "Answer")));
  }

  const checkDrafts = {}; // editable check lists, by entry id

  function checksForm(entry, scope) {
    const list = (checkDrafts[entry.id] ||= {
      rows: (entry.checks || []).map((c) => ({ on: true, name: c.name, command: c.command, source: c.source })),
      remember: true,
    });
    const rows = list.rows.map((r, i) =>
      el(
        "div",
        { class: "check-row" },
        el("input", { type: "checkbox", checked: r.on, title: "Use this check", onchange: (e) => (r.on = e.target.checked) }),
        el("div", { class: "check-fields" },
          el("input", { id: `${scope}-cn-${entry.id}-${i}`, class: "check-name-input", value: r.name, placeholder: "Name, e.g. test", "aria-label": "Check name", oninput: (e) => (r.name = e.target.value) }),
          el("input", { id: `${scope}-cc-${entry.id}-${i}`, class: "check-cmd", value: r.command, placeholder: "Command, e.g. npm test", "aria-label": "Command to run", title: r.source ? "Suggested from " + r.source : "", oninput: (e) => (r.command = e.target.value) }),
        ),
        el("button", { class: "icon-btn", title: "Remove", onclick: () => { list.rows.splice(i, 1); render(); } }, "✕"),
      ),
    );
    return el(
      "div",
      {},
      rows,
      el(
        "div",
        { class: "row wrap" },
        el("button", { class: "ghost", onclick: () => { list.rows.push({ on: true, name: "", command: "" }); render(); } }, "+ Add a command"),
        el("label", { class: "remember" }, el("input", { type: "checkbox", checked: list.remember, onchange: (e) => (list.remember = e.target.checked) }), " Remember for this folder"),
      ),
      el(
        "div",
        { class: "row end wrap" },
        el("button", { class: "ghost", onclick: () => decide(entry, { kind: "skip" }) }, "Run without checks"),
        el("button", { class: "primary", onclick: () => decide(entry, { kind: "checks", remember: list.remember, checks: list.rows.filter((r) => r.on && r.name.trim() && r.command.trim()).map((r) => ({ name: r.name, command: r.command })) }) }, "Use these checks"),
      ),
    );
  }

  // ---- prompt, fixed at the bottom ----

  function composer() {
    const busy = !!state.busy;
    const plan = state.mode === "plan";
    const ta = el("textarea", {
      id: "input",
      rows: "3",
      "aria-label": "Message to the coordinator",
      placeholder: plan ? "Describe what you want. Plan mode only discusses and plans; nothing runs." : "Describe what you want the coordinator to do…",
      disabled: busy,
    });
    ta.value = draft;
    ta.addEventListener("input", () => {
      draft = ta.value;
      persist();
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send(ta);
      }
    });
    const modeToggle = el(
      "span",
      { class: "segmented", role: "radiogroup", "aria-label": "Mode" },
      ["plan", "act"].map((m) =>
        el(
          "button",
          {
            class: "seg-btn" + (state.mode === m ? " on" : ""),
            role: "radio",
            "aria-checked": state.mode === m ? "true" : "false",
            title: m === "plan" ? "Plan: discuss and plan. Nothing runs and nothing is drafted." : "Act: sub-agents carry out plans. Changes are drafts until you accept them.",
            onclick: () => state.mode !== m && post({ type: "setMode", mode: m }),
          },
          m === "plan" ? "Plan" : "Act",
        ),
      ),
    );
    const perms = state.permissions || {};
    const on = PERMS.filter(([k]) => perms[k]).map(([, label]) => label);
    const chips = attachments.length
      ? el(
          "div",
          { class: "chips" },
          attachments.map((p) =>
            el("span", { class: "chip", title: p }, baseName(p), el("button", { class: "chip-x", title: "Remove", "aria-label": "Remove " + p, onclick: () => { attachments = attachments.filter((x) => x !== p); persist(); render(); } }, "×")),
          ),
        )
      : null;
    return el(
      "footer",
      { class: "composer" },
      chips,
      ta,
      el(
        "div",
        { class: "composer-row" },
        modeToggle,
        el("span", { class: "mode-hint" }, plan ? "Nothing runs" : "Changes are drafts"),
        el("span", { class: "spacer" }),
        el("button", { class: "icon-btn", title: "Attach files from this project (their paths go to the coordinator)", "aria-label": "Attach files", disabled: busy, onclick: () => post({ type: "attach" }) }, "📎"),
        // While busy, Stop all sits in the execution summary above (and Esc works anywhere).
        busy && !state.current ? stopAll() : el("button", { class: "primary send", disabled: busy, title: busy ? "Wait for the current request, or press Stop all" : "Send (Enter)", onclick: () => send(ta) }, "Send ↑"),
      ),
      el(
        "div",
        { class: "composer-foot" },
        el("span", { class: "model", title: state.model }, state.model || ""),
        el("span", { class: "spacer" }),
        el("button", { class: "linkish small", title: "Auto-approval permissions", onclick: () => { if (state.current) setTab("settings"); else post({ type: "settings" }); } }, on.length ? "Auto: " + on.join(", ") : "Nothing auto-approved"),
      ),
    );
  }

  function send(ta) {
    const text = ta.value.trim();
    if (!text || state.busy) return;
    post({ type: "send", text, attachments });
    ta.value = "";
    draft = "";
    attachments = [];
    persist();
  }

  // ---- welcome ----

  function welcome() {
    const recent = state.conversations.slice(0, 5);
    return el(
      "div",
      { class: "welcome" },
      el("h2", {}, "New agentic task"),
      el("p", { class: "muted" }, "The coordinator talks with you and splits the work into small tasks. Every change is drafted by a sub-agent that may only touch its own files. Nothing is written to your project until you accept the draft."),
      el("p", { class: "muted" }, el("b", {}, "Plan"), " discusses and proposes a plan. ", el("b", {}, "Act"), " runs it. Questions about the project are answered by read-only research sub-agents."),
      recent.length
        ? el(
            "div",
            { class: "recent" },
            el("div", { class: "section-title" }, "Recent"),
            recent.map((c) =>
              el(
                "div",
                { class: "recent-item" },
                el("button", { class: "linkish", onclick: () => post({ type: "open", id: c.id }), title: c.workspaceRoot }, el("span", { class: "recent-title" }, c.title), el("span", { class: "muted small" }, ` ${folderName(c.workspaceRoot)} · ${timeLabel(c.updatedAt)}`)),
                el("button", { class: "icon-btn", title: "Delete conversation", onclick: () => post({ type: "delete", id: c.id }) }, "✕"),
              ),
            ),
          )
        : null,
    );
  }

  // ---- render ----

  function body() {
    if (!state.current || !dash()) return welcome();
    if (tab === "agents") return agentsTab();
    if (tab === "changes") return changesTab();
    if (tab === "settings") return settingsView();
    return overview();
  }

  function render() {
    if (!state) return;
    const old = document.getElementById("main");
    const nearBottom = !old || old.scrollHeight - old.scrollTop - old.clientHeight < 60;
    const oldScroll = old ? old.scrollTop : 0;
    const oldTab = old ? old.dataset.tab : null;
    const active = document.activeElement;
    const focusedId = active && active.id ? active.id : null;
    const caret = focusedId && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;

    const showTabs = !!(state.current && dash());
    const main = el("main", { id: "main", class: "main", "data-tab": showTabs ? tab : "welcome" }, body());
    app.replaceChildren(...[header(), showTabs && tab !== "settings" ? tabs() : null, showTabs ? needsYou() : null, main, composer()].filter(Boolean));

    // The activity feed and agent conversations follow new messages; other tabs keep their place.
    const follow = (tab === "overview" || (tab === "agents" && agentView)) && nearBottom;
    if (oldTab === main.dataset.tab) main.scrollTop = follow ? main.scrollHeight : oldScroll;
    // A new view (or the page just loaded): a chat-like view opens at its latest message.
    else if (followsLatest()) main.scrollTop = main.scrollHeight;
    const again = focusedId && document.getElementById(focusedId);
    if (again && !again.disabled) {
      again.focus();
      if (caret && typeof again.setSelectionRange === "function") again.setSelectionRange(caret[0], caret[1]);
    }
  }

  // Esc stops the work, like Stop all.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state && state.busy && state.busy !== "Stopping…" && !e.defaultPrevented) {
      e.preventDefault();
      post({ type: "cancel" });
    }
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg && msg.type === "state") {
      const before = state && state.current ? state.current.id : null;
      state = msg.state;
      live = (state && state.live) || {};
      // Another conversation: start on its Overview.
      if (before && (!state.current || state.current.id !== before)) {
        tab = "overview";
        agentView = null;
        persist();
      }
      render();
    } else if (msg && msg.type === "live") {
      live = msg.live && typeof msg.live === "object" ? msg.live : {};
      patchLive();
    } else if (msg && msg.type === "focusInput") {
      document.getElementById("input")?.focus();
    } else if (msg && msg.type === "attached" && Array.isArray(msg.paths)) {
      attachments = [...new Set([...attachments, ...msg.paths.filter((p) => typeof p === "string")])].slice(0, 20);
      persist();
      render();
    }
  });

  post({ type: "ready" });
})();
