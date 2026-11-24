// Offline demo: starts the real API on a random local port with an in-memory store,
// walks one project through the full change order lifecycle over HTTP, and prints each step.
// A fixed clock keeps the output identical from run to run.
import type { AddressInfo } from "node:net";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/server.ts";
import { Tracker } from "../src/tracker.ts";

let tick = 0;
const db = openDb();
const tracker = new Tracker(db, () => new Date(Date.UTC(2030, 2, 4, 14, 0, 0) + tick++ * 90_000));
tracker.createProject({ name: "Sample Kitchen Refresh", customerName: "Alex Sample", customerEmail: "alex.sample@example.com", baseContractCents: 1850000 });

const server = createApp(tracker);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const money = (c: number) => (c < 0 ? "-" : "") + "$" + (Math.abs(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
async function call(path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(base + path, body === undefined ? {} : {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "demo-script" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}
async function showTotal(label: string) {
  const p = (await call("/api/projects/1")).data;
  console.log(`   contract total ${label}: ${money(p.contractTotalCents)} (base ${money(p.baseContractCents)}, approved changes ${money(p.approvedChangeCents)}, awaiting approval ${money(p.pendingCents)})`);
}
const step = (n: number, title: string) => console.log(`\n${n}. ${title}`);

console.log("Change order tracker demo (fake data, in-memory store, no network beyond localhost)");
console.log("Project: Sample Kitchen Refresh, customer: Alex Sample");
await showTotal("at start");

step(1, "Field lead requests a change");
const co1 = (await call("/api/projects/1/change-orders", { title: "Add under-cabinet lighting", description: "LED strips under the upper cabinets, north wall.", requestedBy: "Sam Fieldlead" })).data;
console.log(`   CO-${co1.number} "${co1.title}" status=${co1.status}`);
await showTotal("after request");

step(2, "Office prices it");
const priced = (await call(`/api/change-orders/${co1.id}/price`, { pricedBy: "Pat Estimator", lineItems: [
  { description: "LED strip kit", quantity: 3, unitPriceCents: 4500 },
  { description: "Electrician labor (hours)", quantity: 4, unitPriceCents: 9500 },
] })).data;
for (const i of priced.lineItems) console.log(`   ${i.quantity} x ${i.description} @ ${money(i.unitPriceCents)} = ${money(i.quantity * i.unitPriceCents)}`);
console.log(`   CO-${priced.number} total ${money(priced.totalCents)} status=${priced.status}`);
await showTotal("after pricing");

step(3, "Someone else tries to sign for the customer");
const forged = await call(`/api/change-orders/${co1.id}/approve`, { typedName: "Robin Notcustomer", expectedTotalCents: priced.totalCents });
console.log(`   HTTP ${forged.status}: ${forged.data.error}`);

step(4, "Office reprices; customer tries to approve the old price they were shown");
const repriced = (await call(`/api/change-orders/${co1.id}/price`, { pricedBy: "Pat Estimator", lineItems: [
  { description: "LED strip kit", quantity: 3, unitPriceCents: 4500 },
  { description: "Electrician labor (hours)", quantity: 5, unitPriceCents: 9500 },
] })).data;
console.log(`   new total ${money(repriced.totalCents)}`);
const stale = await call(`/api/change-orders/${co1.id}/approve`, { typedName: "Alex Sample", expectedTotalCents: priced.totalCents });
console.log(`   HTTP ${stale.status}: ${stale.data.error}`);
await showTotal("still");

step(5, "Customer approves the current price by typing their name");
const approved = (await call(`/api/change-orders/${co1.id}/approve`, { typedName: "Alex Sample", expectedTotalCents: repriced.totalCents })).data;
console.log(`   status=${approved.status}`);
console.log(`   signature: typed name "${approved.signature.typedName}", signed at ${approved.signature.signedAt}, amount ${money(approved.signature.totalCents)}`);
console.log(`   document hash: ${approved.signature.documentHash}`);
await showTotal("after approval");

step(6, "A second change is priced as a credit and declined");
const co2 = (await call("/api/projects/1/change-orders", { title: "Delete pantry shelving", description: "Customer will supply their own shelving.", requestedBy: "Sam Fieldlead" })).data;
await call(`/api/change-orders/${co2.id}/price`, { pricedBy: "Pat Estimator", lineItems: [{ description: "Credit: shelving package", quantity: 1, unitPriceCents: -38000 }] });
const declined = (await call(`/api/change-orders/${co2.id}/decline`, { typedName: "Alex Sample", reason: "Keeping the shelving after all" })).data;
console.log(`   CO-${declined.number} total ${money(declined.totalCents)} status=${declined.status}, signed "${declined.signature.typedName}"`);
await showTotal("after decline");

step(7, "Trying to change an approved change order");
const late = await call(`/api/change-orders/${co1.id}/price`, { pricedBy: "Pat Estimator", lineItems: [{ description: "Sneaky extra", quantity: 1, unitPriceCents: 99900 }] });
console.log(`   API: HTTP ${late.status}: ${late.data.error}`);
for (const sql of [
  "UPDATE projects SET contract_total_cents = contract_total_cents + 99900",
  "UPDATE signatures SET typed_name = 'Forged Name'",
  "DELETE FROM audit_events WHERE id = 3",
]) {
  try { db.exec(sql); console.log(`   SQL accepted (unexpected): ${sql}`); }
  catch (e) { console.log(`   raw SQL "${sql}" -> blocked: ${(e as Error).message}`); }
}
await showTotal("unchanged");

step(8, "Audit trail");
for (const e of (await call("/api/audit?projectId=1")).data) {
  console.log(`   #${e.id} ${e.at} ${e.actor.padEnd(22)} ${e.action.padEnd(24)} hash ${e.hash.slice(0, 12)}`);
}
const verify = (await call("/api/audit/verify")).data;
console.log(`   hash chain verified: ${verify.ok} (${verify.events} events)`);

server.close();
