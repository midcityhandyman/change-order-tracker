import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./db.ts";

export type Status = "requested" | "priced" | "approved" | "declined";

export interface LineItem {
  description: string;
  quantity: number;
  unitPriceCents: number;
}

export interface Signature {
  decision: "approved" | "declined";
  typedName: string;
  signedAt: string;
  totalCents: number;
  documentHash: string;
  ip: string;
  userAgent: string;
}

export interface ChangeOrder {
  id: number;
  projectId: number;
  number: number;
  title: string;
  description: string;
  requestedBy: string;
  status: Status;
  totalCents: number | null;
  createdAt: string;
  decidedAt: string | null;
  lineItems: LineItem[];
  signature: Signature | null;
}

export interface Project {
  id: number;
  name: string;
  customerName: string;
  customerEmail: string;
  baseContractCents: number;
  contractTotalCents: number;
}

export interface AuditEvent {
  id: number;
  at: string;
  actor: string;
  action: string;
  projectId: number;
  changeOrderId: number | null;
  payload: unknown;
  prevHash: string;
  hash: string;
}

export interface SignerContext {
  ip?: string;
  userAgent?: string;
}

export class TrackerError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Row = Record<string, any>;

const GENESIS = "0".repeat(64);
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const normalizeName = (name: string): string => name.trim().replace(/\s+/g, " ").toLowerCase();

function text(value: unknown, field: string, max = 500): string {
  if (typeof value !== "string" || value.trim() === "") throw new TrackerError(400, `${field} is required`);
  if (value.length > max) throw new TrackerError(400, `${field} is too long (max ${max})`);
  return value.trim();
}

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TrackerError(400, `${field} must be a whole number`);
  }
  return value;
}

function auditHash(prev: string, e: Omit<AuditEvent, "id" | "prevHash" | "hash" | "payload">, payload: string): string {
  return sha256(JSON.stringify([prev, e.at, e.actor, e.action, e.projectId, e.changeOrderId, payload]));
}

export class Tracker {
  db: DatabaseSync;
  now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  // ---------- reads ----------

  listProjects(): Project[] {
    return this.db.prepare("SELECT * FROM projects ORDER BY id").all().map(toProject);
  }

  getProject(id: number): Project & { changeOrders: ChangeOrder[]; approvedChangeCents: number; pendingCents: number } {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    if (!row) throw new TrackerError(404, "project not found");
    const changeOrders = this.db
      .prepare("SELECT id FROM change_orders WHERE project_id = ? ORDER BY number")
      .all(id)
      .map((r) => this.getChangeOrder(r.id as number));
    const sum = (status: Status) =>
      changeOrders.filter((c) => c.status === status).reduce((n, c) => n + (c.totalCents ?? 0), 0);
    return { ...toProject(row), changeOrders, approvedChangeCents: sum("approved"), pendingCents: sum("priced") };
  }

  getChangeOrder(id: number): ChangeOrder {
    const row = this.db.prepare("SELECT * FROM change_orders WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new TrackerError(404, "change order not found");
    const lineItems = this.db
      .prepare("SELECT description, quantity, unit_price_cents FROM line_items WHERE change_order_id = ? ORDER BY id")
      .all(id)
      .map((r: Row) => ({ description: r.description, quantity: r.quantity, unitPriceCents: r.unit_price_cents }));
    const sig = this.db.prepare("SELECT * FROM signatures WHERE change_order_id = ?").get(id) as Row | undefined;
    return {
      id: row.id,
      projectId: row.project_id,
      number: row.number,
      title: row.title,
      description: row.description,
      requestedBy: row.requested_by,
      status: row.status,
      totalCents: row.total_cents,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
      lineItems,
      signature: sig
        ? {
            decision: sig.decision,
            typedName: sig.typed_name,
            signedAt: sig.signed_at,
            totalCents: sig.total_cents,
            documentHash: sig.document_hash,
            ip: sig.ip,
            userAgent: sig.user_agent,
          }
        : null,
    };
  }

  listAudit(projectId?: number): AuditEvent[] {
    const rows = projectId
      ? this.db.prepare("SELECT * FROM audit_events WHERE project_id = ? ORDER BY id").all(projectId)
      : this.db.prepare("SELECT * FROM audit_events ORDER BY id").all();
    return rows.map((r: Row) => ({
      id: r.id,
      at: r.at,
      actor: r.actor,
      action: r.action,
      projectId: r.project_id,
      changeOrderId: r.change_order_id,
      payload: JSON.parse(r.payload),
      prevHash: r.prev_hash,
      hash: r.hash,
    }));
  }

  /** Recomputes the hash chain. Detects edits made by someone who bypassed the triggers. */
  verifyAudit(): { ok: boolean; events: number; brokenAtId: number | null } {
    const rows = this.db.prepare("SELECT * FROM audit_events ORDER BY id").all() as Row[];
    let prev = GENESIS;
    for (const r of rows) {
      const expected = auditHash(
        prev,
        { at: r.at, actor: r.actor, action: r.action, projectId: r.project_id, changeOrderId: r.change_order_id },
        r.payload,
      );
      if (r.prev_hash !== prev || r.hash !== expected) return { ok: false, events: rows.length, brokenAtId: r.id };
      prev = r.hash;
    }
    return { ok: true, events: rows.length, brokenAtId: null };
  }

  // ---------- writes ----------

  createProject(input: { name: string; customerName: string; customerEmail: string; baseContractCents: number }): Project {
    const name = text(input.name, "name");
    const customerName = text(input.customerName, "customerName");
    const customerEmail = text(input.customerEmail, "customerEmail");
    const base = integer(input.baseContractCents, "baseContractCents");
    return transaction(this.db, () => {
      const res = this.db
        .prepare(
          "INSERT INTO projects (name, customer_name, customer_email, base_contract_cents, contract_total_cents) VALUES (?,?,?,?,?)",
        )
        .run(name, customerName, customerEmail, base, base);
      const id = Number(res.lastInsertRowid);
      this.audit("system", "project.created", id, null, { name, baseContractCents: base });
      return toProject(this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id)!);
    });
  }

  requestChangeOrder(projectId: number, input: { title?: unknown; description?: unknown; requestedBy?: unknown }): ChangeOrder {
    const title = text(input.title, "title", 120);
    const description = text(input.description, "description", 2000);
    const requestedBy = text(input.requestedBy, "requestedBy", 80);
    return transaction(this.db, () => {
      if (!this.db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId)) {
        throw new TrackerError(404, "project not found");
      }
      const next = this.db
        .prepare("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM change_orders WHERE project_id = ?")
        .get(projectId) as Row;
      const res = this.db
        .prepare(
          "INSERT INTO change_orders (project_id, number, title, description, requested_by, status, created_at) VALUES (?,?,?,?,?,'requested',?)",
        )
        .run(projectId, next.n, title, description, requestedBy, this.now().toISOString());
      const id = Number(res.lastInsertRowid);
      this.audit(requestedBy, "change_order.requested", projectId, id, { number: next.n, title });
      return this.getChangeOrder(id);
    });
  }

  /** Sets (or replaces) the price. Allowed until the customer decides. Never touches the contract total. */
  priceChangeOrder(id: number, input: { lineItems?: unknown; pricedBy?: unknown }): ChangeOrder {
    const pricedBy = text(input.pricedBy, "pricedBy", 80);
    if (!Array.isArray(input.lineItems) || input.lineItems.length === 0 || input.lineItems.length > 50) {
      throw new TrackerError(400, "lineItems must contain between 1 and 50 items");
    }
    const items: LineItem[] = input.lineItems.map((raw: Row, i: number) => {
      const quantity = integer(raw?.quantity, `lineItems[${i}].quantity`);
      if (quantity <= 0) throw new TrackerError(400, `lineItems[${i}].quantity must be positive`);
      return {
        description: text(raw?.description, `lineItems[${i}].description`, 200),
        quantity,
        unitPriceCents: integer(raw?.unitPriceCents, `lineItems[${i}].unitPriceCents`),
      };
    });
    const total = items.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
    if (!Number.isSafeInteger(total)) throw new TrackerError(400, "total is out of range");
    return transaction(this.db, () => {
      const co = this.getChangeOrder(id);
      if (co.status !== "requested" && co.status !== "priced") {
        throw new TrackerError(409, `change order is already ${co.status} and cannot be repriced`);
      }
      this.db.prepare("DELETE FROM line_items WHERE change_order_id = ?").run(id);
      const insert = this.db.prepare(
        "INSERT INTO line_items (change_order_id, description, quantity, unit_price_cents) VALUES (?,?,?,?)",
      );
      for (const item of items) insert.run(id, item.description, item.quantity, item.unitPriceCents);
      this.db.prepare("UPDATE change_orders SET status = 'priced', total_cents = ? WHERE id = ?").run(total, id);
      this.audit(pricedBy, co.status === "priced" ? "change_order.repriced" : "change_order.priced", co.projectId, id, {
        totalCents: total,
        previousTotalCents: co.totalCents,
        lineItems: items,
      });
      return this.getChangeOrder(id);
    });
  }

  /**
   * Customer decision. The signature is the customer's typed name (must match the name on
   * the project), a server timestamp, and a hash of exactly what was signed.
   * Approval is the only code path that changes a project's contract total.
   */
  decide(
    id: number,
    decision: "approved" | "declined",
    input: { typedName?: unknown; expectedTotalCents?: unknown; reason?: unknown },
    ctx: SignerContext = {},
  ): ChangeOrder {
    const typedName = text(input.typedName, "typedName", 120);
    const reason = input.reason === undefined || input.reason === "" ? null : text(input.reason, "reason", 500);
    return transaction(this.db, () => {
      const co = this.getChangeOrder(id);
      if (co.status !== "priced" || co.totalCents === null) {
        throw new TrackerError(409, `only a priced change order can be ${decision}; this one is ${co.status}`);
      }
      const project = toProject(this.db.prepare("SELECT * FROM projects WHERE id = ?").get(co.projectId)!);
      if (normalizeName(typedName) !== normalizeName(project.customerName)) {
        throw new TrackerError(422, "typed name does not match the customer name on the project");
      }
      if (decision === "approved" && input.expectedTotalCents !== co.totalCents) {
        throw new TrackerError(409, "the price changed since it was shown; reload and review before approving");
      }
      const at = this.now().toISOString();
      const documentHash = hashDocument(co);
      this.db.prepare("UPDATE change_orders SET status = ?, decided_at = ? WHERE id = ?").run(decision, at, id);
      this.db
        .prepare(
          "INSERT INTO signatures (change_order_id, decision, typed_name, signed_at, total_cents, document_hash, ip, user_agent) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(id, decision, typedName, at, co.totalCents, documentHash, ctx.ip ?? "unknown", ctx.userAgent ?? "unknown");
      const payload: Row = { typedName, totalCents: co.totalCents, documentHash };
      if (reason) payload.reason = reason;
      if (decision === "approved") {
        const newTotal = project.contractTotalCents + co.totalCents;
        this.db.prepare("UPDATE projects SET contract_total_cents = ? WHERE id = ?").run(newTotal, project.id);
        payload.contractTotalBeforeCents = project.contractTotalCents;
        payload.contractTotalAfterCents = newTotal;
      }
      this.audit(`customer:${typedName}`, `change_order.${decision}`, project.id, id, payload, at);
      return this.getChangeOrder(id);
    });
  }

  private audit(actor: string, action: string, projectId: number, changeOrderId: number | null, payload: unknown, at = this.now().toISOString()): void {
    const last = this.db.prepare("SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1").get() as Row | undefined;
    const prev = last ? (last.hash as string) : GENESIS;
    const body = JSON.stringify(payload);
    const hash = auditHash(prev, { at, actor, action, projectId, changeOrderId }, body);
    this.db
      .prepare(
        "INSERT INTO audit_events (at, actor, action, project_id, change_order_id, payload, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(at, actor, action, projectId, changeOrderId, body, prev, hash);
  }
}

/** Hash of the exact terms the customer saw. Lets anyone check later that nothing was altered. */
export function hashDocument(co: ChangeOrder): string {
  return sha256(
    JSON.stringify({
      projectId: co.projectId,
      number: co.number,
      title: co.title,
      description: co.description,
      lineItems: co.lineItems.map((i) => [i.description, i.quantity, i.unitPriceCents]),
      totalCents: co.totalCents,
    }),
  );
}

function toProject(r: Row): Project {
  return {
    id: r.id,
    name: r.name,
    customerName: r.customer_name,
    customerEmail: r.customer_email,
    baseContractCents: r.base_contract_cents,
    contractTotalCents: r.contract_total_cents,
  };
}
