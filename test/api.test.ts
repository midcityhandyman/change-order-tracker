import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { openDb } from "../src/db.ts";
import { seed } from "../src/seed.ts";
import { createApp } from "../src/server.ts";
import { Tracker } from "../src/tracker.ts";

const tracker = new Tracker(openDb());
seed(tracker);
const server = createApp(tracker);
let base = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function call(path: string, body?: unknown) {
  const res = await fetch(base + path, body === undefined ? {} : {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "api-test" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as any };
}

test("serves the web page", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Change Order Tracker/);
});

test("full flow over HTTP: request, price, approve, contract total updates once", async () => {
  const start = (await call("/api/projects/2")).data.contractTotalCents;
  const created = await call("/api/projects/2/change-orders", { title: "Egress window", description: "Add one egress window", requestedBy: "Sam Fieldlead" });
  assert.equal(created.status, 201);
  const id = created.data.id;

  const priced = await call(`/api/change-orders/${id}/price`, { pricedBy: "Pat Estimator", lineItems: [{ description: "Window and well", quantity: 1, unitPriceCents: 420000 }] });
  assert.equal(priced.data.totalCents, 420000);
  assert.equal((await call("/api/projects/2")).data.contractTotalCents, start);

  const wrong = await call(`/api/change-orders/${id}/approve`, { typedName: "Alex Sample", expectedTotalCents: 420000 });
  assert.equal(wrong.status, 422);

  const ok = await call(`/api/change-orders/${id}/approve`, { typedName: "Jordan Placeholder", expectedTotalCents: 420000 });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.signature.userAgent, "api-test");
  assert.equal((await call("/api/projects/2")).data.contractTotalCents, start + 420000);

  const twice = await call(`/api/change-orders/${id}/approve`, { typedName: "Jordan Placeholder", expectedTotalCents: 420000 });
  assert.equal(twice.status, 409);
  assert.equal((await call("/api/projects/2")).data.contractTotalCents, start + 420000);

  const audit = await call("/api/audit?projectId=2");
  assert.deepEqual(audit.data.map((e: any) => e.action).slice(-3), ["change_order.requested", "change_order.priced", "change_order.approved"]);
  assert.equal((await call("/api/audit/verify")).data.ok, true);
});

test("errors: bad JSON, missing fields, unknown ids and routes", async () => {
  assert.equal((await call("/api/projects/1/change-orders", "{not json")).status, 400);
  assert.equal((await call("/api/projects/1/change-orders", { title: "only a title" })).status, 400);
  assert.equal((await call("/api/projects/99/change-orders", { title: "T", description: "D", requestedBy: "R" })).status, 404);
  assert.equal((await call("/api/change-orders/99")).status, 404);
  assert.equal((await call("/api/nope")).status, 404);
});
