import { BASE } from "./helpers.js";
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createMockco } from "../src/mockco/app.js";

const mockco = createMockco({ chaos: true });
let server: Server;
before(() => new Promise<void>((r) => (server = mockco.app.listen(4555, r))));
after(() => server.close());
beforeEach(() => mockco.reset());

const post = (path: string, body: unknown) => fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const good = { vendorId: "V-001", invoiceNumber: "INV-2026-0931", amount: "12480.50", currency: "USD", dueDate: "2026-11-15" };

test("seed invoice totals match the amounts quoted in emails", async () => {
  const att = await (await fetch(`${BASE}/api/attachments/att-acme-0815`)).json();
  assert.equal(att.invoice.total, 4250);
  const latest = await (await fetch(`${BASE}/api/attachments/att-acme-0931`)).json();
  assert.equal(latest.invoice.total, 12480.5);
});

test("chaos: first bill submission fails with 503 and saves nothing, the retry succeeds", async () => {
  const first = await post("/api/bills", good);
  assert.equal(first.status, 503);
  assert.equal(mockco.getState().bills.length, 3);
  const second = await post("/api/bills", good);
  assert.equal(second.status, 201);
  assert.equal(mockco.getState().bills.length, 4);
});

test("validation rejects human-formatted amounts and dates", async () => {
  await post("/api/bills", good); // consume the chaos failure
  const res = await post("/api/bills", { ...good, amount: "12,480.50", dueDate: "15 November 2026" });
  assert.equal(res.status, 422);
  const { errors } = await res.json();
  assert.equal(errors.length, 2);
});

test("duplicate invoice numbers are rejected", async () => {
  await post("/api/bills", good);
  const res = await post("/api/bills", { ...good, invoiceNumber: "INV-2026-0815", amount: "4250" });
  assert.equal(res.status, 422);
  assert.match((await res.json()).errors[0], /Duplicate.*B-1003/);
});

test("UI form re-renders with errors and keeps values", async () => {
  await post("/api/bills", good);
  const res = await fetch(`${BASE}/erp/bills`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...good, dueDate: "15/11/2026" }).toString(),
  });
  assert.equal(res.status, 422);
  const html = await res.text();
  assert.match(html, /Bill not saved/);
  assert.match(html, /value="INV-2026-0931"/);
});
