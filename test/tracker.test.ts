import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { Tracker, TrackerError, hashDocument } from "../src/tracker.ts";

function setup() {
  let tick = 0;
  const db = openDb();
  const tracker = new Tracker(db, () => new Date(Date.UTC(2030, 0, 1, 12, 0, tick++)));
  const project = tracker.createProject({
    name: "Test Deck Build",
    customerName: "Casey Example",
    customerEmail: "casey@example.com",
    baseContractCents: 1000000,
  });
  return { db, tracker, project };
}

function pricedOrder(tracker: Tracker, projectId: number) {
  const co = tracker.requestChangeOrder(projectId, { title: "Add stairs", description: "Second stair run", requestedBy: "Field Tester" });
  return tracker.priceChangeOrder(co.id, {
    pricedBy: "Office Tester",
    lineItems: [
      { description: "Stringers", quantity: 3, unitPriceCents: 4000 },
      { description: "Labor hours", quantity: 5, unitPriceCents: 8000 },
    ],
  });
}

const total = (tracker: Tracker, id: number) => tracker.getProject(id).contractTotalCents;

test("request and pricing never move the contract total", () => {
  const { tracker, project } = setup();
  const co = pricedOrder(tracker, project.id);
  assert.equal(co.status, "priced");
  assert.equal(co.totalCents, 52000);
  assert.equal(co.number, 1);
  assert.equal(total(tracker, project.id), 1000000);
  assert.equal(tracker.getProject(project.id).pendingCents, 52000);
});

test("approval records a typed-name signature and updates the contract total", () => {
  const { tracker, project } = setup();
  const co = pricedOrder(tracker, project.id);
  const done = tracker.decide(co.id, "approved", { typedName: "  casey   EXAMPLE ", expectedTotalCents: 52000 }, { ip: "127.0.0.1", userAgent: "test" });
  assert.equal(done.status, "approved");
  assert.equal(done.signature?.typedName, "casey   EXAMPLE");
  assert.equal(done.signature?.signedAt, done.decidedAt);
  assert.match(done.signature!.signedAt, /^2030-01-01T12:00:\d\d\.000Z$/);
  assert.equal(done.signature?.totalCents, 52000);
  assert.equal(done.signature?.documentHash, hashDocument(co));
  assert.equal(done.signature?.ip, "127.0.0.1");
  assert.equal(total(tracker, project.id), 1052000);
});

test("approval is rejected for a wrong name, a stale price, or an unpriced order", () => {
  const { tracker, project } = setup();
  const co = pricedOrder(tracker, project.id);
  const status = (fn: () => unknown) => {
    try { fn(); } catch (e) { return (e as TrackerError).status; }
    return 0;
  };
  assert.equal(status(() => tracker.decide(co.id, "approved", { typedName: "Someone Else", expectedTotalCents: 52000 })), 422);
  assert.equal(status(() => tracker.decide(co.id, "approved", { typedName: "Casey Example", expectedTotalCents: 1 })), 409);
  assert.equal(status(() => tracker.decide(co.id, "approved", { typedName: "", expectedTotalCents: 52000 })), 400);
  // A missing or non-numeric amount is a bad request, not a "price changed" conflict.
  assert.equal(status(() => tracker.decide(co.id, "approved", { typedName: "Casey Example" })), 400);
  assert.equal(status(() => tracker.decide(co.id, "approved", { typedName: "Casey Example", expectedTotalCents: "52000" })), 400);
  const bare = tracker.requestChangeOrder(project.id, { title: "T", description: "D", requestedBy: "R" });
  assert.equal(status(() => tracker.decide(bare.id, "approved", { typedName: "Casey Example", expectedTotalCents: 0 })), 409);
  assert.equal(total(tracker, project.id), 1000000);
  assert.equal(tracker.getChangeOrder(co.id).signature, null);
});

test("decline is signed and leaves the contract total alone", () => {
  const { tracker, project } = setup();
  const co = pricedOrder(tracker, project.id);
  const done = tracker.decide(co.id, "declined", { typedName: "Casey Example", reason: "Too expensive" });
  assert.equal(done.status, "declined");
  assert.equal(done.signature?.decision, "declined");
  assert.equal(total(tracker, project.id), 1000000);
});

test("a decided change order cannot be repriced or decided again", () => {
  const { tracker, project } = setup();
  const co = pricedOrder(tracker, project.id);
  tracker.decide(co.id, "approved", { typedName: "Casey Example", expectedTotalCents: 52000 });
  assert.throws(() => tracker.priceChangeOrder(co.id, { pricedBy: "X", lineItems: [{ description: "x", quantity: 1, unitPriceCents: 1 }] }), /already approved/);
  assert.throws(() => tracker.decide(co.id, "approved", { typedName: "Casey Example", expectedTotalCents: 52000 }), /only a priced/);
  assert.equal(total(tracker, project.id), 1052000);
});

test("repricing before the decision replaces line items; credits can be negative", () => {
  const { tracker, project } = setup();
  const co = pricedOrder(tracker, project.id);
  const again = tracker.priceChangeOrder(co.id, { pricedBy: "Office Tester", lineItems: [{ description: "Credit for deleted railing", quantity: 1, unitPriceCents: -30000 }] });
  assert.equal(again.lineItems.length, 1);
  assert.equal(again.totalCents, -30000);
  tracker.decide(co.id, "approved", { typedName: "Casey Example", expectedTotalCents: -30000 });
  assert.equal(total(tracker, project.id), 970000);
});

test("pricing input is validated", () => {
  const { tracker, project } = setup();
  const co = tracker.requestChangeOrder(project.id, { title: "T", description: "D", requestedBy: "R" });
  assert.throws(() => tracker.priceChangeOrder(co.id, { pricedBy: "X", lineItems: [] }), TrackerError);
  assert.throws(() => tracker.priceChangeOrder(co.id, { pricedBy: "X", lineItems: [{ description: "x", quantity: 1.5, unitPriceCents: 100 }] }), /whole number/);
  assert.throws(() => tracker.priceChangeOrder(co.id, { pricedBy: "X", lineItems: [{ description: "x", quantity: 0, unitPriceCents: 100 }] }), /positive/);
  assert.throws(() => tracker.priceChangeOrder(999, { pricedBy: "X", lineItems: [{ description: "x", quantity: 1, unitPriceCents: 1 }] }), /not found/);
  assert.equal(tracker.getChangeOrder(co.id).status, "requested");
});

test("database triggers block direct tampering", () => {
  const { db, tracker, project } = setup();
  const co = pricedOrder(tracker, project.id);
  // Contract total cannot be edited directly, with or without an approval pending.
  assert.throws(() => db.exec("UPDATE projects SET contract_total_cents = contract_total_cents + 52000"), /only through approved/);
  assert.throws(() => db.exec("UPDATE projects SET base_contract_cents = 1"), /only through approved/);
  tracker.decide(co.id, "approved", { typedName: "Casey Example", expectedTotalCents: 52000 });
  assert.throws(() => db.exec("UPDATE audit_events SET actor = 'nobody'"), /append only/);
  assert.throws(() => db.exec("DELETE FROM audit_events"), /append only/);
  assert.throws(() => db.exec("UPDATE signatures SET typed_name = 'Forged Name'"), /immutable/);
  assert.throws(() => db.exec("DELETE FROM signatures"), /immutable/);
  assert.throws(() => db.exec("UPDATE change_orders SET total_cents = 1"), /frozen/);
  assert.throws(() => db.exec("UPDATE line_items SET unit_price_cents = 1"), /frozen/);
  assert.throws(() => db.exec("DELETE FROM line_items"), /frozen/);
  assert.equal(total(tracker, project.id), 1052000);
});

test("database refuses an approval, decline or signature that skips the signing step", () => {
  const { db, tracker, project } = setup();
  const co = pricedOrder(tracker, project.id);
  const bare = tracker.requestChangeOrder(project.id, { title: "T", description: "D", requestedBy: "R" });
  const sign = (id: number, cents: number) =>
    db.exec(`INSERT INTO signatures (change_order_id, decision, typed_name, signed_at, total_cents, document_hash, ip, user_agent) VALUES (${id}, 'approved', 'Casey Example', '2030-01-01T00:00:00.000Z', ${cents}, 'x', 'x', 'x')`);
  // Flipping the status by hand, with no signature on file.
  assert.throws(() => db.exec(`UPDATE change_orders SET status = 'approved' WHERE id = ${co.id}`), /matching signature/);
  assert.throws(() => db.exec(`UPDATE change_orders SET status = 'declined' WHERE id = ${co.id}`), /matching signature/);
  // Creating a change order that is born approved.
  assert.throws(() => db.exec(`INSERT INTO change_orders (project_id, number, title, description, requested_by, status, total_cents, created_at) VALUES (${project.id}, 9, 'T', 'D', 'R', 'approved', 500000, 'x')`), /starts as requested/);
  // Signing something that is not priced, or signing a different amount than the priced total.
  assert.throws(() => sign(bare.id, 0), /priced change order/);
  assert.throws(() => sign(co.id, 1), /priced change order/);
  assert.equal(tracker.getChangeOrder(co.id).status, "priced");
  assert.equal(tracker.getChangeOrder(co.id).signature, null);
  assert.equal(total(tracker, project.id), 1000000);
  // The normal path still works after all of that.
  assert.equal(tracker.decide(co.id, "approved", { typedName: "Casey Example", expectedTotalCents: 52000 }).status, "approved");
  assert.equal(total(tracker, project.id), 1052000);
});

test("audit trail records every step in order and the hash chain verifies", () => {
  const { db, tracker, project } = setup();
  const co = pricedOrder(tracker, project.id);
  tracker.priceChangeOrder(co.id, { pricedBy: "Office Tester", lineItems: [{ description: "Flat price", quantity: 1, unitPriceCents: 60000 }] });
  tracker.decide(co.id, "approved", { typedName: "Casey Example", expectedTotalCents: 60000 });
  const events = tracker.listAudit(project.id);
  assert.deepEqual(events.map((e) => e.action), [
    "project.created", "change_order.requested", "change_order.priced", "change_order.repriced", "change_order.approved",
  ]);
  const approved = events.at(-1)!.payload as Record<string, number>;
  assert.equal(approved.contractTotalBeforeCents, 1000000);
  assert.equal(approved.contractTotalAfterCents, 1060000);
  assert.equal(events.at(-1)!.actor, "customer:Casey Example");
  assert.deepEqual(tracker.verifyAudit(), { ok: true, events: 5, brokenAtId: null });

  // Someone with raw database access drops the trigger and edits history: the chain exposes it.
  db.exec("DROP TRIGGER audit_no_update");
  db.exec("UPDATE audit_events SET payload = '{\"totalCents\":1}' WHERE id = 3");
  assert.deepEqual(tracker.verifyAudit(), { ok: false, events: 5, brokenAtId: 3 });
});

test("failed operations leave no audit event behind", () => {
  const { tracker, project } = setup();
  const co = pricedOrder(tracker, project.id);
  const before = tracker.listAudit().length;
  assert.throws(() => tracker.decide(co.id, "approved", { typedName: "Wrong Person", expectedTotalCents: 52000 }));
  assert.equal(tracker.listAudit().length, before);
});
