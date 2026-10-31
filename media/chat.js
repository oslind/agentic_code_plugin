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
    vscode.setState({ draft });
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
      el("span", { class: "spacer" }),
      busy ? el("button", { class: "secondary", onclick: () => post({ type: "cancel" }) }, "Stop") : null,
      el("button", { class: "primary", disabled: busy, onclick: () => send(ta) }, "Send"),
    );
    return el("div", { class: "input-box" }, ta, actions);
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
            t.fileScope.join(", "),
            t.dependsOn.length ? ` · after ${t.dependsOn.join(", ")}` : "",
          ),
        ),
      ),
    );
    const canRun = !plan.started && !state.busy;
    return el(
      "div",
      { class: "plan" },
      el("div", { class: "plan-head" }, `${plan.tasks.length} sub-agent task(s) in ${plan.waves} wave(s)`),
      el("ol", { class: "tasks" }, rows),
      canRun
        ? el(
            "div",
            { class: "row" },
            el(
              "button",
              { class: "primary", onclick: () => post({ type: "runPlan", runId: entry.runId }) },
              state.mode === "act" ? "Run plan" : "Switch to Act and run",
            ),
          )
        : null,
    );
  }

  function outcomeActions(entry) {
    const cmd = (command, label, cls) =>
      el("button", { class: cls || "secondary", onclick: () => post({ type: "runCommand", command, runId: entry.runId }) }, label);
    return el(
      "div",
      { class: "row" },
      cmd("applyRun", "Apply to my branch", "primary"),
      cmd("retryFailed", "Retry failed"),
      cmd("showTaskLog", "Log"),
    );
  }

  function message(entry) {
    const who = {
      user: "You",
      coordinator: "Coordinator",
      agent: entry.agentName || "Sub-agent",
      system: "Agentic",
    }[entry.author];
    const head = el(
      "div",
      { class: "msg-head" },
      el("span", { class: "who" }, entry.author === "agent" ? "↳ " + who : who),
      entry.tag ? el("span", { class: "tag" }, entry.tag) : null,
      el("span", { class: "time" }, timeLabel(entry.time)),
    );
    return el(
      "div",
      { class: `msg from-${entry.author} ${entry.tone ? "tone-" + entry.tone : ""} kind-${entry.kind || "message"}` },
      head,
      el("div", { class: "msg-text" }, entry.text),
      entry.kind === "plan" ? planCard(entry) : null,
      entry.kind === "outcome" && entry.runId ? outcomeActions(entry) : null,
    );
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
        "The coordinator talks with you and splits the work into small tasks. Every change is made by a sub-agent that may only touch its own files, on its own branch. Nothing reaches your branch without your approval.",
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
      list,
    );
  }

  function render() {
    if (!state) return;
    const old = document.getElementById("messages");
    const nearBottom = !old || old.scrollHeight - old.scrollTop - old.clientHeight < 60;
    const oldScroll = old ? old.scrollTop : 0;
    const active = document.activeElement;
    const focused = active && active.id === "input";
    const caret = focused ? [active.selectionStart, active.selectionEnd] : null;

    const parts = [
      header(),
      inputBox(),
      state.busy ? el("div", { class: "busy" }, el("span", { class: "spinner" }), state.busy) : null,
      state.current ? conversation() : welcome(),
    ];
    app.replaceChildren(...parts.filter(Boolean));

    const list = document.getElementById("messages");
    if (list) list.scrollTop = nearBottom ? list.scrollHeight : oldScroll;
    const input = document.getElementById("input");
    if (focused && input && !input.disabled) {
      input.focus();
      input.setSelectionRange(caret[0], caret[1]);
    }
  }

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
