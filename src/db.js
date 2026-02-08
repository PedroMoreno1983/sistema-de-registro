const sqlite3 = require("sqlite3");
const { open } = require("sqlite");
const path = require("path");

const dbPath = path.join(__dirname, "..", "data.sqlite");
let dbInstance;

async function openDb() {
  if (!dbInstance) {
    dbInstance = await open({
      filename: dbPath,
      driver: sqlite3.Database,
    });
  }
  return dbInstance;
}

async function ensureColumn(db, table, column, definition) {
  const columns = await db.all(`PRAGMA table_info(${table})`);
  const exists = columns.some((col) => col.name === column);
  if (!exists) {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function ensureTable(db, name, schemaSql) {
  await db.exec(schemaSql);
  return name;
}

async function initDb() {
  const db = await openDb();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      unit TEXT,
      contact TEXT,
      password TEXT,
      password_hash TEXT,
      password_salt TEXT,
      failed_attempts INTEGER DEFAULT 0,
      locked_until TEXT
    );
  `);
  await ensureColumn(db, "users", "password", "TEXT");
  await ensureColumn(db, "users", "password_hash", "TEXT");
  await ensureColumn(db, "users", "password_salt", "TEXT");
  await ensureColumn(db, "users", "failed_attempts", "INTEGER DEFAULT 0");
  await ensureColumn(db, "users", "locked_until", "TEXT");

  await ensureTable(
    db,
    "shifts",
    `
      CREATE TABLE IF NOT EXISTS shifts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guard_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        start TEXT NOT NULL,
        end TEXT NOT NULL,
        notes TEXT,
        status TEXT DEFAULT 'programado',
        check_in TEXT,
        check_out TEXT,
        FOREIGN KEY (guard_id) REFERENCES users (id)
      );
    `
  );
  await ensureColumn(db, "shifts", "status", "TEXT DEFAULT 'programado'");
  await ensureColumn(db, "shifts", "check_in", "TEXT");
  await ensureColumn(db, "shifts", "check_out", "TEXT");

  await db.exec(`
    CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      price TEXT,
      type TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'pending',
      category TEXT,
      stock INTEGER DEFAULT 0,
      image_url TEXT,
      FOREIGN KEY (owner_id) REFERENCES users (id)
    );
  `);
  await ensureColumn(db, "listings", "status", "TEXT DEFAULT 'pending'");
  await ensureColumn(db, "listings", "category", "TEXT");
  await ensureColumn(db, "listings", "stock", "INTEGER DEFAULT 0");
  await ensureColumn(db, "listings", "image_url", "TEXT");

  await db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL,
      buyer_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      payment_link TEXT,
      created_at TEXT,
      paid_at TEXT,
      delivered_at TEXT,
      cancelled_at TEXT,
      refund_at TEXT,
      FOREIGN KEY (listing_id) REFERENCES listings (id),
      FOREIGN KEY (buyer_id) REFERENCES users (id)
    );
  `);
  await ensureColumn(db, "orders", "paid_at", "TEXT");
  await ensureColumn(db, "orders", "delivered_at", "TEXT");
  await ensureColumn(db, "orders", "cancelled_at", "TEXT");
  await ensureColumn(db, "orders", "refund_at", "TEXT");

  await db.exec(`
    CREATE TABLE IF NOT EXISTS cart_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      listing_id INTEGER NOT NULL,
      created_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users (id),
      FOREIGN KEY (listing_id) REFERENCES listings (id)
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT,
      expires_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users (id)
    );
  `);
  await ensureColumn(db, "sessions", "expires_at", "TEXT");

  await db.exec(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT,
      expires_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users (id)
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS password_resets (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT,
      expires_at TEXT,
      used_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users (id)
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS listing_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      note TEXT,
      created_at TEXT,
      FOREIGN KEY (listing_id) REFERENCES listings (id)
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS listing_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL,
      reporter_id INTEGER NOT NULL,
      reason TEXT,
      created_at TEXT,
      FOREIGN KEY (listing_id) REFERENCES listings (id),
      FOREIGN KEY (reporter_id) REFERENCES users (id)
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS listing_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL,
      reviewer_id INTEGER NOT NULL,
      rating INTEGER NOT NULL,
      comment TEXT,
      created_at TEXT,
      FOREIGN KEY (listing_id) REFERENCES listings (id),
      FOREIGN KEY (reviewer_id) REFERENCES users (id)
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS shift_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guard_id INTEGER NOT NULL,
      weekday INTEGER NOT NULL,
      start TEXT NOT NULL,
      end TEXT NOT NULL,
      notes TEXT,
      FOREIGN KEY (guard_id) REFERENCES users (id)
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      related_id INTEGER,
      created_at TEXT
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS shipments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      provider TEXT,
      tracking_id TEXT,
      tracking_url TEXT,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (order_id) REFERENCES orders (id)
    );
  `);
  await ensureColumn(db, "shipments", "tracking_url", "TEXT");

  await db.exec(`
    CREATE TABLE IF NOT EXISTS shipment_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id INTEGER NOT NULL,
      provider_status TEXT NOT NULL,
      mapped_order_status TEXT,
      payload TEXT,
      created_at TEXT,
      FOREIGN KEY (shipment_id) REFERENCES shipments (id)
    );
  `);
}

module.exports = { openDb, initDb };
