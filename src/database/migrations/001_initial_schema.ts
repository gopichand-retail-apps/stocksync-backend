export const initialSchema = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  region TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('associate', 'inventory_manager', 'auditor')),
  password_hash TEXT NOT NULL,
  home_location_id TEXT NOT NULL REFERENCES locations(id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS skus (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  barcode TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  unit TEXT NOT NULL,
  low_stock_threshold INTEGER NOT NULL CHECK (low_stock_threshold >= 0),
  accent TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory (
  location_id TEXT NOT NULL REFERENCES locations(id),
  sku_id TEXT NOT NULL REFERENCES skus(id),
  on_hand INTEGER NOT NULL CHECK (on_hand >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= on_hand),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, sku_id)
);

CREATE TABLE IF NOT EXISTS stock_ledger (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  sku_id TEXT NOT NULL REFERENCES skus(id),
  movement_type TEXT NOT NULL CHECK (movement_type IN (
    'opening_stock', 'receipt', 'transfer_out', 'transfer_in',
    'count_adjustment', 'manual_adjustment'
  )),
  quantity_delta INTEGER NOT NULL CHECK (quantity_delta <> 0),
  reference_id TEXT,
  note TEXT,
  actor_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  sku_id TEXT NOT NULL REFERENCES skus(id),
  from_location_id TEXT NOT NULL REFERENCES locations(id),
  to_location_id TEXT NOT NULL REFERENCES locations(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL CHECK (status IN ('in_transit', 'received', 'cancelled')),
  note TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  received_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_at TIMESTAMPTZ,
  CHECK (from_location_id <> to_location_id)
);

CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  sku_id TEXT NOT NULL REFERENCES skus(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'released')),
  note TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS cycle_counts (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  sku_id TEXT NOT NULL REFERENCES skus(id),
  expected_quantity INTEGER NOT NULL CHECK (expected_quantity >= 0),
  counted_quantity INTEGER NOT NULL CHECK (counted_quantity >= 0),
  variance INTEGER NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS stock_ledger_location_created_idx
  ON stock_ledger (location_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_ledger_sku_created_idx
  ON stock_ledger (sku_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transfers_status_created_idx
  ON transfers (status, created_at DESC);
CREATE INDEX IF NOT EXISTS inventory_sku_location_idx
  ON inventory (sku_id, location_id);
`;
