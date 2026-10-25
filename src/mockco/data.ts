/**
 * Seed data for "Northwind Ops", the simulated company the agent works in.
 *
 * The data contains deliberate traps so that a naive agent fails:
 *  - The most recent Acme email is a *reminder* about an old invoice, not the latest invoice.
 *  - Two vendors start with "Acme" (Acme Corp vs Acme Logistics).
 *  - Invoice amounts are formatted "12,480.50" and dates "15 November 2026", but the ERP only
 *    accepts plain numbers and ISO dates.
 *  - The older Acme invoice is already in the ERP, so re-entering it is a duplicate.
 */

export interface Vendor {
  id: string;
  name: string;
  contactEmail: string;
  paymentTerms: string;
}

export interface InvoiceLine {
  description: string;
  qty: number;
  unitPrice: number;
}

export interface Attachment {
  id: string;
  filename: string;
  invoice: {
    number: string;
    vendorName: string;
    issueDate: string; // human formatted on purpose
    dueDate: string; // human formatted on purpose
    currency: string;
    lines: InvoiceLine[];
    tax: number;
  };
}

export interface Email {
  id: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  date: string; // ISO timestamp
  body: string;
  attachmentIds: string[];
  read: boolean;
}

export interface Bill {
  id: string;
  vendorId: string;
  invoiceNumber: string;
  amount: number;
  currency: string;
  dueDate: string; // YYYY-MM-DD
  notes: string;
  status: "Pending approval" | "Approved" | "Paid";
  createdAt: string;
}

export interface ChatMessage {
  id: number;
  channel: string;
  author: string;
  text: string;
  at: string;
}

export interface State {
  vendors: Vendor[];
  emails: Email[];
  attachments: Attachment[];
  bills: Bill[];
  chat: ChatMessage[];
  nextBillNo: number;
  nextChatId: number;
  /** Chaos: the next bill submission fails with a 503 once. */
  failNextBillSubmit: boolean;
}

export function invoiceTotal(inv: Attachment["invoice"]): number {
  const sub = inv.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
  return Math.round((sub + inv.tax) * 100) / 100;
}

export function seed(chaos: boolean): State {
  const vendors: Vendor[] = [
    { id: "V-001", name: "Acme Corp", contactEmail: "billing@acmecorp.example", paymentTerms: "Net 45" },
    { id: "V-002", name: "Acme Logistics", contactEmail: "accounts@acmelogistics.example", paymentTerms: "Net 30" },
    { id: "V-003", name: "Globex Ltd", contactEmail: "ar@globex.example", paymentTerms: "Net 30" },
    { id: "V-004", name: "Initech", contactEmail: "billing@initech.example", paymentTerms: "Net 15" },
    { id: "V-005", name: "Umbrella Supplies", contactEmail: "invoices@umbrella.example", paymentTerms: "Net 60" },
  ];

  const attachments: Attachment[] = [
    {
      id: "att-acme-0815",
      filename: "Acme_Invoice_INV-2026-0815.pdf",
      invoice: {
        number: "INV-2026-0815",
        vendorName: "Acme Corp",
        issueDate: "18 August 2026",
        dueDate: "2 October 2026",
        currency: "USD",
        lines: [
          { description: "Industrial fasteners (box of 500)", qty: 10, unitPrice: 310 },
          { description: "Freight & handling", qty: 1, unitPrice: 815.53 },
        ],
        tax: 334.47,
      },
    },
    {
      id: "att-acme-0931",
      filename: "Acme_Invoice_INV-2026-0931.pdf",
      invoice: {
        number: "INV-2026-0931",
        vendorName: "Acme Corp",
        issueDate: "1 October 2026",
        dueDate: "15 November 2026",
        currency: "USD",
        lines: [
          { description: "Hydraulic press maintenance (Q4)", qty: 1, unitPrice: 8400 },
          { description: "Replacement seals kit", qty: 6, unitPrice: 450 },
          { description: "On-site technician (hours)", qty: 4, unitPrice: 85 },
        ],
        tax: 1040.5,
      },
    },
    {
      id: "att-globex-7781",
      filename: "Globex_GX-7781.pdf",
      invoice: {
        number: "GX-7781",
        vendorName: "Globex Ltd",
        issueDate: "5 October 2026",
        dueDate: "4 November 2026",
        currency: "USD",
        lines: [{ description: "Cloud analytics licence (October)", qty: 1, unitPrice: 3100 }],
        tax: 0,
      },
    },
    {
      id: "att-acmelog-5520",
      filename: "AcmeLogistics_AL-5520.pdf",
      invoice: {
        number: "AL-5520",
        vendorName: "Acme Logistics",
        issueDate: "8 October 2026",
        dueDate: "7 November 2026",
        currency: "USD",
        lines: [{ description: "Pallet shipping, Chicago → Dallas", qty: 2, unitPrice: 445 }],
        tax: 0,
      },
    },
  ];

  const emails: Email[] = [
    {
      id: "m-101",
      fromName: "Acme Corp Billing",
      fromEmail: "billing@acmecorp.example",
      subject: "Invoice INV-2026-0815",
      date: "2026-08-18T09:12:00Z",
      body: "Hello Northwind team,\n\nPlease find attached invoice INV-2026-0815 for the August fastener order.\n\nRegards,\nAcme Corp Billing",
      attachmentIds: ["att-acme-0815"],
      read: true,
    },
    {
      id: "m-102",
      fromName: "Ops Weekly",
      fromEmail: "newsletter@opsweekly.example",
      subject: "5 ways to speed up your month-end close",
      date: "2026-09-29T07:00:00Z",
      body: "This week: automation tips for finance teams...\n\n(Newsletter — no action needed.)",
      attachmentIds: [],
      read: true,
    },
    {
      id: "m-103",
      fromName: "Acme Corp Billing",
      fromEmail: "billing@acmecorp.example",
      subject: "Your October invoice",
      date: "2026-10-01T14:30:00Z",
      body: "Hi,\n\nAttached is our invoice for the Q4 hydraulic press maintenance visit.\nPayment terms are Net 45.\n\nThanks for your business,\nAcme Corp Billing",
      attachmentIds: ["att-acme-0931"],
      read: false,
    },
    {
      id: "m-104",
      fromName: "Globex Accounts Receivable",
      fromEmail: "ar@globex.example",
      subject: "Invoice GX-7781 — October licence",
      date: "2026-10-05T10:05:00Z",
      body: "Dear customer,\n\nYour invoice GX-7781 is attached.\n\nGlobex AR",
      attachmentIds: ["att-globex-7781"],
      read: false,
    },
    {
      id: "m-105",
      fromName: "Acme Logistics Accounts",
      fromEmail: "accounts@acmelogistics.example",
      subject: "Invoice AL-5520",
      date: "2026-10-08T16:45:00Z",
      body: "Hi Northwind,\n\nInvoice AL-5520 for last week's pallet shipments is attached.\n\nAcme Logistics",
      attachmentIds: ["att-acmelog-5520"],
      read: false,
    },
    {
      id: "m-106",
      fromName: "Acme Corp Billing",
      fromEmail: "billing@acmecorp.example",
      subject: "Reminder: INV-2026-0815 is overdue",
      date: "2026-10-12T08:20:00Z",
      body: "Hello,\n\nThis is a friendly reminder that invoice INV-2026-0815 (USD 4,250.00) was due on 2 October 2026.\nIf you have already paid, please ignore this message.\n\nAcme Corp Billing",
      attachmentIds: [],
      read: false,
    },
    {
      id: "m-107",
      fromName: "Initech Billing",
      fromEmail: "billing@initech.example",
      subject: "Change of accounts payable contact",
      date: "2026-10-14T11:00:00Z",
      body: "Hello,\n\nPlease note that from now on all billing correspondence should go to ap-team@initech.example instead of billing@initech.example.\n\nBest,\nInitech",
      attachmentIds: [],
      read: false,
    },
  ];

  const bills: Bill[] = [
    {
      id: "B-1001",
      vendorId: "V-003",
      invoiceNumber: "GX-7702",
      amount: 3100,
      currency: "USD",
      dueDate: "2026-09-30",
      notes: "September licence",
      status: "Paid",
      createdAt: "2026-09-02T10:00:00Z",
    },
    {
      id: "B-1002",
      vendorId: "V-004",
      invoiceNumber: "IN-3391",
      amount: 1275,
      currency: "USD",
      dueDate: "2026-10-20",
      notes: "",
      status: "Approved",
      createdAt: "2026-10-03T12:00:00Z",
    },
    {
      id: "B-1003",
      vendorId: "V-001",
      invoiceNumber: "INV-2026-0815",
      amount: 4250,
      currency: "USD",
      dueDate: "2026-10-02",
      notes: "August fastener order",
      status: "Approved",
      createdAt: "2026-08-20T09:00:00Z",
    },
  ];

  const chat: ChatMessage[] = [
    { id: 1, channel: "finance", author: "Priya (Finance Lead)", text: "Reminder: all vendor invoices received this month need to be in the billing system by the 31st.", at: "2026-10-20T09:00:00Z" },
    { id: 2, channel: "general", author: "Sam (Ops)", text: "Office closed on Friday for maintenance.", at: "2026-10-21T15:00:00Z" },
  ];

  return { vendors, emails, attachments, bills, chat, nextBillNo: 1004, nextChatId: 3, failNextBillSubmit: chaos };
}
