import { mockcoUrl } from "../config.js";

/**
 * Describes the environment the worker operates in. This is the *only* place that knows about
 * Northwind Ops — the agent loop, tools and prompts are task- and company-agnostic. Pointing the
 * worker at another environment means editing this manifest (and the URL allowlist), nothing else.
 */
export function environmentManifest(): string {
  const base = mockcoUrl();
  return `You work for Northwind Ops as a back-office assistant for the finance team.
Systems you can use (all internal, no login needed):
- Mail (finance@northwind.example shared inbox): ${base}/mail  — emails, with invoice attachments viewable in the browser.
- Billing / ERP: ${base}/erp/bills (bills), ${base}/erp/bills/new (create bill), ${base}/erp/vendors (vendor master data).
- Team chat: ${base}/chat/finance and ${base}/chat/general.
- REST API (JSON) for the same systems: GET ${base}/api lists endpoints. Often faster and more precise than the UI.
- Shared drive (file tools): 'shared/' holds team documents and policies; write any reports to 'output/'.`;
}
