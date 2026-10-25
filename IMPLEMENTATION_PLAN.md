# AI Task Worker — Full Implementation Plan (for review & optimisation)

> **Purpose of this document.** This is a complete, self-contained description of an existing prototype,
> written so another engineer or LLM can review it and propose optimisations **without seeing the code**.
> It covers the problem, constraints, architecture, every module's contract, the exact algorithms and
> constants, the test strategy, known weaknesses, and a list of open questions where improvements are
> most wanted. Section 12 is the explicit request to the reviewer.

---

## 1. Problem statement (summary of the brief)

Build a prototype **autonomous AI worker** that takes a natural-language task and completes it by using a
computer. Canonical example:

> "Find the latest invoice from Company X, extract the amount and due date, enter it into our internal
> system, and tell me once it is done."

The system should ideally:

1. Understand the user's end goal (not require every step).
2. Break the request into a sequence of actions.
3. Use tools: browser, files, APIs, or a simulated company app.
4. Observe the result of each action.
5. Decide what to do next based on what happened.
6. Remember relevant information discovered during execution.
7. Detect when an action fails.
8. Retry or try a reasonable alternative.
9. Verify whether the requested outcome was actually achieved.
10. Ask the user for clarification/approval when it cannot safely proceed.
11. Return a concise summary and useful evidence of completion.

**Scope rules from the brief:** not production-ready; may restrict to a small simulated environment;
"a narrow prototype that genuinely works is better than a broad system where most functionality is
mocked"; architecture/model/framework are the builder's choice; no real company credentials or third-party
systems.

**Evaluation criteria:** Autonomy, Execution (does real work), Reliability (errors/retries/failures),
Verification, Generalization (how much stays unchanged for a different task), Engineering quality,
Product thinking, Technical understanding.

**Deliverables:** repo, README (setup/run), architecture explanation, design decisions, demo video or
live demo, known limitations, next steps, assumptions, list of models/APIs/frameworks.

---

## 2. Constraints that shaped the design

| Constraint | Consequence |
|---|---|
| LLM must be **free and open-source/open-weight** | Default: `openai/gpt-oss-120b` (Apache-2.0 weights) on **Groq free tier**; fallback: any local model via **Ollama** (e.g. `qwen3:8b`). Client is generic OpenAI-compatible `/chat/completions` with tool calling. |
| Developer laptop: Windows 11, **no dedicated GPU** (Intel Iris Xe, 16 GB RAM) | Local models run on CPU → slow; hosted free tier is default. |
| Groq free tier rate limits (approx. 30 RPM, **~8K tokens/min**, ~200K tokens/day for gpt-oss-120b) | Prompts and observations must be **compact**; context compaction; automatic back-off honouring `retry-after` / "try again in Xs". |
| Small/open models are weaker at tool use than frontier models | Text (not vision) page snapshots, very explicit tool contracts, recovery from malformed tool calls, loop guard, nudges. |
| Stack choice | **TypeScript / Node ≥ 20.12** (tested on Node 24), Express, Playwright (Chromium), vanilla HTML/JS UI (no build step), `tsx` runner, Node built-in test runner. No agent framework, no LLM SDK. |
| Network may be behind an HTTPS proxy | Node's `fetch` ignores `HTTPS_PROXY`; we install `undici`'s `EnvHttpProxyAgent` as global dispatcher when proxy env vars exist (respects `NO_PROXY`, so localhost stays direct). |

---

## 3. High-level architecture

```
 Web UI (public/, SSE)  ─┐                ┌─ CLI (src/cli.ts, readline)
                         ▼                ▼
          Agent server (src/server/index.ts, Express :3000)
                         │ creates / streams / relays approvals
                         ▼
          Run (src/agent/run.ts) — event log (JSONL), working memory, plan,
                                   pending human requests (approval/question)
                         │
          Worker loop (src/agent/worker.ts)
             system prompt = generic rules + environment manifest + plan + memory
             LLM → tool calls → dispatch (risk → approval → execute) → observation
             LoopGuard, context compaction, malformed-call recovery, nudges
             finish(completed) → Verifier (src/agent/verifier.ts, read-only, fresh browser)
                         │ tools
       ┌─────────────────┼─────────────────────┬──────────────────────┐
   browser_* (Playwright)   http_request (fetch)   list/read/write_file   control tools
       └─────────────────┴──────────┬──────────┴──────────────────────┘
                                    ▼
          Simulated company "Northwind Ops" (src/mockco, Express :4000)
          /mail · /erp/bills · /erp/vendors · /chat · /api (JSON)
```

**Key idea:** the agent loop, tools and prompts are task- and company-agnostic. The *only*
environment-specific code is `src/agent/environment.ts` (a short manifest of available systems) plus the
URL allowlist.

### Repository layout

```
ai-task-worker/
  package.json, tsconfig.json, .env.example, .gitignore, README.md, IMPLEMENTATION_PLAN.md
  src/
    config.ts                 env loading, proxy dispatcher, constants
    cli.ts                    terminal front-end
    server/index.ts           HTTP API + SSE + static UI + starts mock company
    mockco/data.ts            seed data (vendors, emails, invoice attachments, bills, chat)
    mockco/app.ts             mock company apps + JSON API + chaos + validation
    mockco/main.ts            standalone mock company
    agent/types.ts            Tool, ToolResult, Plan, RunEvent, FinalResult, ...
    agent/run.ts              Run class (events, memory, plan, approvals, questions)
    agent/llm.ts              OpenAI-compatible client with retry policy
    agent/dispatch.ts         safety gate + tool execution + arg parsing
    agent/loop.ts             nextMove (malformed-call retry), compactHistory, LoopGuard
    agent/prompts.ts          worker + verifier system prompts
    agent/environment.ts      environment manifest (the only company-specific text)
    agent/worker.ts           main loop + control tools
    agent/verifier.ts         independent verification loop
    agent/tools/browser.ts    Playwright session + browser tools + click risk assessment
    agent/tools/snapshot.ts   in-page DOM → compact text with [ref]s
    agent/tools/http.ts       http_request tool + URL allowlist
    agent/tools/files.ts      sandboxed list/read/write file tools
  public/index.html, app.js, styles.css     UI
  tests/helpers.ts, mockco.test.ts, agent.test.ts
  workspace/shared/finance/{ap-policy.md, README.txt, monthly-budget-2026.csv}
  workspace/output/           agent-written reports
  runs/<id>/{task.json, events.jsonl, result.json, screenshots/*.png}
```

---

## 4. The simulated environment ("Northwind Ops")

In-memory Express app on port 4000 (resettable). Server-rendered HTML for humans/browser agent plus a JSON
API covering the same data. It deliberately contains **realistic traps**.

### 4.1 Seed data

- **Vendors:** V-001 Acme Corp, V-002 Acme Logistics, V-003 Globex Ltd, V-004 Initech, V-005 Umbrella Supplies
  (each with contact email + payment terms).
- **Emails (finance shared inbox):**
  - m-101 2026-08-18 Acme Corp "Invoice INV-2026-0815" + attachment (USD 4,250.00, due "2 October 2026").
  - m-102 newsletter (noise).
  - m-103 2026-10-01 Acme Corp "Your October invoice" + attachment **INV-2026-0931**: lines sum + tax =
    **USD 12,480.50**, issue "1 October 2026", due **"15 November 2026"**.
  - m-104 Globex GX-7781 USD 3,100.00 due "4 November 2026".
  - m-105 Acme Logistics AL-5520 USD 890.00 due "7 November 2026".
  - m-106 2026-10-12 Acme Corp **"Reminder: INV-2026-0815 is overdue"** — newest Acme email, *not* the latest invoice.
  - m-107 Initech: billing contact changes to `ap-team@initech.example`.
- **Bills (ERP):** B-1001 Globex GX-7702 Paid; B-1002 Initech IN-3391 Approved; **B-1003 Acme INV-2026-0815 Approved** (old invoice already entered).
- **Chat:** #finance, #general with a couple of messages.
- **Shared drive (`workspace/shared/finance/ap-policy.md`):** bills ≥ USD 10,000 must have note
  `CFO approval required` and a #finance post; never enter an invoice twice; apply vendor contact changes.

### 4.2 Traps (what a naive agent gets wrong)

1. "Latest invoice" ≠ newest email (the reminder).
2. Two vendors start with "Acme" → ambiguity for "Acme".
3. Source formats (`12,480.50`, `15 November 2026`) ≠ ERP formats (plain number, `YYYY-MM-DD`).
4. Old invoice already exists → duplicate rejection.
5. **Chaos:** first bill submission (UI or API) returns **503** and saves nothing (`MOCKCO_CHAOS=true`).
   A naive retry is fine; a naive *non-check* after an ambiguous failure could create duplicates in real systems.

### 4.3 Routes

UI: `/mail?q=`, `/mail/:id`, `/mail/attachments/:id` (HTML "PDF preview" of invoice), `/erp/bills`,
`/erp/bills/new` (form: vendor select, invoice number, amount, currency select, due date, notes; server
validation; errors re-rendered with `role="alert"`), `/erp/bills/:id` (success banner `role="status"`),
`/erp/vendors`, `/erp/vendors/:id` (edit form), `/chat/:channel` (post form).

API: `GET /api` (endpoint list), `GET /api/emails?q=`, `GET /api/emails/:id`, `GET /api/attachments/:id`
(parsed invoice incl. total), `GET /api/vendors`, `PATCH /api/vendors/:id`, `GET /api/bills?vendorId=&invoiceNumber=`,
`GET /api/bills/:id`, `POST /api/bills`, `GET/POST /api/chat/:channel`. Hidden admin: `POST /admin/reset`, `GET /admin/state`.

### 4.4 Validation rules (shared by UI and API)

- vendorId must exist; invoiceNumber required; amount must match `^\d+(\.\d{1,2})?$` and be > 0;
  currency ∈ {USD, EUR, GBP, INR}; dueDate must match `^\d{4}-\d{2}-\d{2}$` and parse;
  (vendorId, invoiceNumber) must be unique (case-insensitive) → error names the existing bill id.
- Created bills get status "Pending approval".

---

## 5. Agent core — detailed design

### 5.1 Types (contracts)

```ts
type RiskLevel = "none" | "write" | "risky";
interface ToolResult { ok: boolean; output: string; screenshot?: string /* path rel. to run dir */ }
interface Tool<A> {
  name: string; description: string; parameters: JSONSchema;
  assessRisk?(args: A, run: Run): RiskAssessment | Promise<RiskAssessment>;
  execute(args: A, run: Run): Promise<ToolResult>;
}
interface Plan { goal: string; success_criteria: string[]; steps: {text; status: pending|in_progress|done|failed|skipped}[] }
interface VerificationResult { passed: boolean; checks: {criterion; passed; evidence}[]; summary: string }
type Outcome = "completed" | "failed" | "needs_user" | "unverified" | "cancelled";
interface FinalResult { outcome; summary; evidence: string[]; verification?; steps; durationMs }
```

**Events** (each gets `seq`, ISO `at`, `actor: worker|verifier|system`; persisted as JSONL and streamed):
`status`, `plan`, `thought`, `tool_call{callId,name,args}`, `tool_result{callId,name,ok,output,screenshot?}`,
`approval_request{requestId,callId,name,args,reason}`, `approval_response{requestId,approved,comment?}`,
`question{requestId,question}`, `answer{requestId,answer}`, `memory{key,value}`, `recovery{text}`,
`verification{round,result}`, `final{result}`, `error{message}`.

### 5.2 Run (state container)

- Creates `runs/<timestamp>-<rand>/` with `task.json`; appends every event to `events.jsonl`; writes `result.json` at the end.
- Holds `memory: Map<string,string>`, `plan`, `status: running|waiting|done`, `cancelled`.
- `requestApproval(callId, name, args, reason)` and `askUser(question)` return Promises resolved by
  `respond(requestId, {approved?, comment?, answer?})` from any front-end.
- `cancel()` resolves all pending requests (reject / "user cancelled") so the loop can exit.
- `nextScreenshotPath(label)` → numbered PNG paths.

### 5.3 LLM client (`llm.ts`)

- `POST {LLM_BASE_URL}/chat/completions` with `{model, messages, tools, tool_choice:"auto", temperature:0.2}`, 180 s timeout.
- Returns `{content, toolCalls, usage}`.
- **Retry policy:** network error → up to 3 attempts with exponential back-off; HTTP 429/5xx → up to 6
  attempts, delay from `retry-after` header, else parsed from Groq's "try again in 1m3.5s" text, else
  `min(30s, 2^attempt s)`; emits `status: waiting_llm` events while waiting.
- **Key pool:** `LLM_API_KEY` may be comma-separated. `KeyPool` hands out keys round-robin; on 429 the key
  is parked for the provider's retry delay and the next free key is used *immediately* (no sleep); only
  when every key is parked does the client wait for the soonest one. A 401 drops that key (fails only if
  none remain). Keys appear in logs as "key #n", never in plain text. Caveat: provider limits are often
  per organisation, so this only helps with keys that have separate quotas.
- HTTP 400 containing `tool_use_failed` etc. → `ToolFormatError` (recoverable, see 5.5).
- 401 → clear "set LLM_API_KEY" error.

### 5.4 Tools

| Tool | Args | Risk | Notes |
|---|---|---|---|
| `update_plan` | goal, success_criteria[], steps[] | none | Stores plan, emits `plan`. |
| `remember` | key, value | none | Working memory; emits `memory`. |
| `ask_user` | question | none | Blocks until answered. |
| `finish` | outcome (completed/failed/needs_user), summary, evidence[] | none | Triggers verification if completed. |
| `browser_open` | url | none | Allowlisted origins only. Returns snapshot + screenshot. |
| `browser_snapshot` | — | none | Fresh refs. |
| `browser_click` | ref | **assessed** | Returns resulting page. |
| `browser_fill` | ref, value | none | input/textarea `fill`; select by exact value/label, then case-insensitive label; returns actual value. |
| `browser_back` | — | none | |
| `http_request` | method (GET/POST/PATCH/DELETE), url, body? | GET none, else **risky** | Allowlisted; body truncated to 4000 chars. |
| `list_files` | path | none | Sandboxed to `workspace/`. |
| `read_file` | path | none | Truncated to 6000 chars. |
| `write_file` | path, content | **write** | Sandboxed. |

**Click risk assessment** (inspects the real element via Playwright): if it is a submit button/input of a
form whose method ≠ GET → `risky` ("Submits a POST form to /erp/bills via 'Save bill'", followed by
`Form values: Vendor: Acme Corp · Invoice number: … · Amount: …` so the human approves actual values); else if not a
link and its text matches `submit|save|send|post|delete|remove|pay|approve|confirm|transfer|purchase|create|update`
→ `risky`; else `none`.

**Approval policy** (`APPROVAL_MODE`): `risky` (default) asks for `risky`; `always` asks for `write` and
`risky`; `never` asks for nothing. Rejection becomes an observation: *"The user REJECTED this action (comment). It was not performed. Respect this decision…"*. Approval comments are appended to the observation.

**URL allowlist:** only `http://localhost:{MOCKCO_PORT}` / `127.0.0.1` plus `ALLOWED_ORIGINS` env.
Links whose resolved href leaves the allowlist are blocked before clicking.

**Browser session:** one shared Chromium process; one context/page per (run, actor) — worker and
verifier get separate sessions. Default timeout 10 s; viewport 1280×900; tracks the main-frame navigation
HTTP status and reports `HTTP status: 503 (error)` in the snapshot (and `ok=false`).

### 5.5 Page snapshot algorithm (`snapshot.ts`, runs in the page)

Walks visible DOM (skips script/style/noscript/template/label/option and `display:none`/`visibility:hidden`):

- Interactive elements (`a[href]`, button, select, textarea, input≠hidden, `[role=button]`) get
  `data-agent-ref=N` and render as one line:
  - `[N] link "text" -> href`
  - `[N] button "text"`
  - `[N] input "Label" value="…" placeholder="…"` (label from `<label for>`, wrapping label, aria-label, placeholder, name)
  - `[N] select "Label" selected="…" options=[A (val) | B | …]`
  - `[N] textarea "Label" value="…"`, checkbox/radio with `checked=`.
- Headings → `# text` (level-appropriate); table rows → `| cell | cell |` (cells walked recursively so links inside keep refs);
  `role=alert|status` → `[ALERT]` marker; block elements produce newlines; `<pre>` preserves text.
- Post-processing collapses whitespace/blank lines; capped at **4500 chars** by `truncateSnapshot`,
  which keeps interactive `[ref]` lines, `[ALERT]`s, headings and HTTP status first, then fills the
  remaining budget with plain text in page order, and notes how many lines were omitted.
- Snapshot output is prefixed with `URL:`, `Title:`, optional `HTTP status:` lines.
- tsx/esbuild `__name` helper is shimmed in-page before `evaluate` (known tsx+Playwright issue).

### 5.6 Dispatch (`dispatch.ts`)

`dispatch(run, tools, callId, name, args, actor)`: emit `tool_call` → unknown tool → error observation;
else `assessRisk` → maybe `requestApproval` → `execute` (exceptions → `Tool crashed: …`) → emit `tool_result`.
After execution: if the action was `risky`, failed, and the failure is ambiguous (HTTP 5xx, timeout,
connection reset), append `[RECOVERY HINT] … check whether it took effect before retrying`. Validation
4xx errors are unambiguous and get no hint. Every executed non-`none` action is appended to `Run.mutations`.
`parseArgs` tolerates empty strings and code-fenced JSON.

### 5.7 Worker loop (`worker.ts`) — algorithm

```
tools = control tools + browser(worker) + http + files
messages = [system(placeholder), user("Task from the user: """…""")]
for step in 1..MAX_STEPS (40):
    if cancelled → outcome cancelled
    messages[0] = workerSystemPrompt(environment, plan, memory)     # re-rendered every turn
    compactHistory(messages)                                        # see 5.8
    res = nextMove(llm, messages, tools,                            # retries ToolFormatError ×2 with a corrective user msg
                   forceTool = "update_plan" if no plan and step ≤ 2)
    if no tool calls and content is JSON {outcome, summary} → treat as finish call
    emit thought if res.content
    if no tool calls:
        nudges++ (>3 → failed) ; push "Continue by calling a tool… call finish" ; continue
    push assistant(tool_calls)
    for each call: parse args (invalid → error tool msg) → dispatch → push tool msg → LoopGuard.record
    push any LoopGuard notes as user messages (+ recovery events)
    if finish requested:
        if outcome ≠ completed → done(failed | needs_user)
        verificationRounds++ ; v = verify(...)                      # see 5.9
        if v.passed → done(completed)
        if rounds ≥ 2 → done(unverified, summary + verifier reason)
        push "An independent verifier … NOT complete: <failed checks> … fix without duplicates, call finish again"
budget exhausted → failed with memory dump
on exception → error event + failed ; finally close run browsers
```

### 5.8 Context management

- System prompt is rebuilt each turn and contains the **current plan** and **working memory** — the durable state.
- `compactHistory`: all tool observations except the **last 3** are truncated to **400 chars** + "…[older observation trimmed]" (only if longer than 480).
- Rationale: free-tier TPM limits and small-model context quality; facts that matter should be in memory.

### 5.9 LoopGuard

- Keeps the last 8 call signatures (`name:JSON(args)`).
- Same signature ≥ 3 times in window → note: "same call 3 times… step back, re-read state, try a different approach (API vs UI), or ask the user."
- 3 consecutive failed results → note: "The last 3 actions failed. Stop and reconsider…" (counter resets).

### 5.10 Verifier (`verifier.ts`)

- Separate conversation; system prompt says *do not trust claims, inspect real state, be strict*.
- Input message: original request, worker's claimed summary + evidence (unverified), and an **audit log**
  of every executed state-changing action (`Run.mutations`, recorded by dispatch: tool, args, ok, first
  lines of outcome). **Not passed: worker's plan/criteria, memory, transcript.** This prevents anchoring:
  a worker that picked the wrong record would write criteria its wrong result satisfies.
  The verifier prompt requires it to derive criteria from the request and independently re-establish
  key facts (e.g. which record is really "latest").
- Tools: `browser_open/snapshot/click/back` in **read-only** mode (risky clicks blocked), `http_request`
  GET-only, `list_files`, `read_file`, and `report_verification{passed, checks[], summary}`.
- `passed` is forced false if any check failed or no checks given.
- Max 15 steps; no verdict → `passed:false` "could not reach a verdict".

### 5.11 Prompts (paraphrased; full text in `src/agent/prompts.ts`)

**Worker rules:** (1) start with `update_plan` incl. checkable success criteria; revise as you learn.
(2) act–observe–decide; never assume success. (3) `remember` important facts. (4) "latest" = by the
document's own date; check for existing records. (5) convert to target formats (ISO dates, plain numbers).
(6) on failure read the error and fix the cause or switch UI↔API; retry transient errors but **check
whether a previous state-changing attempt took effect before re-submitting**. (7) ask_user for
ambiguity that matters; don't ask what you can look up. (8) no extra side effects; don't redo existing outcomes.
(9) respect rejected approvals. (10) finish honestly with summary + evidence. "Always respond with tool calls."
Followed by `## Environment` (manifest), `## Current plan`, `## Working memory`.

**Verifier rules:** check every criterion against actual state (values, formats, duplicates, nothing
unrequested changed), sanity-check that the criteria match the original request, prefer precise reads,
report one check per criterion with quoted evidence; unconfirmable = fail.

### 5.12 Environment manifest (`environment.ts`)

Five lines: role (finance back-office assistant at Northwind Ops) and the systems with URLs (mail, ERP
bills/new bill/vendors, chat channels, REST API with `GET /api` for discovery, shared drive layout).

---

## 6. Front-ends

### 6.1 Agent server (`src/server/index.ts`, port 3000)

Starts the mock company in-process (port 4000). Endpoints:
`GET /api/config`, `GET /api/tasks` (live + on-disk runs, newest 30), `POST /api/tasks {task, approvalMode}`,
`GET /api/tasks/:id/stream` (SSE: `meta` event with task text, then all past events, then live; finished runs from disk then `end`),
`POST /api/tasks/:id/respond {requestId, approved?, comment?, answer?}`, `POST /api/tasks/:id/cancel`,
`POST /api/environment/reset` (reseed mock + clear `workspace/output`). Static: `public/`, `/runs/*` (screenshots).

### 6.2 Web UI (`public/`)

Sidebar: task textarea, 5 example tasks, approval-mode select, Run, run history with outcome pills,
"Reset environment". Main: task title + status pill + Stop; result card (outcome, summary, evidence,
collapsible verifier checks, steps & duration); timeline (thoughts, tool cards with ✓/✗, collapsible
observation, screenshot thumbnails, **approval box embedded in the gated action's card** with comment +
Approve/Reject, question cards with answer box, memory lines, recovery notices, verifier-tagged events);
side panel with live plan (goal, criteria, step statuses) and working memory. Light/dark via CSS tokens.

### 6.3 CLI (`src/cli.ts`)

`npm run task -- "…"`. Reuses a running mock company or starts one. Coloured event log; approvals
(`y` approves, other text rejects with comment) and questions answered via readline. Sets `process.exitCode`
(no `process.exit`, which crashes libuv on Windows when stdin closes).

---

## 7. Configuration (`.env`)

`LLM_BASE_URL` (default Groq), `LLM_API_KEY` (one key or comma-separated pool), `LLM_MODEL` (default `openai/gpt-oss-120b`),
`APPROVAL_MODE` (risky|always|never), `MAX_STEPS` (40), `HEADLESS` (true), `AGENT_PORT` (3000),
`MOCKCO_PORT` (4000), `MOCKCO_CHAOS` (true), `RUNS_DIR`, `ALLOWED_ORIGINS`.

---

## 8. Example tasks used for demos (generalisation check)

1. Brief's example with "Acme Corp" (find latest invoice → bill; traps 1, 3, 5).
2. "Enter the latest invoice from **Acme**…" → should `ask_user` (trap 2).
3. "Initech emailed us about a change of contact. Update our records accordingly." → read email, edit vendor.
4. "Make sure every vendor invoice received in October is in the billing system, following our AP policy."
   → multi-record, read policy file, ≥10k note, #finance post (approval), skip already-entered ones.
5. "Write a report to output/unpaid-bills.md listing all unpaid bills sorted by due date with total." → read-only + file write.

---

## 9. Testing strategy

- `tests/helpers.ts`: **ScriptedLLM** replays fixed tool-call scripts separately for worker and verifier
  (detected by system-prompt prefix); steps can be functions that assert on the last observation.
  Everything else is real (loop, dispatch, Playwright Chromium, mock company on port 4555, runs in tmp dir).
- `mockco.test.ts` (5): invoice totals, chaos 503 then success, format validation, duplicate detection, UI error re-render keeps values.
- `agent.test.ts` (8): API path with 503 + check-before-retry + 422 format repair + 3 approvals + verified; browser path filling the real form with only the submit gated (reason mentions POST form) and screenshots; rejection respected; ask_user round-trip; loop guard hint; false completion caught twice → `unverified`; verifier read-only; external URLs blocked.
- Plus: a `finish` written as text JSON is recognised; the first turn forces `update_plan` via `tool_choice`.
- Status: **21/21 passing** (incl. snapshot truncation, form values in approvals, recovery hint, verifier not anchored on worker criteria).

### 9.1 Live-model results (Groq, `openai/gpt-oss-120b`, free tier)

**Run 1 — brief's example task ("…latest invoice from Acme Corp…"), APPROVAL_MODE=risky, auto-approve:**
outcome **completed + verified (4/4 checks)**, 14 worker steps, **263 s** wall time (mostly rate-limit waits:
~15 waits of 3–27 s each).

What went right: used the JSON API (it discovered `GET /api` itself); ignored the newest "reminder" email
and chose INV-2026-0931; converted amount/date; checked for an existing bill before posting; hit the 503,
retried and created B-1004; verifier independently confirmed values and no duplicate.

What went wrong (and the fix applied):
| Observed | Cause | Fix |
|---|---|---|
| Never called `update_plan`; verifier had to derive criteria | Plan was only a prompt rule | Force `tool_choice=update_plan` while no plan exists (first 2 turns) |
| Re-fetched `/api` twice and the email list 3×; `remember` only used at the very end | Old observations trimmed; model unaware of trimming | Prompt now states only the last 3 observations survive and to `remember` immediately |
| Wrote the finish JSON as plain text once (extra rate-limited turn) | Model quirk | Text JSON with `outcome`+`summary` is converted into a `finish` call |
| After 503, re-read emails instead of re-checking bills before retry | Weak adherence to the idempotency rule | **Open** — candidate for a tool-level "did my last write land?" probe |
| 263 s for a ~6-action task | 8K TPM free tier; each turn resends ~3–5K tokens | **Open** — see §12 Q2 |

**Run 2 — ambiguous task ("…latest invoice from Acme…"), before the fixes below:** outcome reported
**completed + verified (5/5)**, but this is a **false positive**:
- The worker read Acme Logistics' AL-5520 (8 Oct, newer) *and* Acme Corp's INV-2026-0931 (1 Oct), then
  silently chose Acme Corp. It never asked, despite the "ask when ambiguous" rule.
- After the 503 it re-POSTed immediately without checking whether the first attempt had landed.
- The verifier received the worker's criteria ("latest **Acme** invoice … vendor 'Acme' exists") and
  just confirmed them: a textbook anchoring failure.

Fixes applied after run 2: verifier no longer sees worker criteria/memory (gets request + claim +
mutation audit log, must derive criteria itself); prompt rule 7 now says that if a user-given name
matches more than one record, it must `ask_user` before any change; a `[RECOVERY HINT]` is appended to
ambiguous write failures; click approvals show form values; snapshot truncation preserves controls.

---

## 10. Known weaknesses / risks (honest list)

1. **Model judgment is untested at scale**: scripted tests prove the machinery, not decision quality. No eval harness with success rates yet.
2. **Token budget**: each turn resends system prompt (~1k tokens) + tool schemas (~1.5k) + history; with 8K TPM, ~2 calls/min. Long tasks are slow.
3. **Compaction is naive**: fixed "last 3 observations" + 400-char truncation; may drop facts the model forgot to `remember`.
4. **Risk classifier is heuristic** (form method, button words, HTTP verb). GETs with side effects or oddly-labelled buttons slip through; benign "Search" POST forms would be flagged.
5. **No idempotency mechanism in tools**: duplicate avoidance relies on the prompt rule + server duplicate check.
6. **Verifier shares the same model** → correlated blind spots; it sees worker's criteria (could inherit a misunderstanding, though prompted to sanity-check).
7. **No persistence/resume**: in-memory runs; server restart loses waiting runs; mock company resets on restart.
8. **Browser coverage**: text-only snapshots; no vision, iframes, shadow DOM, downloads, real PDFs; 4500-char cap may truncate long pages (no pagination/search tool).
9. **Single-tenant**: concurrent runs share the mock company state; no auth.
10. **Parallel tool calls** are executed sequentially, and a `finish` in the same batch as other calls runs after them (intended).
11. **Latency**: one live run of a simple task took ~4.5 minutes on the free tier, dominated by rate-limit waits.

---

## 11. Roadmap (already planned)

1. Evaluation harness: N tasks × M models with programmatic success checks; metrics = success rate, steps, tokens, approvals, wall time.
2. Durable, resumable runs (checkpoint messages/memory/plan; async approvals via webhook/email).
3. Long-term/procedural memory per environment ("ERP wants ISO dates").
4. Vision fallback + real PDF parsing.
5. Policy engine (per-system permissions, spending limits, dry-run/change-set preview).
6. Connectors to real sandboxes (Gmail test accounts, Odoo/ERPNext demo).

---

## 12. Request to the reviewer — where optimisation is most wanted

Please review the design above and propose concrete, prioritised improvements. For each suggestion give:
**what to change, why (which evaluation criterion it improves), expected impact, effort (S/M/L), and any risk.**
Prefer changes that keep the system narrow-but-real and explainable.

Specific questions:

1. **Reliability with small/open models:** what prompt or tool-contract changes most improve tool-calling accuracy for `gpt-oss-120b` / `qwen3-8b`? (e.g. fewer tools, merged tools, structured "next action" schema, few-shot examples, `tool_choice:"required"`, JSON-mode planning step).
2. **Token efficiency under ~8K TPM:** better compaction (summarise observations? keep diffs only? per-tool budgets?), shorter tool schemas, caching strategies, dynamic tool exposure per phase.
3. **Planning:** is a separate explicit planning call (plan-then-execute with re-planning on failure) better than plan-as-a-tool here? Would a hierarchical sub-task executor help task #4 (multiple invoices)?
4. **Verification:** how to make the verifier more independent and cheaper — derive criteria from the original request only? programmatic checks (state diff of before/after snapshots of the API)? a different model as verifier?
5. **Failure recovery:** better taxonomy (transient / input-format / permission / not-found / ambiguous) with tailored recovery strategies; idempotency keys for state-changing actions; automatic "did my last write land?" probe.
6. **Safety gate:** a more principled risk model (e.g. classify by observed network effects, a dry-run that captures the pending request before it is sent, or allowlisted read-only routes).
7. **Memory:** structured memory (entities/records with source + confidence) instead of key–value strings; automatic extraction from observations.
8. **Generalisation:** what minimal changes would let the same agent operate a second, different mock app (e.g. HR/leave system) with zero code changes outside the manifest?
9. **Evaluation:** design of a small but convincing eval suite and metrics for a demo video/interview.
10. **Product/UX:** what would make the demo most convincing to evaluators in ~3 minutes?

Please also flag anything in the design that you consider a bug, an anti-pattern, or over-engineering for a prototype.
