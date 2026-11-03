// Chat sidebar page. Renders state from the extension and sends user actions back.
// Everything from the model is inserted as text, never as HTML.
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const saved = vscode.getState() || {};
  let state = null;
  let draft = typeof saved.draft === "string" ? saved.draft : "";

  const STATUS_ICON = {
    pending: "○",
    running: "◐",
    verifying: "⚗",
    awaiting_approval: "?",
    done: "✓",
    failed: "✕",
    cancelled: "⊘",
  };

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children.flat()) {
      if (c === undefined || c === null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function post(msg) {
    vscode.postMessage(msg);
  }

  function saveDraft(value) {
    draft = value;
    persist();
  }

  function timeLabel(iso) {
    const d = new Date(iso);
    const today = new Date();
    return d.toDateString() === today.toDateString()
      ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function folderName(p) {
    return (p || "").split(/[\\/]/).filter(Boolean).pop() || p;
  }

  // ---- header: mode toggle and conversation switcher ----

  function header() {
    const mode = state.mode;
    const toggle = el(
      "div",
      { class: "mode-toggle", role: "radiogroup", "aria-label": "Mode" },
      ["plan", "act"].map((m) =>
        el(
          "button",
          {
            class: "mode " + (mode === m ? "on" : ""),
            role: "radio",
            "aria-checked": mode === m ? "true" : "false",
            title: m === "plan" ? "Plan: discuss and plan. Nothing runs." : "Act: sub-agents carry out plans.",
            onclick: () => mode !== m && post({ type: "setMode", mode: m }),
          },
          m === "plan" ? "Plan" : "Act",
        ),
      ),
    );

    const select = el(
      "select",
      {
        class: "history",
        title: "Switch conversation",
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
    return el("div", { class: "header" }, toggle, select);
  }

  // ---- input box (top, as in the sketch) ----

  function inputBox() {
    const busy = !!state.busy;
    const ta = el("textarea", {
      id: "input",
      rows: "4",
      placeholder:
        state.mode === "plan"
          ? "Describe what you want. Plan mode only discusses and plans. (Enter to send, Shift+Enter for a new line)"
          : "Tell the coordinator what to do. Sub-agents do the work. (Enter to send, Shift+Enter for a new line)",
      disabled: busy,
    });
    ta.value = draft;
    ta.addEventListener("input", () => saveDraft(ta.value));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send(ta);
      }
    });
    const actions = el(
      "div",
      { class: "input-actions" },
      el("span", { class: "hint mode-" + state.mode }, state.mode === "plan" ? "Plan mode" : "Act mode"),
      el("span", { class: "model", title: "Model used for the next message. Change it in settings (green dot)." }, state.model || ""),
      el("span", { class: "spacer" }),
      busy ? stopButton() : el("button", { class: "primary", onclick: () => send(ta) }, "Send"),
    );
    return el("div", { class: "input-box" }, ta, actions);
  }

  // Stops the coordinator and every sub-agent. Drafts stay pending for review; nothing is written.
  function stopButton() {
    const stopping = state.busy === "Stopping…";
    return el(
      "button",
      {
        class: "stop",
        disabled: stopping,
        title: "Stop the coordinator and all sub-agents now (Esc). Drafts are kept for review; nothing is written.",
        onclick: () => post({ type: "cancel" }),
      },
      stopping ? "Stopping…" : "■ Stop",
    );
  }

  function send(ta) {
    const text = ta.value.trim();
    if (!text || state.busy) return;
    post({ type: "send", text });
    ta.value = "";
    saveDraft("");
  }

  // ---- messages ----

  function planCard(entry) {
    const plan = state.plans[entry.runId];
    if (!plan) return el("div", { class: "muted" }, "This plan is no longer saved.");
    const rows = plan.tasks.map((t) =>
      el(
        "li",
        { class: "task status-" + t.status, title: t.status.replace("_", " ") },
        el("span", { class: "icon" }, STATUS_ICON[t.status] || "○"),
        el(
          "div",
          { class: "task-body" },
          el("div", { class: "task-title" }, t.title),
          el(
            "div",
            { class: "task-meta" },
            t.fileScope.length ? t.fileScope.join(", ") : "read-only",
            t.dependsOn.length ? ` · after ${t.dependsOn.join(", ")}` : "",
          ),
        ),
      ),
    );
    const canRun = plan.kind !== "research" && !plan.started && !state.busy;
    return el(
      "div",
      { class: "plan" },
      el(
        "div",
        { class: "plan-head" },
        plan.kind === "research"
          ? `${plan.tasks.length} read-only research question(s)`
          : `${plan.tasks.length} sub-agent task(s) in ${plan.waves} wave(s)`,
      ),
      el("ol", { class: "tasks" }, rows),
      canRun
        ? el(
            "div",
            { class: "row" },
            el(
              "button",
              { class: "primary", onclick: () => post({ type: "runPlan", runId: entry.runId }) },
              "Run it",
            ),
          )
        : null,
    );
  }

  function outcomeActions(entry) {
    const cmd = (command, label, cls, title) =>
      el("button", { class: cls || "secondary", title, onclick: () => post({ type: "runCommand", command, runId: entry.runId }) }, label);
    // Older summaries have no outcome details; show the full set for them.
    const o = entry.outcome || { changedFiles: [null], failed: 1 };
    return el(
      "div",
      { class: "row" },
      o.failed ? cmd("retryFailed", "Retry failed tasks", "secondary", "Start the failed tasks again; they are told why they failed") : null,
      cmd("showTaskLog", "Details", "secondary", "Every step the sub-agents took"),
    );
  }

  // ---- review of pending file changes: nothing is written until Accept ----

  const STATUS_LABEL = { pending: "waiting for you", accepted: "written", rejected: "rejected" };

  function reviewCard(entry) {
    const plan = state.plans[entry.runId];
    const rows = plan ? plan.changes.filter((c) => !entry.taskId || c.taskId === entry.taskId) : [];
    if (rows.length === 0) return el("div", { class: "muted" }, "These changes are no longer saved.");
    const review = (action, path) => post({ type: "review", runId: entry.runId, action, path, taskId: entry.taskId });
    const list = el(
      "ul",
      { class: "changes" },
      ...rows.map((c) =>
        el(
          "li",
          { class: "change status-" + c.status },
          el("div", { class: "change-head" },
            el("button", { class: "link", title: c.kind === "new" ? "Open the new file" : "Open the side-by-side diff", onclick: () => review("show", c.path) }, c.path),
            el("span", { class: "tag" }, c.kind === "new" ? "new file" : "edit"),
            el("span", { class: "muted" }, c.status === "accepted" && c.auto ? "written (auto-approved)" : STATUS_LABEL[c.status]),
          ),
          c.note ? el("div", { class: "change-note" }, c.note) : null,
          c.status === "pending"
            ? el("div", { class: "row" },
                el("button", { class: "secondary", onclick: () => review("show", c.path) }, c.kind === "new" ? "Show" : "Show diff"),
                el("button", { class: "primary", onclick: () => review("accept", c.path) }, c.note ? "Accept anyway" : "Accept"),
                el("button", { class: "secondary", onclick: () => review("reject", c.path) }, "Reject"),
              )
            : null,
        ),
      ),
    );
    const pending = rows.filter((c) => c.status === "pending").length;
    return el(
      "div",
      { class: "review" },
      list,
      pending > 1
        ? el("div", { class: "row" },
            el("button", { class: "primary", onclick: () => review("accept") }, `Accept all ${pending}`),
            el("button", { class: "secondary", onclick: () => review("reject") }, "Reject all"),
          )
        : null,
    );
  }

  // Which collapsible parts are open, so re-rendering does not close them.
  const open = new Set(Array.isArray(saved.open) ? saved.open : []);
  let agentsCollapsed = !!saved.agentsCollapsed;
  let filesCollapsed = !!saved.filesCollapsed;
  let filesBy = saved.filesBy === "agent" ? "agent" : "file";

  function persist() {
    vscode.setState({ draft, open: [...open].slice(-50), agentsCollapsed, filesCollapsed, filesBy, permsOpen });
  }

  function details(key, label, body, cls) {
    const d = el("details", { class: cls || "thinking", open: open.has(key) }, el("summary", {}, label), body);
    d.addEventListener("toggle", () => {
      if (d.open) open.add(key);
      else open.delete(key);
      persist();
    });
    return d;
  }

  function thinkingBlock(entry) {
    if (!entry.thinking || !String(entry.thinking).trim()) return null;
    return details("t:" + entry.id, "Thinking", el("pre", { class: "thinking-text" }, entry.thinking));
  }

  function thoughtLine(entry) {
    if (!entry.thought || entry.thought === entry.text) return null;
    return el("div", { class: "thought" }, el("span", { class: "thought-icon" }, "💭 "), entry.thought);
  }

  function message(entry) {
    const who = {
      user: "You",
      coordinator: "Coordinator",
      agent: entry.agentName || "Sub-agent",
      system: "Agentic",
    }[entry.author];
    const kind = entry.kind || "message";
    let label = entry.author === "agent" ? "↳ " + who : who;
    if (kind === "spawn") label = "Coordinator ⇢ new sub-agent";
    if (kind === "report") label = "↩ " + who + " reports to the coordinator";
    if (kind === "direct") label = "You → " + (entry.agentName || "sub-agent");
    if (kind === "question") label = "? " + who + " asks you";
    if (kind === "approval") label = "⚑ " + who + " asks for permission";
    if (kind === "review") label = "✎ " + who + " proposes changes";
    if (kind === "checks") label = "Coordinator · checks";
    const head = el(
      "div",
      { class: "msg-head" },
      el("span", { class: "who" }, label),
      entry.tag && kind !== "spawn" && kind !== "report" ? el("span", { class: "tag" }, entry.tag) : null,
      el("span", { class: "time" }, timeLabel(entry.time)),
    );
    return el(
      "div",
      { class: `msg from-${entry.author} ${entry.tone ? "tone-" + entry.tone : ""} kind-${kind}` },
      head,
      thoughtLine(entry),
      el("div", { class: "msg-text" }, entry.text),
      entry.preview ? el("pre", { class: "change-preview" }, entry.preview) : null,
      thinkingBlock(entry),
      kind === "plan" || kind === "research" ? planCard(entry) : null,
      kind === "outcome" && entry.runId ? outcomeActions(entry) : null,
      kind === "checks" ? checksCard(entry) : null,
      kind === "approval" ? approvalCard(entry) : null,
      kind === "review" && entry.runId ? reviewCard(entry) : null,
      kind === "question" ? questionCard(entry) : null,
    );
  }

  // ---- live agents panel: who is working and what each one last thought ----

  function lastWhere(entries, pred) {
    for (let i = entries.length - 1; i >= 0; i--) if (pred(entries[i])) return entries[i];
    return undefined;
  }

  function agentRow(key, icon, iconCls, name, status, latest, extra) {
    const said = latest ? latest.thought || latest.text : "";
    const row = el(
      "div",
      { class: "agent-row" },
      el("span", { class: "agent-icon " + iconCls }, icon),
      el("span", { class: "agent-name" }, name),
      el("span", { class: "agent-status" }, status),
    );
    const body = el(
      "div",
      { class: "agent-latest" },
      said ? el("div", { class: "agent-thought" }, said) : el("div", { class: "muted" }, "Nothing yet."),
      latest && latest.thinking && String(latest.thinking).trim() ? details("a:" + key + ":" + latest.id, "Latest thinking", el("pre", { class: "thinking-text" }, latest.thinking)) : null,
      extra || null,
    );
    return el("div", { class: "agent" }, row, body);
  }

  // ---- receipt of every file the sub-agents touched in this conversation ----

  /** Every proposed change in this conversation, oldest run first, with the run it belongs to. */
  function allChanges() {
    const out = [];
    for (const [runId, plan] of Object.entries(state.plans || {})) {
      for (const c of plan.changes || []) out.push({ ...c, runId });
    }
    return out;
  }

  function changeStatusText(c) {
    return c.status === "accepted" && c.auto ? "written (auto-approved)" : STATUS_LABEL[c.status];
  }

  /** One file in the receipt: click the name to open it (a new file) or its side-by-side diff (an edit). */
  function fileRow(c, showAgent) {
    const review = (action) => post({ type: "review", runId: c.runId, action, path: c.path });
    return el(
      "li",
      { class: "change status-" + c.status },
      el("div", { class: "change-head" },
        el("button", { class: "link", title: c.kind === "new" ? "Open the new file" : "Open the side-by-side diff", onclick: () => review("show") }, c.path),
        el("span", { class: "tag" }, c.kind === "new" ? "new file" : "edit"),
        el("span", { class: "file-status" }, changeStatusText(c)),
        showAgent ? el("span", { class: "muted" }, "by " + c.agentName) : null,
        c.status === "pending" ? el("button", { class: "mini primary", title: "Write this change to the project", onclick: () => review("accept") }, "Accept") : null,
        c.status === "pending" ? el("button", { class: "mini secondary", title: "Drop this change", onclick: () => review("reject") }, "Reject") : null,
      ),
    );
  }

  function filesPanel() {
    const changes = allChanges();
    if (changes.length === 0) return null;
    const count = (s) => changes.filter((c) => c.status === s).length;
    const parts = [
      count("pending") ? `${count("pending")} waiting` : "",
      count("accepted") ? `${count("accepted")} written` : "",
      count("rejected") ? `${count("rejected")} rejected` : "",
    ].filter(Boolean);
    const files = new Set(changes.map((c) => c.path)).size;
    let body = null;
    if (!filesCollapsed) {
      let list;
      if (filesBy === "agent") {
        const groups = new Map();
        for (const c of changes) {
          const key = c.runId + ":" + c.taskId;
          if (!groups.has(key)) groups.set(key, { name: c.agentName, items: [] });
          groups.get(key).items.push(c);
        }
        list = [...groups.values()].map((g) =>
          el("div", { class: "file-group" }, el("div", { class: "file-group-name" }, "✎ " + g.name), el("ul", { class: "changes" }, g.items.map((c) => fileRow(c, false)))),
        );
      } else {
        list = el("ul", { class: "changes" }, changes.map((c) => fileRow(c, true)));
      }
      const toggle = (by, label) =>
        el("button", { class: "mini " + (filesBy === by ? "primary" : "secondary"), onclick: () => { filesBy = by; persist(); render(); } }, label);
      body = el("div", { class: "files-body review" }, el("div", { class: "row" }, toggle("file", "All files"), toggle("agent", "By sub-agent")), list);
    }
    return el(
      "div",
      { class: "agents files" },
      el(
        "button",
        {
          class: "agents-head",
          "aria-expanded": filesCollapsed ? "false" : "true",
          onclick: () => {
            filesCollapsed = !filesCollapsed;
            persist();
            render();
          },
        },
        (filesCollapsed ? "▸ " : "▾ ") + `Files changed · ${files} file(s)${parts.length ? " · " + parts.join(", ") : ""}`,
      ),
      body,
    );
  }

  /** The files one sub-agent changed, shown under it in the Agents panel. */
  function agentFiles(runId, taskId) {
    const plan = state.plans[runId];
    const mine = plan ? plan.changes.filter((c) => c.taskId === taskId).map((c) => ({ ...c, runId })) : [];
    if (mine.length === 0) return null;
    return el("div", { class: "agent-files review" }, el("div", { class: "muted" }, "Files:"), el("ul", { class: "changes" }, mine.map((c) => fileRow(c, false))));
  }

  function agentsPanel() {
    const c = state.current;
    const planEntry = lastWhere(c.entries, (e) => e.kind === "plan" || e.kind === "research");
    const plan = planEntry && state.plans[planEntry.runId];
    const coordinatorBusy = !!state.busy && !state.runningRunId;
    const lastCoordinator =
      lastWhere(c.entries, (e) => e.author === "coordinator" && (e.thought || e.thinking)) ||
      lastWhere(c.entries, (e) => e.author === "coordinator" && e.kind !== "spawn");
    const rows = [
      agentRow(
        "coordinator",
        coordinatorBusy ? "" : "●",
        coordinatorBusy ? "spinner" : "coordinator-dot",
        "Coordinator",
        coordinatorBusy ? "thinking…" : state.runningRunId ? "waiting for sub-agents" : "idle",
        lastCoordinator,
      ),
    ];
    let working = 0;
    if (plan) {
      for (const t of plan.tasks) {
        const active = t.status === "running" || t.status === "verifying";
        if (active) working++;
        const latest = lastWhere(c.entries, (e) => e.taskId === t.id && e.runId === planEntry.runId && e.author === "agent");
        rows.push(
          agentRow(
            t.id,
            active ? "" : STATUS_ICON[t.status] || "○",
            active ? "spinner" : "status-" + t.status,
            t.title,
            t.status === "pending" ? (plan.started ? "waiting" : "not started") : t.status.replace("_", " "),
            latest,
            el("div", {}, agentFiles(planEntry.runId, t.id), active ? agentMessageBox(planEntry.runId, t.id) : null),
          ),
        );
      }
    }
    const summary = plan ? `Agents · ${working} of ${plan.tasks.length} sub-agent(s) working` : "Agents";
    const panel = el(
      "div",
      { class: "agents " + (agentsCollapsed ? "collapsed" : "") },
      el(
        "button",
        {
          class: "agents-head",
          "aria-expanded": agentsCollapsed ? "false" : "true",
          onclick: () => {
            agentsCollapsed = !agentsCollapsed;
            persist();
            render();
          },
        },
        (agentsCollapsed ? "▸ " : "▾ ") + summary,
      ),
      agentsCollapsed ? null : el("div", { class: "agents-body" }, rows),
    );
    return panel;
  }

  // ---- cards that wait for the user ----

  const drafts = {}; // unsent text in card inputs, by input id

  function isWaiting(entry) {
    return state.waiting && state.waiting.includes(entry.id);
  }

  function decide(entry, decision) {
    post({ type: "decide", entryId: entry.id, decision });
  }

  function decidedLine(entry) {
    return entry.decided ? el("div", { class: "decided" }, "✓ " + entry.decided) : null;
  }

  const checkDrafts = {}; // editable check lists, by entry id

  function checksCard(entry) {
    if (!isWaiting(entry)) {
      return el(
        "div",
        { class: "card" },
        (entry.checks || []).length
          ? el("ul", { class: "check-list" }, entry.checks.map((c) => el("li", {}, el("b", {}, c.name), " ", el("code", {}, c.command))))
          : el("div", { class: "muted" }, "No checks."),
        decidedLine(entry),
        entry.decided === "Saved for this folder"
          ? el("div", { class: "row" }, el("button", { class: "secondary", disabled: !!state.busy, onclick: () => post({ type: "editChecks" }) }, "Change checks"))
          : null,
      );
    }
    const list = (checkDrafts[entry.id] ||= {
      rows: (entry.checks || []).map((c) => ({ on: true, name: c.name, command: c.command, source: c.source })),
      remember: true,
    });
    const rows = list.rows.map((r, i) =>
      el(
        "div",
        { class: "check-row" },
        el("input", { type: "checkbox", checked: r.on, title: "Use this check", onchange: (e) => (r.on = e.target.checked) }),
        el("input", { id: `cn-${entry.id}-${i}`, class: "check-name", value: r.name, placeholder: "name", oninput: (e) => (r.name = e.target.value) }),
        el("input", { id: `cc-${entry.id}-${i}`, class: "check-cmd", value: r.command, placeholder: "command", title: r.source ? "Suggested from " + r.source : "", oninput: (e) => (r.command = e.target.value) }),
        el("button", { class: "icon-btn", title: "Remove", onclick: () => { list.rows.splice(i, 1); render(); } }, "✕"),
      ),
    );
    return el(
      "div",
      { class: "card" },
      rows,
      el("div", { class: "row" },
        el("button", { class: "secondary", onclick: () => { list.rows.push({ on: true, name: "", command: "" }); render(); } }, "+ Add check"),
        el("label", { class: "remember" },
          el("input", { type: "checkbox", checked: list.remember, onchange: (e) => (list.remember = e.target.checked) }),
          " Remember for this folder"),
      ),
      el("div", { class: "row" },
        el("button", {
          class: "primary",
          onclick: () => decide(entry, { kind: "checks", remember: list.remember, checks: list.rows.filter((r) => r.on && r.name.trim() && r.command.trim()).map((r) => ({ name: r.name, command: r.command })) }),
        }, "Approve checks"),
        el("button", { class: "secondary", onclick: () => decide(entry, { kind: "skip" }) }, "Run without checks"),
      ),
    );
  }

  function approvalCard(entry) {
    if (!isWaiting(entry)) return decidedLine(entry);
    return el("div", { class: "row" },
      el("button", { class: "primary", onclick: () => decide(entry, { kind: "allow" }) }, "Allow"),
      entry.rememberable ? el("button", { class: "secondary", onclick: () => decide(entry, { kind: "allow", remember: true }) }, entry.rememberLabel || "Allow and remember for this folder") : null,
      el("button", { class: "secondary", onclick: () => decide(entry, { kind: "deny" }) }, "Deny"),
    );
  }

  function questionCard(entry) {
    if (!isWaiting(entry)) return decidedLine(entry);
    const id = "q-" + entry.id;
    const ta = el("textarea", { id, rows: "2", class: "card-input", placeholder: "Your answer (Enter to send)" });
    ta.value = drafts[id] || "";
    const send = () => {
      const text = ta.value.trim();
      if (!text) return;
      delete drafts[id];
      decide(entry, { kind: "answer", text });
    };
    ta.addEventListener("input", () => (drafts[id] = ta.value));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });
    return el("div", { class: "card" }, ta, el("div", { class: "row" }, el("button", { class: "primary", onclick: send }, "Answer")));
  }

  // ---- auto-approve switches ----

  let permsOpen = !!saved.permsOpen;
  const PERMS = [
    ["editFiles", "Edit files", "Sub-agents' changes are written to your project right away. When off, each change opens for review and is only written when you press Accept."],
    ["sensitiveFiles", "Sensitive files", "The same for package.json files, lockfiles, CI, dev containers, git hooks and .vscode files."],
    ["commands", "Run commands", "Check commands (tests, lint, ...) run without asking. When off, each command is shown to you first and only runs if you allow it. Commands start in the project folder but run as you, so they can read files elsewhere and use the network. Only your user settings count; a project cannot turn this on."],
  ];

  function permissionsBar() {
    const p = state.permissions || {};
    const on = PERMS.filter(([k]) => p[k]).map(([, label]) => label);
    const head = el(
      "button",
      { class: "perms-head", "aria-expanded": permsOpen ? "true" : "false", onclick: () => { permsOpen = !permsOpen; persist(); render(); } },
      (permsOpen ? "▾ " : "▸ ") + "Auto-approve: " + (on.length ? on.join(", ") : "nothing"),
    );
    if (!permsOpen) return el("div", { class: "perms" }, head);
    return el(
      "div",
      { class: "perms" },
      head,
      PERMS.map(([key, label, help]) =>
        el("label", { class: "perm", title: help },
          el("input", { type: "checkbox", checked: !!p[key], onchange: (e) => post({ type: "setPermission", key, value: e.target.checked }) }),
          " " + label, el("span", { class: "muted" }, " · " + help)),
      ),
      el("div", { class: "muted perm-note" }, "Agents can never reach files outside this folder, .git or secrets, whatever is ticked."),
    );
  }

  // ---- messaging a sub-agent ----

  function agentMessageBox(runId, taskId) {
    const id = `m-${runId}-${taskId}`;
    const input = el("input", { id, class: "card-input", placeholder: "Message this sub-agent (Enter to send)" });
    input.value = drafts[id] || "";
    input.addEventListener("input", () => (drafts[id] = input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.trim()) {
        post({ type: "messageAgent", runId, taskId, text: input.value.trim() });
        delete drafts[id];
        input.value = "";
      }
    });
    return input;
  }

  function welcome() {
    const recent = state.conversations.slice(0, 5);
    return el(
      "div",
      { class: "welcome" },
      el("h2", {}, "New agentic task"),
      el(
        "p",
        { class: "muted" },
        "The coordinator talks with you and splits the work into small tasks. Every change is made by a sub-agent that may only touch its own files. You review each change in VS Code, and nothing is written to your project until you accept it (unless you turn on Edit files).",
      ),
      el(
        "p",
        { class: "muted" },
        el("b", {}, "Plan"),
        " discusses and proposes a plan. ",
        el("b", {}, "Act"),
        " runs it.",
      ),
      recent.length
        ? el(
            "div",
            { class: "recent" },
            el("h3", {}, "Recent"),
            recent.map((c) =>
              el(
                "div",
                { class: "recent-item" },
                el(
                  "button",
                  { class: "link", onclick: () => post({ type: "open", id: c.id }), title: c.workspaceRoot },
                  el("span", { class: "recent-title" }, c.title),
                  el("span", { class: "muted" }, ` ${folderName(c.workspaceRoot)} · ${timeLabel(c.updatedAt)}`),
                ),
                el("button", { class: "icon-btn", title: "Delete conversation", onclick: () => post({ type: "delete", id: c.id }) }, "✕"),
              ),
            ),
          )
        : null,
    );
  }

  function conversation() {
    const c = state.current;
    const list = el("div", { class: "messages", id: "messages" }, c.entries.map(message));
    return el(
      "div",
      { class: "conversation" },
      el("div", { class: "conv-title", title: c.workspaceRoot }, c.title, el("span", { class: "muted" }, ` · ${folderName(c.workspaceRoot)}`)),
      agentsPanel(),
      filesPanel(),
      list,
    );
  }

  // Green "Finished" bar at the bottom once the last prompt is dealt with. Gone while a new prompt runs.
  const DONE_ICON = { finished: "✓", partial: "!", stopped: "■", failed: "✕" };
  function doneBar() {
    const d = state.done;
    if (!d || state.busy || !state.current) return null;
    return el("div", { class: "done-bar done-" + d.status, role: "status" }, el("span", { class: "done-icon" }, DONE_ICON[d.status] || "✓"), d.text);
  }

  function render() {
    if (!state) return;
    const old = document.getElementById("messages");
    const nearBottom = !old || old.scrollHeight - old.scrollTop - old.clientHeight < 60;
    const oldScroll = old ? old.scrollTop : 0;
    const active = document.activeElement;
    const focusedId = active && active.id ? active.id : null;
    const caret = focusedId && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;

    const parts = [
      header(),
      inputBox(),
      permissionsBar(),
      state.busy ? el("div", { class: "busy" }, el("span", { class: "spinner" }), el("span", { class: "spacer" }, state.busy), stopButton()) : null,
      state.current ? conversation() : welcome(),
      doneBar(),
    ];
    app.replaceChildren(...parts.filter(Boolean));

    const list = document.getElementById("messages");
    if (list) list.scrollTop = nearBottom ? list.scrollHeight : oldScroll;
    const again = focusedId && document.getElementById(focusedId);
    if (again && !again.disabled) {
      again.focus();
      if (caret && typeof again.setSelectionRange === "function") again.setSelectionRange(caret[0], caret[1]);
    }
  }

  // Esc stops the work, like the Stop button.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.busy && state.busy !== "Stopping…" && !e.defaultPrevented) {
      e.preventDefault();
      post({ type: "cancel" });
    }
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg && msg.type === "state") {
      state = msg.state;
      render();
    } else if (msg && msg.type === "focusInput") {
      document.getElementById("input")?.focus();
    }
  });

  post({ type: "ready" });
})();
