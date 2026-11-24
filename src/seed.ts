import type { Tracker } from "./tracker.ts";

/** Obviously fake projects for the demo and for local runs. */
export function seed(tracker: Tracker): void {
  if (tracker.listProjects().length > 0) return;
  tracker.createProject({
    name: "Sample Kitchen Refresh",
    customerName: "Alex Sample",
    customerEmail: "alex.sample@example.com",
    baseContractCents: 1850000,
  });
  tracker.createProject({
    name: "Demo Basement Finish",
    customerName: "Jordan Placeholder",
    customerEmail: "jordan.placeholder@example.com",
    baseContractCents: 3200000,
  });
  const co = tracker.requestChangeOrder(1, {
    title: "Add under-cabinet lighting",
    description: "Customer asked for LED strip lighting under the upper cabinets on the north wall.",
    requestedBy: "Sam Fieldlead",
  });
  tracker.priceChangeOrder(co.id, {
    pricedBy: "Pat Estimator",
    lineItems: [
      { description: "LED strip kit", quantity: 3, unitPriceCents: 4500 },
      { description: "Electrician labor (hours)", quantity: 4, unitPriceCents: 9500 },
    ],
  });
}
