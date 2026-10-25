import express, { type Request, type Response } from "express";
import { seed, invoiceTotal, type Bill, type State } from "./data.js";

/**
 * "Northwind Ops" — a small simulated company with three internal apps:
 *   /mail  — shared finance inbox with invoice attachments
 *   /erp   — billing system (bills + vendors) with strict server-side validation
 *   /chat  — team chat channels
 * plus a JSON REST API under /api. Everything is in-memory and resettable.
 */
export function createMockco(opts: { chaos: boolean }) {
  let state: State = seed(opts.chaos);
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  const reset = () => {
    state = seed(opts.chaos);
  };

  // ---------- shared domain logic ----------

  type BillInput = Record<string, unknown>;

  function validateBill(input: BillInput): { errors: string[]; bill?: Omit<Bill, "id" | "status" | "createdAt"> } {
    const errors: string[] = [];
    const vendorId = String(input.vendorId ?? "").trim();
    const invoiceNumber = String(input.invoiceNumber ?? "").trim();
    const amountRaw = String(input.amount ?? "").trim();
    const currency = String(input.currency ?? "USD").trim().toUpperCase();
    const dueDate = String(input.dueDate ?? "").trim();
    const notes = String(input.notes ?? "").trim();

    if (!state.vendors.some((v) => v.id === vendorId)) errors.push("Vendor is required and must be an existing vendor.");
    if (!invoiceNumber) errors.push("Invoice number is required.");
    if (!/^\d+(\.\d{1,2})?$/.test(amountRaw) || Number(amountRaw) <= 0)
      errors.push(`Amount must be a plain positive number with up to 2 decimals, e.g. 1234.56 (got "${amountRaw}").`);
    if (!["USD", "EUR", "GBP", "INR"].includes(currency)) errors.push("Currency must be one of USD, EUR, GBP, INR.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(Date.parse(dueDate)))
      errors.push(`Due date must be in YYYY-MM-DD format (got "${dueDate}").`);
    if (
      invoiceNumber &&
      state.bills.some((b) => b.vendorId === vendorId && b.invoiceNumber.toLowerCase() === invoiceNumber.toLowerCase())
    ) {
      const dup = state.bills.find((b) => b.vendorId === vendorId && b.invoiceNumber.toLowerCase() === invoiceNumber.toLowerCase())!;
      errors.push(`Duplicate: invoice ${invoiceNumber} for this vendor already exists as bill ${dup.id}.`);
    }
    if (errors.length) return { errors };
    return { errors, bill: { vendorId, invoiceNumber, amount: Number(amountRaw), currency, dueDate, notes } };
  }

  type CreateResult = { kind: "unavailable" } | { kind: "invalid"; errors: string[] } | { kind: "created"; bill: Bill };

  function createBill(input: BillInput): CreateResult {
    if (state.failNextBillSubmit) {
      state.failNextBillSubmit = false;
      return { kind: "unavailable" };
    }
    const { errors, bill } = validateBill(input);
    if (!bill) return { kind: "invalid", errors };
    const created: Bill = { ...bill, id: `B-${state.nextBillNo++}`, status: "Pending approval", createdAt: new Date().toISOString() };
    state.bills.push(created);
    return { kind: "created", bill: created };
  }

  const vendorName = (id: string) => state.vendors.find((v) => v.id === id)?.name ?? id;
  const money = (n: number, cur = "USD") => `${cur} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // ---------- HTML helpers ----------

  const esc = (s: unknown) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

  const page = (title: string, section: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · Northwind Ops</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font-family:system-ui,Segoe UI,Arial,sans-serif;margin:0;background:#f5f6f8;color:#1d2330}
  header{background:#1f3a5f;color:#fff;padding:10px 24px;display:flex;gap:24px;align-items:center}
  header b{font-size:17px} header a{color:#cfe0f5;text-decoration:none} header a.on{color:#fff;font-weight:600;border-bottom:2px solid #fff}
  main{max-width:960px;margin:24px auto;background:#fff;padding:24px 28px;border-radius:8px;box-shadow:0 1px 3px #0002}
  table{border-collapse:collapse;width:100%} th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e3e6eb;font-size:14px}
  th{background:#f0f2f5} tr.unread td{font-weight:600}
  label{display:block;margin:12px 0 4px;font-weight:600;font-size:14px}
  input,select,textarea{padding:7px 9px;font-size:14px;border:1px solid #b9c0cb;border-radius:4px;width:340px}
  button{margin-top:16px;padding:8px 18px;background:#1f6feb;color:#fff;border:0;border-radius:4px;font-size:14px;cursor:pointer}
  .err{background:#fde8e8;border:1px solid #f5a3a3;color:#8a1c1c;padding:10px 14px;border-radius:4px}
  .ok{background:#e6f6ea;border:1px solid #9bd3a9;color:#1d5c2c;padding:10px 14px;border-radius:4px}
  .muted{color:#6b7380;font-size:13px} pre{white-space:pre-wrap;font-family:inherit}
  .doc{border:1px solid #ccd2da;padding:28px;background:#fffef9}
  .msg{border-bottom:1px solid #eee;padding:8px 0}
</style></head><body>
<header><b>Northwind Ops</b>
  <a href="/mail" class="${section === "mail" ? "on" : ""}">Mail</a>
  <a href="/erp/bills" class="${section === "erp" ? "on" : ""}">Billing</a>
  <a href="/erp/vendors" class="${section === "vendors" ? "on" : ""}">Vendors</a>
  <a href="/chat/finance" class="${section === "chat" ? "on" : ""}">Chat</a>
</header>
<main>${body}</main></body></html>`;

  const unavailablePage = () =>
    page(
      "Service unavailable",
      "erp",
      `<h1>503 — Service temporarily unavailable</h1><p class="err">The billing service is temporarily unavailable. Your bill was <b>not</b> saved. Please try again.</p><p><a href="/erp/bills/new">Back to New Bill</a></p>`,
    );

  // ---------- UI: home ----------

  app.get("/", (_req, res) => {
    res.send(
      page(
        "Home",
        "",
        `<h1>Northwind Ops intranet</h1><ul>
        <li><a href="/mail">Mail</a> — finance shared inbox (finance@northwind.example)</li>
        <li><a href="/erp/bills">Billing</a> — accounts payable bills</li>
        <li><a href="/erp/vendors">Vendors</a> — vendor master data</li>
        <li><a href="/chat/finance">Chat</a> — team channels</li>
        <li><a href="/api">REST API</a> — JSON API documentation</li></ul>`,
      ),
    );
  });

  // ---------- UI: mail ----------

  app.get("/mail", (req, res) => {
    const q = String(req.query.q ?? "").toLowerCase();
    const list = [...state.emails]
      .filter((m) => !q || `${m.fromName} ${m.fromEmail} ${m.subject} ${m.body}`.toLowerCase().includes(q))
      .sort((a, b) => b.date.localeCompare(a.date));
    const rows = list
      .map(
        (m) => `<tr class="${m.read ? "" : "unread"}"><td>${esc(m.fromName)}</td>
        <td><a href="/mail/${m.id}">${esc(m.subject)}</a></td><td>${m.attachmentIds.length ? "📎 " + m.attachmentIds.length : ""}</td>
        <td>${m.date.slice(0, 10)}</td></tr>`,
      )
      .join("");
    res.send(
      page(
        "Inbox",
        "mail",
        `<h1>Inbox — finance@northwind.example</h1>
        <form method="get" action="/mail"><input name="q" placeholder="Search mail" value="${esc(q)}" aria-label="Search mail"> <button type="submit" style="margin:0">Search</button></form>
        <p class="muted">${list.length} message(s), newest first</p>
        <table><thead><tr><th>From</th><th>Subject</th><th>Attachments</th><th>Received</th></tr></thead><tbody>${rows}</tbody></table>`,
      ),
    );
  });

  app.get("/mail/attachments/:id", (req, res) => {
    const att = state.attachments.find((a) => a.id === req.params.id);
    if (!att) return void res.status(404).send(page("Not found", "mail", "<h1>Attachment not found</h1>"));
    const inv = att.invoice;
    const lines = inv.lines
      .map((l) => `<tr><td>${esc(l.description)}</td><td>${l.qty}</td><td>${money(l.unitPrice, "")}</td><td>${money(l.qty * l.unitPrice, "")}</td></tr>`)
      .join("");
    const sub = inv.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
    res.send(
      page(
        att.filename,
        "mail",
        `<p class="muted">📄 ${esc(att.filename)} (document preview)</p><div class="doc">
        <h2>${esc(inv.vendorName.toUpperCase())}</h2><h3>INVOICE</h3>
        <p>Invoice No: <b>${esc(inv.number)}</b><br>Invoice date: ${esc(inv.issueDate)}<br>Payment due: <b>${esc(inv.dueDate)}</b><br>Bill to: Northwind Ops, 1 Harbour Way</p>
        <table><thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Line total</th></tr></thead><tbody>${lines}</tbody></table>
        <p style="text-align:right">Subtotal: ${money(sub, "")}<br>Tax: ${money(inv.tax, "")}<br><b>Total due: ${inv.currency} ${money(invoiceTotal(inv), "")}</b></p></div>`,
      ),
    );
  });

  app.get("/mail/:id", (req, res) => {
    const m = state.emails.find((e) => e.id === req.params.id);
    if (!m) return void res.status(404).send(page("Not found", "mail", "<h1>Message not found</h1>"));
    m.read = true;
    const atts = m.attachmentIds
      .map((id) => state.attachments.find((a) => a.id === id)!)
      .map((a) => `<li>📎 <a href="/mail/attachments/${a.id}">${esc(a.filename)}</a></li>`)
      .join("");
    res.send(
      page(
        m.subject,
        "mail",
        `<p><a href="/mail">← Inbox</a></p><h1>${esc(m.subject)}</h1>
        <p class="muted">From: ${esc(m.fromName)} &lt;${esc(m.fromEmail)}&gt;<br>Received: ${esc(m.date.replace("T", " ").slice(0, 16))} UTC</p>
        <pre>${esc(m.body)}</pre>${atts ? `<h3>Attachments</h3><ul>${atts}</ul>` : ""}`,
      ),
    );
  });

  // ---------- UI: billing ----------

  app.get("/erp", (_req, res) => res.redirect("/erp/bills"));

  app.get("/erp/bills", (req, res) => {
    const created = req.query.created ? `<p class="ok">Bill ${esc(req.query.created)} created.</p>` : "";
    const rows = [...state.bills]
      .reverse()
      .map(
        (b) => `<tr><td><a href="/erp/bills/${b.id}">${b.id}</a></td><td>${esc(vendorName(b.vendorId))}</td><td>${esc(b.invoiceNumber)}</td>
        <td>${money(b.amount, b.currency)}</td><td>${b.dueDate}</td><td>${b.status}</td></tr>`,
      )
      .join("");
    res.send(
      page(
        "Bills",
        "erp",
        `${created}<h1>Bills</h1><p><a href="/erp/bills/new">+ New bill</a></p>
        <table><thead><tr><th>Bill</th><th>Vendor</th><th>Invoice #</th><th>Amount</th><th>Due date</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`,
      ),
    );
  });

  const billForm = (values: Record<string, string> = {}, errors: string[] = []) => {
    const opts = state.vendors
      .map((v) => `<option value="${v.id}" ${values.vendorId === v.id ? "selected" : ""}>${esc(v.name)}</option>`)
      .join("");
    const curOpts = ["USD", "EUR", "GBP", "INR"].map((c) => `<option ${(values.currency ?? "USD") === c ? "selected" : ""}>${c}</option>`).join("");
    return page(
      "New bill",
      "erp",
      `<h1>New bill</h1>
      ${errors.length ? `<div class="err" role="alert"><b>Bill not saved:</b><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>` : ""}
      <form method="post" action="/erp/bills">
        <label for="vendorId">Vendor</label><select id="vendorId" name="vendorId"><option value="">— select vendor —</option>${opts}</select>
        <label for="invoiceNumber">Invoice number</label><input id="invoiceNumber" name="invoiceNumber" value="${esc(values.invoiceNumber)}">
        <label for="amount">Amount</label><input id="amount" name="amount" value="${esc(values.amount)}" placeholder="1234.56">
        <label for="currency">Currency</label><select id="currency" name="currency">${curOpts}</select>
        <label for="dueDate">Due date</label><input id="dueDate" name="dueDate" value="${esc(values.dueDate)}" placeholder="YYYY-MM-DD">
        <label for="notes">Notes</label><textarea id="notes" name="notes" rows="2">${esc(values.notes)}</textarea>
        <div><button type="submit">Save bill</button></div>
      </form>`,
    );
  };

  app.get("/erp/bills/new", (_req, res) => res.send(billForm()));

  app.post("/erp/bills", (req, res) => {
    const result = createBill(req.body);
    if (result.kind === "unavailable") return void res.status(503).send(unavailablePage());
    if (result.kind === "invalid") return void res.status(422).send(billForm(req.body, result.errors));
    res.redirect(`/erp/bills/${result.bill.id}?created=1`);
  });

  app.get("/erp/bills/:id", (req, res) => {
    const b = state.bills.find((x) => x.id === req.params.id);
    if (!b) return void res.status(404).send(page("Not found", "erp", "<h1>Bill not found</h1>"));
    res.send(
      page(
        b.id,
        "erp",
        `${req.query.created ? `<p class="ok" role="status">Bill ${b.id} was created successfully.</p>` : ""}
        <p><a href="/erp/bills">← Bills</a></p><h1>Bill ${b.id}</h1>
        <table><tbody>
        <tr><th>Vendor</th><td>${esc(vendorName(b.vendorId))} (${b.vendorId})</td></tr>
        <tr><th>Invoice number</th><td>${esc(b.invoiceNumber)}</td></tr>
        <tr><th>Amount</th><td>${money(b.amount, b.currency)}</td></tr>
        <tr><th>Due date</th><td>${b.dueDate}</td></tr>
        <tr><th>Status</th><td>${b.status}</td></tr>
        <tr><th>Notes</th><td>${esc(b.notes)}</td></tr>
        <tr><th>Created</th><td>${b.createdAt}</td></tr></tbody></table>`,
      ),
    );
  });

  app.get("/erp/vendors", (req, res) => {
    const rows = state.vendors
      .map((v) => `<tr><td><a href="/erp/vendors/${v.id}">${v.id}</a></td><td>${esc(v.name)}</td><td>${esc(v.contactEmail)}</td><td>${esc(v.paymentTerms)}</td></tr>`)
      .join("");
    res.send(
      page(
        "Vendors",
        "vendors",
        `${req.query.updated ? `<p class="ok">Vendor ${esc(req.query.updated)} updated.</p>` : ""}<h1>Vendors</h1>
        <table><thead><tr><th>ID</th><th>Name</th><th>Billing contact</th><th>Terms</th></tr></thead><tbody>${rows}</tbody></table>`,
      ),
    );
  });

  const vendorForm = (id: string, errors: string[] = []) => {
    const v = state.vendors.find((x) => x.id === id)!;
    return page(
      v.name,
      "vendors",
      `<p><a href="/erp/vendors">← Vendors</a></p><h1>Edit vendor ${v.id}</h1>
      ${errors.length ? `<div class="err" role="alert">${errors.map(esc).join("<br>")}</div>` : ""}
      <form method="post" action="/erp/vendors/${v.id}">
        <label for="name">Name</label><input id="name" name="name" value="${esc(v.name)}">
        <label for="contactEmail">Billing contact email</label><input id="contactEmail" name="contactEmail" value="${esc(v.contactEmail)}">
        <label for="paymentTerms">Payment terms</label><input id="paymentTerms" name="paymentTerms" value="${esc(v.paymentTerms)}">
        <div><button type="submit">Save vendor</button></div></form>`,
    );
  };

  function updateVendor(id: string, input: Record<string, unknown>): string[] {
    const v = state.vendors.find((x) => x.id === id);
    if (!v) return ["Vendor not found."];
    const email = input.contactEmail !== undefined ? String(input.contactEmail).trim() : v.contactEmail;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return [`Invalid email address "${email}".`];
    if (input.name !== undefined && String(input.name).trim()) v.name = String(input.name).trim();
    if (input.paymentTerms !== undefined && String(input.paymentTerms).trim()) v.paymentTerms = String(input.paymentTerms).trim();
    v.contactEmail = email;
    return [];
  }

  app.get("/erp/vendors/:id", (req, res) => {
    if (!state.vendors.some((v) => v.id === req.params.id)) return void res.status(404).send(page("Not found", "vendors", "<h1>Vendor not found</h1>"));
    res.send(vendorForm(req.params.id));
  });

  app.post("/erp/vendors/:id", (req, res) => {
    const errors = updateVendor(req.params.id, req.body);
    if (errors.length) return void res.status(422).send(vendorForm(req.params.id, errors));
    res.redirect(`/erp/vendors?updated=${req.params.id}`);
  });

  // ---------- UI: chat ----------

  app.get("/chat", (_req, res) => res.redirect("/chat/finance"));

  app.get("/chat/:channel", (req, res) => {
    const ch = req.params.channel;
    if (!["finance", "general"].includes(ch)) return void res.status(404).send(page("Not found", "chat", "<h1>No such channel</h1>"));
    const msgs = state.chat
      .filter((m) => m.channel === ch)
      .map((m) => `<div class="msg"><b>${esc(m.author)}</b> <span class="muted">${m.at.slice(0, 16).replace("T", " ")}</span><div>${esc(m.text)}</div></div>`)
      .join("");
    res.send(
      page(
        `#${ch}`,
        "chat",
        `<p><a href="/chat/finance">#finance</a> · <a href="/chat/general">#general</a></p><h1>#${ch}</h1>${msgs}
        <form method="post" action="/chat/${ch}"><label for="text">Message</label><textarea id="text" name="text" rows="2"></textarea>
        <div><button type="submit">Send message</button></div></form>`,
      ),
    );
  });

  app.post("/chat/:channel", (req, res) => {
    const text = String(req.body.text ?? "").trim();
    if (text) state.chat.push({ id: state.nextChatId++, channel: req.params.channel, author: "AI Worker (bot)", text, at: new Date().toISOString() });
    res.redirect(`/chat/${req.params.channel}`);
  });

  // ---------- JSON API ----------

  app.get("/api", (_req, res) => {
    res.json({
      name: "Northwind Ops API",
      endpoints: [
        "GET    /api/emails?q=text            list emails (newest first) with attachment ids",
        "GET    /api/emails/:id               one email",
        "GET    /api/attachments/:id          parsed invoice attachment",
        "GET    /api/vendors                  list vendors",
        "PATCH  /api/vendors/:id              update vendor {name?, contactEmail?, paymentTerms?}",
        "GET    /api/bills?vendorId=&invoiceNumber=   list/search bills",
        "GET    /api/bills/:id                one bill",
        "POST   /api/bills                    create bill {vendorId, invoiceNumber, amount (number), currency, dueDate (YYYY-MM-DD), notes?}",
        "GET    /api/chat/:channel            list messages (channels: finance, general)",
        "POST   /api/chat/:channel            post message {text}",
      ],
    });
  });

  app.get("/api/emails", (req, res) => {
    const q = String(req.query.q ?? "").toLowerCase();
    res.json(
      [...state.emails]
        .filter((m) => !q || `${m.fromName} ${m.fromEmail} ${m.subject} ${m.body}`.toLowerCase().includes(q))
        .sort((a, b) => b.date.localeCompare(a.date)),
    );
  });
  app.get("/api/emails/:id", (req, res) => {
    const m = state.emails.find((e) => e.id === req.params.id);
    m ? res.json(m) : res.status(404).json({ error: "not found" });
  });
  app.get("/api/attachments/:id", (req, res) => {
    const a = state.attachments.find((x) => x.id === req.params.id);
    a ? res.json({ ...a, invoice: { ...a.invoice, total: invoiceTotal(a.invoice) } }) : res.status(404).json({ error: "not found" });
  });
  app.get("/api/vendors", (_req, res) => res.json(state.vendors));
  app.patch("/api/vendors/:id", (req, res) => {
    const errors = updateVendor(req.params.id, req.body ?? {});
    if (errors.length) return void res.status(errors[0] === "Vendor not found." ? 404 : 422).json({ errors });
    res.json(state.vendors.find((v) => v.id === req.params.id));
  });
  app.get("/api/bills", (req, res) => {
    const { vendorId, invoiceNumber } = req.query as Record<string, string | undefined>;
    res.json(
      state.bills.filter(
        (b) => (!vendorId || b.vendorId === vendorId) && (!invoiceNumber || b.invoiceNumber.toLowerCase() === invoiceNumber.toLowerCase()),
      ),
    );
  });
  app.get("/api/bills/:id", (req, res) => {
    const b = state.bills.find((x) => x.id === req.params.id);
    b ? res.json(b) : res.status(404).json({ error: "not found" });
  });
  app.post("/api/bills", (req, res) => {
    const result = createBill(req.body ?? {});
    if (result.kind === "unavailable") return void res.status(503).json({ error: "Service temporarily unavailable. The bill was not saved; retry later." });
    if (result.kind === "invalid") return void res.status(422).json({ errors: result.errors });
    res.status(201).json(result.bill);
  });
  app.get("/api/chat/:channel", (req, res) => res.json(state.chat.filter((m) => m.channel === req.params.channel)));
  app.post("/api/chat/:channel", (req, res) => {
    const text = String(req.body?.text ?? "").trim();
    if (!text) return void res.status(422).json({ errors: ["text is required"] });
    const msg = { id: state.nextChatId++, channel: req.params.channel, author: "AI Worker (bot)", text, at: new Date().toISOString() };
    state.chat.push(msg);
    res.status(201).json(msg);
  });

  // Admin endpoints for tests and the demo UI (not advertised in /api).
  app.post("/admin/reset", (_req, res) => {
    reset();
    res.json({ ok: true });
  });
  app.get("/admin/state", (_req: Request, res: Response) => res.json(state));

  return { app, reset, getState: () => state };
}
