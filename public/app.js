// Front-end for the AI Task Worker: starts runs and renders their live event stream.

const EXAMPLES = [
  "Find the latest invoice from Acme Corp, extract the amount and due date, enter it into our billing system, and tell me once it is done.",
  "Enter the latest invoice from Acme into the billing system.",
  "Initech emailed us about a change of contact. Update our records accordingly.",
  "Make sure every vendor invoice we received in October is in the billing system, following our AP policy on the shared drive.",
  "Write a short report to output/unpaid-bills.md listing all bills that are not yet paid, sorted by due date, with the total amount outstanding.",
];

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (v, n = 160) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + "…" : s;
};

let currentId = null;
let source = null;
let callNodes = new Map();

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

async function init() {
  const cfg = await api("/api/config");
  $("#model").textContent = `${cfg.model} · ${cfg.llmHost}`;
  $("#mockco-link").href = cfg.mockcoUrl;
  $("#approval").value = cfg.approvalMode;
  $("#key-warning").hidden = cfg.hasApiKey;

  for (const ex of EXAMPLES) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = ex;
    b.onclick = () => ($("#task").value = ex);
    $("#examples").append(b);
  }

  $("#task-form").onsubmit = async (e) => {
    e.preventDefault();
    $("#run-btn").disabled = true;
    try {
      const { id } = await api("/api/tasks", { method: "POST", body: { task: $("#task").value, approvalMode: $("#approval").value } });
      location.hash = id;
    } catch (err) {
      alert(err.message);
    } finally {
      $("#run-btn").disabled = false;
    }
  };
  $("#reset-env").onclick = async () => {
    if (!confirm("Reset Northwind Ops to its seed data and clear workspace/output?")) return;
    await api("/api/environment/reset", { method: "POST" });
  };
  $("#cancel-btn").onclick = () => api(`/api/tasks/${currentId}/cancel`, { method: "POST" });

  window.addEventListener("hashchange", () => openRun(location.hash.slice(1)));
  await refreshHistory();
  if (location.hash.length > 1) openRun(location.hash.slice(1));
  setInterval(refreshHistory, 5000);
}

async function refreshHistory() {
  const runs = await api("/api/tasks");
  $("#history").innerHTML =
    runs
      .map(
        (r) => `<li data-id="${esc(r.id)}" class="${r.id === currentId ? "active" : ""}">
          <span class="pill ${esc(r.outcome || r.status)}">${esc(r.outcome || r.status)}</span><span class="t" title="${esc(r.task)}">${esc(r.task)}</span></li>`,
      )
      .join("") || `<li class="muted small">No runs yet.</li>`;
  document.querySelectorAll("#history li[data-id]").forEach((li) => (li.onclick = () => (location.hash = li.dataset.id)));
}

function openRun(id) {
  if (!id) return;
  currentId = id;
  source?.close();
  callNodes = new Map();
  $("#empty").hidden = true;
  $("#run").hidden = false;
  $("#timeline").innerHTML = "";
  $("#result").innerHTML = "";
  $("#plan").innerHTML = `<span class="muted small">Waiting for plan…</span>`;
  $("#memory").innerHTML = `<span class="muted small">Nothing yet.</span>`;
  $("#run-id").textContent = id;
  $("#run-task").textContent = "";
  setStatus("running");
  refreshHistory();

  source = new EventSource(`/api/tasks/${encodeURIComponent(id)}/stream`);
  source.onmessage = (m) => handle(JSON.parse(m.data));
  source.addEventListener("meta", (m) => ($("#run-task").textContent = JSON.parse(m.data).task));
  source.addEventListener("end", () => source.close());
}

function setStatus(s) {
  const el = $("#run-status");
  el.className = `pill ${s}`;
  el.textContent = s.replace("_", " ");
  $("#cancel-btn").hidden = !["running", "waiting"].includes(s);
}

function add(html, cls = "") {
  const li = document.createElement("li");
  li.className = `ev ${cls}`;
  li.innerHTML = html;
  $("#timeline").append(li);
  li.scrollIntoView({ block: "nearest" });
  return li;
}

const actorTag = (ev) => (ev.actor === "verifier" ? `<span class="tag verifier">verifier</span>` : "");
const shot = (rel) => (rel ? `<a href="/runs/${esc(currentId)}/${esc(rel)}" target="_blank"><img class="shot" loading="lazy" src="/runs/${esc(currentId)}/${esc(rel)}" alt="screenshot"></a>` : "");

function handle(ev) {
  switch (ev.type) {
    case "status":
      if (ev.status === "started") add(`Run started · ${esc(ev.detail)}`, "minor");
      else if (ev.status === "verifying") {
        add(`🔎 ${esc(ev.detail)}: an independent verifier is checking the real system state…`, "minor");
      } else add(`${esc(ev.detail || ev.status)}`, "minor");
      break;
    case "thought":
      add(`${actorTag(ev)} ${esc(ev.text)}`, `thought ${ev.actor}`);
      break;
    case "tool_call": {
      if (["update_plan", "remember", "finish", "report_verification"].includes(ev.name)) break; // shown via their own panels/events
      const li = add(
        `<div class="head">${actorTag(ev)}<span class="tool">${esc(ev.name)}</span><span class="args">${esc(short(ev.args))}</span><span class="res"></span></div>`,
        ev.actor,
      );
      callNodes.set(ev.callId, li);
      break;
    }
    case "tool_result": {
      const li = callNodes.get(ev.callId);
      if (!li) break;
      li.querySelector(".res").innerHTML = ev.ok ? `<span class="status-ok">✓</span>` : `<span class="status-bad">✗ failed</span>`;
      li.insertAdjacentHTML("beforeend", `<details ${ev.ok ? "" : "open"}><summary>observation</summary><pre>${esc(ev.output)}</pre></details>${shot(ev.screenshot)}`);
      break;
    }
    case "plan":
      renderPlan(ev.plan);
      add(`📋 Plan ${ev.seq < 8 ? "created" : "updated"}: ${esc(ev.plan.goal)}`, "minor");
      break;
    case "memory": {
      const dl = $("#memory");
      if (dl.querySelector("span")) dl.innerHTML = "";
      const existing = [...dl.querySelectorAll("dt")].find((d) => d.textContent === ev.key);
      if (existing) existing.nextElementSibling.textContent = ev.value;
      else dl.insertAdjacentHTML("beforeend", `<dt>${esc(ev.key)}</dt><dd>${esc(ev.value)}</dd>`);
      add(`🧠 remembered <code>${esc(ev.key)}</code> = ${esc(short(ev.value, 80))}`, "minor");
      break;
    }
    case "approval_request":
      setStatus("waiting");
      renderApproval(ev);
      break;
    case "approval_response": {
      const card = document.getElementById(`req-${ev.requestId}`);
      if (card) {
        card.querySelector(".ask-actions").outerHTML = `<div class="small">${ev.approved ? "✅ Approved by you" : "🚫 Rejected by you"}${ev.comment ? ` — “${esc(ev.comment)}”` : ""}</div>`;
        card.closest(".ev")?.classList.remove("ask");
      }
      setStatus("running");
      break;
    }
    case "question":
      setStatus("waiting");
      renderQuestion(ev);
      break;
    case "answer": {
      const card = document.getElementById(`req-${ev.requestId}`);
      if (card) card.querySelector(".ask-actions").outerHTML = `<div class="small">You answered: “${esc(ev.answer)}”</div>`;
      setStatus("running");
      break;
    }
    case "recovery":
      add(`↻ ${esc(ev.text)}`, "recovery");
      break;
    case "verification":
      add(`<div class="head"><span class="tag verifier">verifier</span><b>${ev.result.passed ? "✅ Verified" : "❌ Not verified"}</b> (round ${ev.round})</div>${checksHtml(ev.result)}`, "verifier");
      break;
    case "error":
      add(`⚠ ${esc(ev.message)}`, "error");
      break;
    case "final":
      setStatus(ev.result.outcome);
      renderResult(ev.result);
      refreshHistory();
      break;
  }
}

function renderPlan(plan) {
  const icon = { done: "✓", failed: "✗", in_progress: "▶", pending: "○", skipped: "–" };
  $("#plan").innerHTML = `<div class="plan">
    <div class="plan-goal">${esc(plan.goal)}</div>
    <div class="small muted">Success criteria</div><ul class="small">${plan.success_criteria.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
    <div class="small muted">Steps</div>
    <ol class="steps">${plan.steps.map((s) => `<li class="s-${esc(s.status)}"><span>${icon[s.status] ?? "○"}</span><span>${esc(s.text)}</span></li>`).join("")}</ol></div>`;
}

function renderApproval(ev) {
  const html = `<div class="head"><b>✋ Approval needed</b></div>
     <div>${esc(ev.reason)}</div><pre>${esc(JSON.stringify(ev.args, null, 2))}</pre>
     <div class="ask-actions"><input placeholder="Optional comment for the worker"><button data-a="1">Approve</button><button class="danger" data-a="0">Reject</button></div>`;
  // Attach to the action's own card when we have it, so the decision sits next to what it approves.
  const li = callNodes.get(ev.callId) ?? add("", "");
  const box = document.createElement("div");
  box.className = "approval";
  box.innerHTML = html;
  li.append(box);
  li.classList.add("ask");
  li.scrollIntoView({ block: "nearest" });
  box.id = `req-${ev.requestId}`;
  box.querySelectorAll("button").forEach(
    (b) =>
      (b.onclick = () =>
        api(`/api/tasks/${currentId}/respond`, {
          method: "POST",
          body: { requestId: ev.requestId, approved: b.dataset.a === "1", comment: box.querySelector("input").value },
        }).catch((e) => alert(e.message))),
  );
}

function renderQuestion(ev) {
  const li = add(
    `<div class="head"><b>❓ The worker needs your input</b></div><div>${esc(ev.question)}</div>
     <form class="ask-actions"><input required placeholder="Your answer"><button>Send</button></form>`,
    "ask",
  );
  li.id = `req-${ev.requestId}`;
  li.querySelector("form").onsubmit = (e) => {
    e.preventDefault();
    api(`/api/tasks/${currentId}/respond`, { method: "POST", body: { requestId: ev.requestId, answer: li.querySelector("input").value } }).catch((err) => alert(err.message));
  };
  li.querySelector("input").focus();
}

function checksHtml(v) {
  if (!v) return "";
  return `<div class="small">${esc(v.summary)}</div><ul class="checks">${v.checks
    .map((c) => `<li>${c.passed ? "✅" : "❌"} ${esc(c.criterion)}<span class="ev-text">${esc(c.evidence)}</span></li>`)
    .join("")}</ul>`;
}

function renderResult(r) {
  const title = { completed: "✅ Done — verified", failed: "❌ Failed", needs_user: "⏸ Needs your input", unverified: "⚠ Finished, but not verified", cancelled: "⏹ Cancelled" }[r.outcome] ?? r.outcome;
  $("#result").innerHTML = `<div class="result ${esc(r.outcome)}">
    <h3>${title}</h3><div class="summary">${esc(r.summary)}</div>
    ${r.evidence?.length ? `<div class="small muted" style="margin-top:8px">Evidence</div><ul class="small">${r.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}
    ${r.verification ? `<details ${r.verification.passed ? "" : "open"}><summary class="small muted">Independent verification</summary>${checksHtml(r.verification)}</details>` : ""}
    <div class="small muted">${r.steps} steps · ${(r.durationMs / 1000).toFixed(0)}s</div></div>`;
}

init();
