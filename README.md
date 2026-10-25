# AI Task Worker

A prototype **autonomous AI worker**. You describe an outcome in plain language; it plans, operates real
(simulated) company systems through a **browser, a REST API and a file system**, watches what happens,
recovers from errors, asks you before risky actions or when it shouldn't guess, and finally has an
**independent verifier** check the real system state before it reports success.

> "Find the latest invoice from Acme Corp, extract the amount and due date, enter it into our billing
> system, and tell me once it is done."

The worker reads the inbox, opens the invoice, notices the newest Acme email is only a *reminder* about an
older invoice, extracts `USD 12,480.50` / `15 November 2026`, converts them to the ERP's formats
(`12480.50`, `2026-11-15`), asks you to approve the submission, survives the billing service's `503`
(checking that nothing was saved before retrying), and reports bill `B-1004`. A separate verifier then
confirms in the system that exactly one correct bill exists.

---

## Quick start

Requirements: **Node.js ≥ 20.12** (tested on Node 24, Windows 11).

```bash
npm install            # also downloads Playwright's Chromium
cp .env.example .env   # then put your key in LLM_API_KEY
npm start              # UI → http://localhost:3000, mock company → http://localhost:4000
```

**LLM (free, open-weight):** the default is `openai/gpt-oss-120b` (Apache-2.0 weights) on **Groq's free
tier**. Get a key at <https://console.groq.com/keys>, no card needed. Any OpenAI-compatible endpoint works
by changing three env vars, including a **fully local model via Ollama**:

```bash
ollama pull qwen3:8b
# .env
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=qwen3:8b
```

Other ways to run:

| Command | What it does |
|---|---|
| `npm start` | Web UI + mock company. Pick an example task or type your own. |
| `npm run task -- "your task"` | Same agent in the terminal; approvals/questions answered inline. |
| `npm run mockco` | Only the simulated company (browse it at http://localhost:4000). |
| `npm test` | 21 tests: mock company rules + agent loop end-to-end with a scripted model. |
| `npm run typecheck` | TypeScript check. |

`LLM_API_KEY` also accepts several comma-separated keys: they're used round-robin, and a rate-limited key
is parked while the next one takes over. This only helps if the keys have separate quotas (Groq's limits
are per organisation).

Set `HEADLESS=false` to watch the browser work. Use **Reset environment** in the UI to restore seed data.

### Example tasks (in the UI)

1. *Find the latest invoice from Acme Corp … enter it into our billing system* (the brief's example)
2. *Enter the latest invoice from Acme into the billing system.* The name is ambiguous (Acme Corp vs Acme
   Logistics), so the worker should **ask**.
3. *Initech emailed us about a change of contact. Update our records accordingly.* Different systems, same agent.
4. *Make sure every vendor invoice we received in October is in the billing system, following our AP policy.*
   Multi-record work plus a policy read from the shared drive (≥ USD 10k needs a note and a #finance post).
5. *Write a report to output/unpaid-bills.md …* Read-only analysis that produces a file.

No agent code is specific to any of these tasks.

---

## Architecture

```
            ┌──────────────────── Web UI (public/) / CLI (src/cli.ts) ────────────────────┐
            │  task in · live event stream (SSE) · approve/reject · answer questions       │
            └───────────────▲──────────────────────────────────────┬───────────────────────┘
                     events │                                      │ respond(requestId)
┌───────────────────────────┴──────────────────────────────────────▼───────────────────────┐
│ Run (src/agent/run.ts): event log (JSONL) · working memory · plan · pending human requests │
└───────────────────────────▲──────────────────────────────────────────────────────────────┘
                            │
┌───────────────────────────┴──── Worker loop (src/agent/worker.ts) ────────────────────────┐
│  system prompt = generic rules + environment manifest + CURRENT PLAN + WORKING MEMORY      │
│  ┌─► LLM picks tool call(s) ─► dispatch: assess risk ─► (ask human) ─► execute ─► observe ─┐│
│  │      ▲ malformed-call retry      │ policy: risky / always / never                       ││
│  │      │ context compaction        └─► LoopGuard: repeated calls / 3 failures → hint      ││
│  └──────┴──────────────────────────────────────────────────────────────────────────────────┘│
│  finish(completed) ─► Verifier (separate conversation, read-only tools, fresh browser)      │
│                       ├─ passed ─► ✅ done                                                   │
│                       └─ failed ─► findings fed back to worker (max 2 rounds) ─► unverified  │
└────────────────────────────────────────────────────────────────────────────────────────────┘
        tools │ browser_* (Playwright)   http_request   list/read/write_file   update_plan
              │ remember   ask_user   finish                                    (src/agent/tools)
              ▼
┌──────────── Northwind Ops: simulated company (src/mockco) on :4000 ─────────────────────────┐
│ /mail inbox + invoice attachments · /erp bills & vendors (strict validation) · /chat · /api │
│ chaos: first bill submission returns 503 · traps: reminder email, two "Acme"s, duplicates    │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Module | Responsibility |
|---|---|
| `src/agent/worker.ts` | The loop: plan → act → observe → remember → recover → finish → verify. Control tools (`update_plan`, `remember`, `ask_user`, `finish`). |
| `src/agent/verifier.ts` | Independent verification with read-only tools and its own browser session. |
| `src/agent/dispatch.ts` | Safety gate in front of every tool call: risk assessment → approval → execute → events. |
| `src/agent/loop.ts` | Malformed-call recovery, context compaction, loop/failure detection. |
| `src/agent/llm.ts` | Small OpenAI-compatible client with retry/back-off honouring rate-limit hints. |
| `src/agent/tools/` | Browser (accessibility-style text snapshots with `[ref]`s, plus screenshots), HTTP, sandboxed files. |
| `src/agent/environment.ts` | **The only company-specific code**: a short manifest of available systems. |
| `src/agent/run.ts` | Run state, persisted event log (`runs/<id>/events.jsonl`, `result.json`, `screenshots/`). |
| `src/mockco/` | The simulated company: server-rendered HTML apps + JSON API, in-memory, resettable. |
| `src/server/index.ts` | Starts runs, streams events via SSE, relays approvals/answers, serves UI and run artifacts. |

---

## How each requirement is met

| Requirement | Mechanism |
|---|---|
| Understand the end goal | First action is `update_plan`: restated goal + **checkable success criteria** + steps. The plan is re-injected every turn and revised as the agent learns. |
| Break into actions | Model chooses tool calls step by step; plan steps are marked done/in-progress. |
| Use tools | Real Chromium via Playwright, a JSON HTTP client, a sandboxed file system. The agent can switch between UI and API. |
| Observe results | Every action returns an observation: a fresh page snapshot (incl. HTTP status and `[ALERT]` error banners) or status + body. Screenshots saved per browser action. |
| Decide next step | Re-planning happens naturally in the loop; observations are never assumed successful. |
| Remember | `remember` writes to working memory, which is rendered into the system prompt each turn and **survives context trimming** of old observations. |
| Detect failure | Tool results carry `ok`; HTTP ≥ 400 and validation banners are surfaced explicitly; `LoopGuard` detects repetition and 3 consecutive failures. |
| Retry / alternatives | Transient errors are retried by the model with an **idempotency rule** (check the earlier attempt didn't take effect before resubmitting). The guard injects "step back, try the API/UI instead, or ask". LLM-side: back-off on 429/5xx, re-prompt on malformed tool calls. |
| Verify | A separate verifier conversation with **read-only** tools and a fresh browser checks the real system against the criteria. A failed verdict is sent back to the worker; it can't mark its own homework. |
| Ask for clarification / approval | `ask_user` tool; plus a risk gate on every call. Form POSTs, API writes and state-changing buttons are `risky` and require approval (configurable: `risky` / `always` / `never`). Rejections are fed back and respected. |
| Summary + evidence | `finish` returns summary and evidence (IDs, URLs); the UI shows them with the verifier's per-criterion checks, screenshots and the full trace. |

---

## Key design decisions

- **A narrow but real environment.** The brief prefers a narrow prototype that works over broad mocks, so
  the agent drives a real browser and real HTTP against a small company app with *real* validation,
  failures and ambiguities. Only the company is simulated; the agent's actions are real.
- **Traps on purpose.** The newest Acme email is a reminder about an old invoice. There are two "Acme"
  vendors. Source formats (`12,480.50`, `15 November 2026`) differ from the ERP's (`12480.50`,
  `2026-11-15`). The old invoice already exists (duplicate check). The first submission returns 503.
  These test judgment, not just clicking.
- **Generic agent, data-only environment.** Prompts and tools contain no task logic. Moving to another
  environment means editing `environment.ts` and the URL allowlist (`ALLOWED_ORIGINS`).
- **Text snapshots over pixels.** The browser tool renders the DOM into compact text with numbered refs
  (headings, tables, form fields with labels/values/options, alerts). It's cheap, precise and works with
  small open models that have no vision. Screenshots are still captured as human-readable evidence.
- **Separate verifier.** Self-reported success is the most common agent failure. The verifier gets the
  original request, the worker's claim, and an audit log of the state changes it made. It deliberately
  does **not** get the worker's plan, criteria, memory or transcript: a worker that misread the task
  would write criteria that its wrong result satisfies. The verifier derives "done" from the user's
  words and can only read.
- **Risk-based approvals in code, not in the prompt.** The gate inspects the actual element or request
  (e.g. "this button submits a POST form to /erp/bills", plus the form's current values) rather than
  trusting the model to ask. It's deterministic and auditable. When a risky write fails ambiguously
  (5xx or timeout), the gate appends a hint to check whether it landed before retrying.
- **Working memory + context compaction.** Old page snapshots are trimmed. Important facts live in
  memory, which keeps prompts small enough for free-tier rate limits.
- **No agent framework / SDK.** The worker loop is ~200 lines and the LLM client ~100, so behaviour is easy
  to explain, debug and change. Any OpenAI-compatible endpoint works (Groq, Ollama, OpenRouter, vLLM).
- **Event-sourced runs.** Everything the agent does is an event persisted to JSONL. The UI, CLI and
  history replay are just consumers. That makes debugging and demos straightforward.
- **Safety boundary.** Browser and HTTP tools only reach the simulated company; file tools are sandboxed
  to `workspace/`. No real credentials or third-party systems.

## Testing

`npm test` runs 21 tests in ~10 s. The agent tests use a **scripted model** that replays fixed tool
calls, so everything else is the real code running against the mock company: the loop, approval gate,
recovery, browser and verifier. They cover the 503 retry without duplicating, format-error repair,
filling the real form in Chromium with only the submit gated, rejection handling, `ask_user`, the loop
guard, catching a false "done", the verifier being read-only, and blocking external URLs.

## Known limitations

- **Model quality and rate limits dominate.** Free-tier limits (≈8K tokens/min for `gpt-oss-120b` at time of
  writing) make long tasks slow; the client waits automatically. Small local models (7–8B) make more
  mistakes and need more retries.
- The scripted tests prove the machinery, not the model's judgment. Real-model behaviour varies between runs.
- Only text-based pages: no vision, canvas, iframes, file downloads or PDF parsing (invoices are shown as
  HTML "previews" of the PDF).
- Risk classification is heuristic (form method, button wording, HTTP verb). A GET with side effects or an
  unusual button label could slip through. `APPROVAL_MODE=always` is the conservative option.
- In-memory state: runs survive in `runs/` but a run cannot resume after a server restart; the mock company resets on restart.
- Single user, no auth, one browser per run; concurrent runs share the same mock company.

## What I'd build next

1. **Evaluation harness:** a suite of natural-language tasks with programmatic success checks, run against
   several models to measure success rate, steps, cost and approval count.
2. **Resumable, durable runs:** checkpoint the conversation and memory so a run waiting on approval
   survives restarts; webhooks/email for approvals.
3. **Long-term memory:** learn per-environment knowledge (e.g. "the ERP wants ISO dates") across runs.
4. **Vision fallback** for pages the text snapshot can't represent, plus PDF parsing of real attachments.
5. **Richer policies:** per-tool/per-system permission rules, spending limits, and a dry-run mode that
   shows the full change set before anything is executed.
6. **Connectors** for real sandboxes (e.g. Gmail test accounts, an Odoo/ERPNext demo instance).

## Assumptions

- "Using a computer" can mean the browser plus APIs and files; desktop GUI automation is out of scope.
- Submitting data to a company system or messaging colleagues is consequential, so it needs approval by
  default. Reading never does.
- "Latest invoice" means the most recent invoice document (by invoice date), not the most recent email.
- Bills are created as *Pending approval*. The worker never pays or approves bills itself.
- Dates in the mock company are fixed in 2026 so the scenario is reproducible.

## Models, APIs, frameworks and components used

| Component | Use |
|---|---|
| `openai/gpt-oss-120b` via Groq (default) / any OpenAI-compatible model, e.g. Qwen 3 via Ollama | Reasoning + tool calling (open-weight models) |
| [Playwright](https://playwright.dev) + Chromium | Browser automation, screenshots |
| Express | Mock company app and agent server |
| undici `EnvHttpProxyAgent` | Honour `HTTPS_PROXY` / `NO_PROXY` for LLM calls behind proxies |
| TypeScript, tsx, Node's built-in test runner | Language, runner, tests |
| Vanilla HTML/CSS/JS + Server-Sent Events | UI (no build step) |

No agent framework, vector DB or paid service is required. Built with help from an AI coding assistant (Claude).
