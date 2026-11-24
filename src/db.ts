import { DatabaseSync } from "node:sqlite";

// Schema notes:
// - Money is stored as integer cents.
// - The rules that matter are enforced by triggers, not only by application code:
//   audit events and signatures are append only, a decided change order is frozen,
//   and a project's contract total must always equal base + approved change orders.
const SCHEMA = `
CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  base_contract_cents INTEGER NOT NULL,
  contract_total_cents INTEGER NOT NULL
);

CREATE TABLE change_orders (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested','priced','approved','declined')),
  total_cents INTEGER,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  UNIQUE (project_id, number)
);

CREATE TABLE line_items (
  id INTEGER PRIMARY KEY,
  change_order_id INTEGER NOT NULL REFERENCES change_orders(id),
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL
);

CREATE TABLE signatures (
  id INTEGER PRIMARY KEY,
  change_order_id INTEGER NOT NULL UNIQUE REFERENCES change_orders(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved','declined')),
  typed_name TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  document_hash TEXT NOT NULL,
  ip TEXT NOT NULL,
  user_agent TEXT NOT NULL
);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  change_order_id INTEGER,
  payload TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit trail is append only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit trail is append only'); END;

CREATE TRIGGER signature_no_update BEFORE UPDATE ON signatures
BEGIN SELECT RAISE(ABORT, 'signature records are immutable'); END;
CREATE TRIGGER signature_no_delete BEFORE DELETE ON signatures
BEGIN SELECT RAISE(ABORT, 'signature records are immutable'); END;

CREATE TRIGGER change_order_frozen BEFORE UPDATE ON change_orders
WHEN OLD.status IN ('approved','declined')
BEGIN SELECT RAISE(ABORT, 'a decided change order is frozen'); END;
CREATE TRIGGER change_order_no_delete BEFORE DELETE ON change_orders
BEGIN SELECT RAISE(ABORT, 'change orders are never deleted'); END;

CREATE TRIGGER line_items_frozen_insert BEFORE INSERT ON line_items
WHEN (SELECT status FROM change_orders WHERE id = NEW.change_order_id) IN ('approved','declined')
BEGIN SELECT RAISE(ABORT, 'a decided change order is frozen'); END;
CREATE TRIGGER line_items_frozen_update BEFORE UPDATE ON line_items
WHEN (SELECT status FROM change_orders WHERE id = OLD.change_order_id) IN ('approved','declined')
BEGIN SELECT RAISE(ABORT, 'a decided change order is frozen'); END;
CREATE TRIGGER line_items_frozen_delete BEFORE DELETE ON line_items
WHEN (SELECT status FROM change_orders WHERE id = OLD.change_order_id) IN ('approved','declined')
BEGIN SELECT RAISE(ABORT, 'a decided change order is frozen'); END;

CREATE TRIGGER contract_total_guard BEFORE UPDATE OF contract_total_cents, base_contract_cents ON projects
WHEN NEW.base_contract_cents != OLD.base_contract_cents
  OR NEW.contract_total_cents != OLD.base_contract_cents + (
    SELECT COALESCE(SUM(total_cents), 0) FROM change_orders
    WHERE project_id = OLD.id AND status = 'approved')
BEGIN SELECT RAISE(ABORT, 'contract total changes only through approved change orders'); END;
`;

export function openDb(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get();
  if (!exists) db.exec(SCHEMA);
  return db;
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
