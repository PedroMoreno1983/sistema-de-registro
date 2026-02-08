const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { openDb, initDb } = require("./src/db");

const app = express();
const PORT = process.env.PORT || 3000;
const HAULMER_BASE_URL =
  process.env.HAULMER_BASE_URL || "https://pagos.haulmer.com/link";
const PASSWORD_ITERATIONS = 100000;
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const REFRESH_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const RESET_TTL_MS = 1000 * 60 * 30;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const RATE_LIMIT_WINDOW_MS = 1000 * 60;
const RATE_LIMIT_MAX = 100;
const HAULMER_WEBHOOK_SECRET = process.env.HAULMER_WEBHOOK_SECRET || "";
const LOGISTICS_WEBHOOK_SECRET = process.env.LOGISTICS_WEBHOOK_SECRET || "";

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto
    .pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 64, "sha512")
    .toString("hex");
  return { hash, salt };
}

function verifyPassword(password, user) {
  if (user.password_hash && user.password_salt) {
    const { hash } = hashPassword(password, user.password_salt);
    return hash === user.password_hash;
  }
  return user.password === password;
}

function validatePassword(password) {
  const minLength = password.length >= 8;
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasNumber = /\d/.test(password);
  return minLength && hasUpper && hasLower && hasNumber;
}

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString("utf8");
  },
}));
app.use(express.static(path.join(__dirname)));

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

async function getSession(req) {
  const token = req.header("x-session-token");
  if (!token) return null;
  const db = await openDb();
  const session = await db.get(
    "SELECT sessions.token, sessions.user_id, users.name, users.role FROM sessions JOIN users ON sessions.user_id = users.id WHERE sessions.token = ?",
    [token]
  );
  if (!session) return null;
  const expires = await db.get("SELECT expires_at FROM sessions WHERE token = ?", [
    token,
  ]);
  if (expires?.expires_at && new Date(expires.expires_at) < new Date()) {
    await db.run("DELETE FROM sessions WHERE token = ?", [token]);
    return null;
  }
  return session;
}

function requireAuth(handler) {
  return async (req, res) => {
    const session = await getSession(req);
    if (!session) {
      return res.status(401).json({ error: "Inicia sesión" });
    }
    req.session = session;
    return handler(req, res);
  };
}

function requireRole(roles, handler) {
  return requireAuth((req, res) => {
    if (!roles.includes(req.session.role)) {
      return res.status(403).json({ error: "Sin permisos" });
    }
    return handler(req, res);
  });
}

const rateLimitMap = new Map();

function rateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip;
  const entry = rateLimitMap.get(key) || { count: 0, start: now };
  if (now - entry.start > RATE_LIMIT_WINDOW_MS) {
    entry.count = 0;
    entry.start = now;
  }
  entry.count += 1;
  rateLimitMap.set(key, entry);
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "Demasiadas solicitudes" });
  }
  return next();
}

async function logListingHistory(db, listingId, action, note = "") {
  await db.run(
    "INSERT INTO listing_history (listing_id, action, note, created_at) VALUES (?, ?, ?, ?)",
    [listingId, action, note, new Date().toISOString()]
  );
}

function mapShipmentStatus(providerStatus = "") {
  const normalized = providerStatus.toLowerCase();
  if (["created", "preparing", "picked_up"].includes(normalized)) {
    return { shipmentStatus: "preparando", orderStatus: "pagado" };
  }
  if (["in_transit", "on_route"].includes(normalized)) {
    return { shipmentStatus: "en_transito", orderStatus: "enviado" };
  }
  if (["delivered"].includes(normalized)) {
    return { shipmentStatus: "entregado", orderStatus: "entregado" };
  }
  if (["failed", "returned", "lost"].includes(normalized)) {
    return { shipmentStatus: "incidente", orderStatus: "rechazado" };
  }
  return { shipmentStatus: "desconocido", orderStatus: null };
}

app.post("/api/auth/login", rateLimit, async (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) {
    return res.status(400).json({ error: "Completa usuario y contraseña" });
  }
  const db = await openDb();
  const user = await db.get(
    "SELECT id, name, role, password, password_hash, password_salt, failed_attempts, locked_until FROM users WHERE name = ?",
    [name]
  );
  if (user?.locked_until && new Date(user.locked_until) > new Date()) {
    return res.status(429).json({ error: "Cuenta bloqueada temporalmente" });
  }
  if (!user || !verifyPassword(password, user)) {
    if (user) {
      const attempts = (user.failed_attempts || 0) + 1;
      const updates = { attempts };
      if (attempts >= MAX_FAILED_ATTEMPTS) {
        const lockUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60000).toISOString();
        await db.run(
          "UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?",
          [attempts, lockUntil, user.id]
        );
      } else {
        await db.run("UPDATE users SET failed_attempts = ? WHERE id = ?", [
          attempts,
          user.id,
        ]);
      }
    }
    return res.status(401).json({ error: "Credenciales inválidas" });
  }
  if (!user.password_hash) {
    const { hash, salt } = hashPassword(password);
    await db.run(
      "UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?",
      [hash, salt, user.id]
    );
  }
  await db.run("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?", [
    user.id,
  ]);
  const token = crypto.randomUUID();
  const refreshToken = crypto.randomUUID();
  await db.run(
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    [
      token,
      user.id,
      new Date().toISOString(),
      new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    ]
  );
  await db.run(
    "INSERT INTO refresh_tokens (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    [
      refreshToken,
      user.id,
      new Date().toISOString(),
      new Date(Date.now() + REFRESH_TTL_MS).toISOString(),
    ]
  );
  res.json({
    token,
    refreshToken,
    user: { id: user.id, name: user.name, role: user.role },
  });
});

app.post("/api/auth/logout", requireAuth(async (req, res) => {
  const db = await openDb();
  await db.run("DELETE FROM sessions WHERE token = ?", [req.session.token]);
  await db.run("DELETE FROM refresh_tokens WHERE user_id = ?", [req.session.user_id]);
  res.json({ status: "ok" });
}));

app.post("/api/auth/revoke", requireRole(["administrador"], async (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: "Usuario requerido" });
  }
  const db = await openDb();
  await db.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
  await db.run("DELETE FROM refresh_tokens WHERE user_id = ?", [userId]);
  res.json({ status: "ok" });
}));

app.post("/api/auth/refresh", rateLimit, async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(400).json({ error: "Refresh token requerido" });
  }
  const db = await openDb();
  const tokenRow = await db.get(
    "SELECT token, user_id, expires_at FROM refresh_tokens WHERE token = ?",
    [refreshToken]
  );
  if (!tokenRow || new Date(tokenRow.expires_at) < new Date()) {
    return res.status(401).json({ error: "Refresh token inválido" });
  }
  const newToken = crypto.randomUUID();
  await db.run("DELETE FROM sessions WHERE user_id = ?", [tokenRow.user_id]);
  await db.run(
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    [
      newToken,
      tokenRow.user_id,
      new Date().toISOString(),
      new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    ]
  );
  res.json({ token: newToken });
});

app.post("/api/auth/request-reset", rateLimit, async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: "Usuario requerido" });
  }
  const db = await openDb();
  const user = await db.get("SELECT id FROM users WHERE name = ?", [name]);
  if (!user) {
    return res.status(404).json({ error: "Usuario no encontrado" });
  }
  const resetToken = crypto.randomUUID();
  await db.run(
    "INSERT INTO password_resets (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    [
      resetToken,
      user.id,
      new Date().toISOString(),
      new Date(Date.now() + RESET_TTL_MS).toISOString(),
    ]
  );
  res.json({ resetToken });
});

app.post("/api/auth/reset", rateLimit, async (req, res) => {
  const { resetToken, password } = req.body;
  if (!resetToken || !password) {
    return res.status(400).json({ error: "Token y contraseña requeridos" });
  }
  if (!validatePassword(password)) {
    return res.status(400).json({
      error: "Contraseña debe tener 8+ caracteres, mayúscula, minúscula y número",
    });
  }
  const db = await openDb();
  const reset = await db.get(
    "SELECT token, user_id, expires_at, used_at FROM password_resets WHERE token = ?",
    [resetToken]
  );
  if (!reset || reset.used_at || new Date(reset.expires_at) < new Date()) {
    return res.status(400).json({ error: "Token inválido" });
  }
  const { hash, salt } = hashPassword(password);
  await db.run(
    "UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?",
    [hash, salt, reset.user_id]
  );
  await db.run(
    "UPDATE password_resets SET used_at = ? WHERE token = ?",
    [new Date().toISOString(), resetToken]
  );
  res.json({ status: "ok" });
});

app.get("/api/auth/me", requireAuth(async (req, res) => {
  res.json({ id: req.session.user_id, name: req.session.name, role: req.session.role });
}));

app.get("/api/users", requireAuth(async (req, res) => {
  const db = await openDb();
  const { role } = req.query;
  const params = [];
  let query = "SELECT id, name, role, unit, contact FROM users";
  if (role) {
    query += " WHERE role = ?";
    params.push(role);
  }
  const rows = await db.all(query, params);
  res.json(rows);
}));

app.post("/api/users", async (req, res) => {
  const { name, role, unit, contact, password } = req.body;
  if (!name || !role || !password) {
    return res
      .status(400)
      .json({ error: "Nombre, rol y contraseña son obligatorios" });
  }
  if (!validatePassword(password)) {
    return res.status(400).json({
      error: "Contraseña debe tener 8+ caracteres, mayúscula, minúscula y número",
    });
  }
  const db = await openDb();
  const count = await db.get("SELECT COUNT(*) as total FROM users");
  if (count.total > 0) {
    const session = await getSession(req);
    if (!session || session.role !== "administrador") {
      return res.status(403).json({ error: "Solo administrador" });
    }
  }
  const { hash, salt } = hashPassword(password);
  const result = await db.run(
    "INSERT INTO users (name, role, unit, contact, password_hash, password_salt) VALUES (?, ?, ?, ?, ?, ?)",
    [name, role, unit || "", contact || "", hash, salt]
  );
  res.status(201).json({ id: result.lastID });
});

app.get("/api/shifts", requireAuth(async (req, res) => {
  const db = await openDb();
  const now = new Date();
  const scheduled = await db.all(
    "SELECT id, date, start, status FROM shifts WHERE status = 'programado'"
  );
  for (const shift of scheduled) {
    const shiftTime = new Date(`${shift.date}T${shift.start}:00`);
    if (shiftTime < now) {
      await db.run("UPDATE shifts SET status = 'ausente' WHERE id = ?", [
        shift.id,
      ]);
      await db.run(
        "INSERT INTO alerts (type, message, related_id, created_at) VALUES (?, ?, ?, ?)",
        [
          "ausencia",
          `Conserje ausente en turno ${shift.date} ${shift.start}`,
          shift.id,
          new Date().toISOString(),
        ]
      );
    }
  }
  const rows = await db.all(
    "SELECT shifts.id, users.name as guard, shifts.date, shifts.start, shifts.end, shifts.notes, shifts.status, shifts.check_in, shifts.check_out FROM shifts LEFT JOIN users ON shifts.guard_id = users.id ORDER BY shifts.date DESC"
  );
  res.json(rows);
}));

app.post(
  "/api/shifts",
  requireRole(["administrador"], async (req, res) => {
    const { guardId, date, start, end, notes } = req.body;
    if (!guardId || !date || !start || !end) {
      return res
        .status(400)
        .json({ error: "Completa conserje, fecha y horario" });
    }
    const db = await openDb();
    const overlaps = await db.get(
      `SELECT id FROM shifts
       WHERE guard_id = ?
       AND date = ?
       AND NOT (end <= ? OR start >= ?)`,
      [guardId, date, start, end]
    );
    if (overlaps) {
      return res.status(409).json({ error: "Turno se superpone" });
    }
    const result = await db.run(
      "INSERT INTO shifts (guard_id, date, start, end, notes, status) VALUES (?, ?, ?, ?, ?, ?)",
      [guardId, date, start, end, notes || "", "programado"]
    );
    res.status(201).json({ id: result.lastID });
  })
);

app.post(
  "/api/shifts/templates",
  requireRole(["administrador"], async (req, res) => {
    const { guardId, weekday, start, end, notes } = req.body;
    if (guardId === undefined || weekday === undefined || !start || !end) {
      return res.status(400).json({ error: "Plantilla incompleta" });
    }
    const db = await openDb();
    const result = await db.run(
      "INSERT INTO shift_templates (guard_id, weekday, start, end, notes) VALUES (?, ?, ?, ?, ?)",
      [guardId, weekday, start, end, notes || ""]
    );
    res.status(201).json({ id: result.lastID });
  })
);

app.post(
  "/api/shifts/generate",
  requireRole(["administrador"], async (req, res) => {
    const { weekStart } = req.body;
    if (!weekStart) {
      return res.status(400).json({ error: "Fecha de inicio requerida" });
    }
    const db = await openDb();
    const templates = await db.all("SELECT * FROM shift_templates");
    const created = [];
    const startDate = new Date(weekStart);
    for (const template of templates) {
      const shiftDate = new Date(startDate);
      shiftDate.setDate(startDate.getDate() + Number(template.weekday));
      const dateString = shiftDate.toISOString().slice(0, 10);
      const overlaps = await db.get(
        `SELECT id FROM shifts
         WHERE guard_id = ?
         AND date = ?
         AND NOT (end <= ? OR start >= ?)`,
        [template.guard_id, dateString, template.start, template.end]
      );
      if (overlaps) continue;
      const result = await db.run(
        "INSERT INTO shifts (guard_id, date, start, end, notes, status) VALUES (?, ?, ?, ?, ?, ?)",
        [
          template.guard_id,
          dateString,
          template.start,
          template.end,
          template.notes || "",
          "programado",
        ]
      );
      created.push(result.lastID);
    }
    res.json({ created });
  })
);

app.post(
  "/api/shifts/:id/check-in",
  requireRole(["administrador", "conserje"], async (req, res) => {
    const db = await openDb();
    await db.run(
      "UPDATE shifts SET status = 'en_progreso', check_in = ? WHERE id = ?",
      [new Date().toISOString(), req.params.id]
    );
    res.json({ status: "ok" });
  })
);

app.post(
  "/api/shifts/:id/check-out",
  requireRole(["administrador", "conserje"], async (req, res) => {
    const db = await openDb();
    await db.run(
      "UPDATE shifts SET status = 'finalizado', check_out = ? WHERE id = ?",
      [new Date().toISOString(), req.params.id]
    );
    res.json({ status: "ok" });
  })
);

app.get("/api/alerts", requireRole(["administrador"], async (req, res) => {
  const db = await openDb();
  const rows = await db.all("SELECT * FROM alerts ORDER BY created_at DESC");
  res.json(rows);
}));

app.get("/api/reports/shifts", requireRole(["administrador"], async (req, res) => {
  const db = await openDb();
  const totals = await db.all(
    "SELECT status, COUNT(*) as total FROM shifts GROUP BY status"
  );
  res.json({ totals });
}));

app.get("/api/listings", requireAuth(async (req, res) => {
  const db = await openDb();
  const isAdmin = req.session.role === "administrador";
  const rows = await db.all(
    `SELECT listings.id, listings.title, listings.price, listings.type, listings.description, listings.status, listings.owner_id, listings.category, listings.stock, listings.image_url, users.name as owner
     FROM listings
     LEFT JOIN users ON listings.owner_id = users.id
     ${isAdmin ? "" : "WHERE listings.status = 'approved' AND listings.stock > 0"}
     ORDER BY listings.id DESC`
  );
  res.json(rows);
}));

app.post(
  "/api/listings",
  requireRole(
    [
      "administrador",
      "arrendatario",
      "dueno_residente",
      "dueno_no_residente",
    ],
    async (req, res) => {
      const { ownerId, title, price, type, description, category, stock, imageUrl } = req.body;
      if (!ownerId || !title || !type) {
        return res.status(400).json({ error: "Completa dueño, título y tipo" });
      }
      const db = await openDb();
      const status = req.session.role === "administrador" ? "approved" : "pending";
      const safeStock = Number.isFinite(Number(stock)) ? Number(stock) : 0;
      const result = await db.run(
        "INSERT INTO listings (owner_id, title, price, type, description, status, category, stock, image_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          ownerId,
          title,
          price || "",
          type,
          description || "",
          status,
          category || "",
          safeStock,
          imageUrl || "",
        ]
      );
      await logListingHistory(db, result.lastID, "creado", `Estado: ${status}`);
      res.status(201).json({ id: result.lastID, status });
    }
  )
);

app.put(
  "/api/listings/:id",
  requireRole(
    [
      "administrador",
      "arrendatario",
      "dueno_residente",
      "dueno_no_residente",
    ],
    async (req, res) => {
      const { id } = req.params;
      const { title, price, type, description, category, stock, imageUrl } = req.body;
      const db = await openDb();
      const listing = await db.get("SELECT owner_id FROM listings WHERE id = ?", [id]);
      if (!listing) {
        return res.status(404).json({ error: "Publicación no encontrada" });
      }
      if (req.session.role !== "administrador" && listing.owner_id !== req.session.user_id) {
        return res.status(403).json({ error: "Sin permisos" });
      }
      const safeStock = Number.isFinite(Number(stock)) ? Number(stock) : 0;
      await db.run(
        "UPDATE listings SET title = ?, price = ?, type = ?, description = ?, category = ?, stock = ?, image_url = ? WHERE id = ?",
        [
          title,
          price || "",
          type,
          description || "",
          category || "",
          safeStock,
          imageUrl || "",
          id,
        ]
      );
      await logListingHistory(db, id, "actualizado", "Edición manual");
      res.json({ status: "ok" });
    }
  )
);

app.delete(
  "/api/listings/:id",
  requireRole(
    [
      "administrador",
      "arrendatario",
      "dueno_residente",
      "dueno_no_residente",
    ],
    async (req, res) => {
      const { id } = req.params;
      const db = await openDb();
      const listing = await db.get("SELECT owner_id FROM listings WHERE id = ?", [id]);
      if (!listing) {
        return res.status(404).json({ error: "Publicación no encontrada" });
      }
      if (req.session.role !== "administrador" && listing.owner_id !== req.session.user_id) {
        return res.status(403).json({ error: "Sin permisos" });
      }
      await db.run("DELETE FROM listings WHERE id = ?", [id]);
      await logListingHistory(db, id, "eliminado", "Eliminación manual");
      res.json({ status: "ok" });
    }
  )
);

app.post(
  "/api/listings/:id/approve",
  requireRole(["administrador"], async (req, res) => {
    const { id } = req.params;
    const db = await openDb();
    await db.run("UPDATE listings SET status = 'approved' WHERE id = ?", [id]);
    await logListingHistory(db, id, "aprobado", "Aprobación admin");
    res.json({ status: "ok" });
  })
);

app.get("/api/listings/:id/history", requireRole(["administrador"], async (req, res) => {
  const db = await openDb();
  const rows = await db.all(
    "SELECT * FROM listing_history WHERE listing_id = ? ORDER BY created_at DESC",
    [req.params.id]
  );
  res.json(rows);
}));

app.post(
  "/api/listings/:id/report",
  requireAuth(async (req, res) => {
    const { reason } = req.body;
    const db = await openDb();
    await db.run(
      "INSERT INTO listing_reports (listing_id, reporter_id, reason, created_at) VALUES (?, ?, ?, ?)",
      [req.params.id, req.session.user_id, reason || "", new Date().toISOString()]
    );
    res.status(201).json({ status: "ok" });
  })
);

app.get("/api/listings/:id/reviews", requireAuth(async (req, res) => {
  const db = await openDb();
  const rows = await db.all(
    "SELECT listing_reviews.id, listing_reviews.rating, listing_reviews.comment, listing_reviews.created_at, users.name as reviewer FROM listing_reviews JOIN users ON listing_reviews.reviewer_id = users.id WHERE listing_reviews.listing_id = ? ORDER BY listing_reviews.created_at DESC",
    [req.params.id]
  );
  res.json(rows);
}));

app.post(
  "/api/listings/:id/reviews",
  requireAuth(async (req, res) => {
    const { rating, comment } = req.body;
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: "Rating debe ser 1-5" });
    }
    const db = await openDb();
    await db.run(
      "INSERT INTO listing_reviews (listing_id, reviewer_id, rating, comment, created_at) VALUES (?, ?, ?, ?, ?)",
      [req.params.id, req.session.user_id, rating, comment || "", new Date().toISOString()]
    );
    res.status(201).json({ status: "ok" });
  })
);

app.get("/api/cart", requireAuth(async (req, res) => {
  const db = await openDb();
  const rows = await db.all(
    `SELECT cart_items.id, listings.title, listings.price, listings.type
     FROM cart_items
     JOIN listings ON cart_items.listing_id = listings.id
     WHERE cart_items.user_id = ?
     ORDER BY cart_items.id DESC`,
    [req.session.user_id]
  );
  res.json(rows);
}));

app.post(
  "/api/cart",
  requireRole(
    [
      "administrador",
      "arrendatario",
      "dueno_residente",
      "dueno_no_residente",
    ],
    async (req, res) => {
      const { listingId } = req.body;
      if (!listingId) {
        return res.status(400).json({ error: "Selecciona una publicación" });
      }
      const db = await openDb();
      const listing = await db.get(
        "SELECT id, status, stock FROM listings WHERE id = ?",
        [listingId]
      );
      if (!listing || listing.status !== "approved" || listing.stock <= 0) {
        return res.status(404).json({ error: "Publicación no disponible" });
      }
      await db.run(
        "INSERT INTO cart_items (user_id, listing_id, created_at) VALUES (?, ?, ?)",
        [req.session.user_id, listingId, new Date().toISOString()]
      );
      res.status(201).json({ status: "ok" });
    }
  )
);

app.delete("/api/cart/:id", requireAuth(async (req, res) => {
  const db = await openDb();
  await db.run("DELETE FROM cart_items WHERE id = ? AND user_id = ?", [
    req.params.id,
    req.session.user_id,
  ]);
  res.json({ status: "ok" });
}));

app.get("/api/orders", requireAuth(async (req, res) => {
  const db = await openDb();
  const rows = await db.all(
    "SELECT orders.id, orders.listing_id, orders.buyer_id, orders.status, orders.payment_link, orders.paid_at, orders.delivered_at, orders.cancelled_at, orders.refund_at, listings.title as listing_title, users.name as buyer FROM orders JOIN listings ON orders.listing_id = listings.id JOIN users ON orders.buyer_id = users.id ORDER BY orders.id DESC"
  );
  res.json(rows);
}));

app.post(
  "/api/orders",
  requireRole(
    [
      "administrador",
      "arrendatario",
      "dueno_residente",
      "dueno_no_residente",
    ],
    async (req, res) => {
      const { listingId } = req.body;
      if (!listingId) {
        return res.status(400).json({ error: "Selecciona una publicación" });
      }
      const db = await openDb();
      const listing = await db.get(
        "SELECT id, title, price, status, stock FROM listings WHERE id = ?",
        [listingId]
      );
      if (!listing || listing.status !== "approved" || listing.stock <= 0) {
        return res.status(404).json({ error: "Publicación no encontrada" });
      }
      await db.run("UPDATE listings SET stock = stock - 1 WHERE id = ?", [
        listing.id,
      ]);
      const link = `${HAULMER_BASE_URL}?reference=${listing.id}&amount=${encodeURIComponent(
        listing.price || "0"
      )}`;
      const result = await db.run(
        "INSERT INTO orders (listing_id, buyer_id, status, payment_link, created_at) VALUES (?, ?, ?, ?, ?)",
        [listing.id, req.session.user_id, "pendiente", link, new Date().toISOString()]
      );
      res.status(201).json({ id: result.lastID, paymentLink: link });
    }
  )
);

app.post(
  "/api/checkout",
  requireRole(
    [
      "administrador",
      "arrendatario",
      "dueno_residente",
      "dueno_no_residente",
    ],
    async (req, res) => {
      const db = await openDb();
      const cartItems = await db.all(
        `SELECT cart_items.id, listings.id as listing_id, listings.price
         FROM cart_items
         JOIN listings ON cart_items.listing_id = listings.id
         WHERE cart_items.user_id = ?`,
        [req.session.user_id]
      );
      if (!cartItems.length) {
        return res.status(400).json({ error: "Carrito vacío" });
      }
      const orders = [];
      for (const item of cartItems) {
        const listing = await db.get(
          "SELECT stock, status FROM listings WHERE id = ?",
          [item.listing_id]
        );
        if (!listing || listing.status !== "approved" || listing.stock <= 0) {
          continue;
        }
        await db.run("UPDATE listings SET stock = stock - 1 WHERE id = ?", [
          item.listing_id,
        ]);
        const link = `${HAULMER_BASE_URL}?reference=${item.listing_id}&amount=${encodeURIComponent(
          item.price || "0"
        )}`;
        const result = await db.run(
          "INSERT INTO orders (listing_id, buyer_id, status, payment_link, created_at) VALUES (?, ?, ?, ?, ?)",
          [item.listing_id, req.session.user_id, "pendiente", link, new Date().toISOString()]
        );
        orders.push({ id: result.lastID, paymentLink: link });
      }
      if (!orders.length) {
        return res.status(409).json({ error: "Sin stock disponible" });
      }
      await db.run("DELETE FROM cart_items WHERE user_id = ?", [req.session.user_id]);
      res.status(201).json({ orders });
    }
  )
);

app.post(
  "/api/orders/:id/status",
  requireRole(["administrador"], async (req, res) => {
    const { status } = req.body;
    const allowed = [
      "pendiente",
      "pagado",
      "entregado",
      "cancelado",
      "reembolsado",
      "rechazado",
      "enviado",
    ];
    if (!status || !allowed.includes(status)) {
      return res.status(400).json({ error: "Estado requerido" });
    }
    const db = await openDb();
    const order = await db.get("SELECT listing_id FROM orders WHERE id = ?", [
      req.params.id,
    ]);
    const updates = { status };
    if (status === "pagado") {
      updates.paid_at = new Date().toISOString();
    }
    if (status === "entregado") {
      updates.delivered_at = new Date().toISOString();
    }
    if (status === "cancelado" || status === "rechazado") {
      updates.cancelled_at = new Date().toISOString();
    }
    if (status === "reembolsado") {
      updates.refund_at = new Date().toISOString();
    }
    await db.run(
      "UPDATE orders SET status = ?, paid_at = COALESCE(?, paid_at), delivered_at = COALESCE(?, delivered_at), cancelled_at = COALESCE(?, cancelled_at), refund_at = COALESCE(?, refund_at) WHERE id = ?",
      [
        updates.status,
        updates.paid_at || null,
        updates.delivered_at || null,
        updates.cancelled_at || null,
        updates.refund_at || null,
        req.params.id,
      ]
    );
    if (order && ["cancelado", "rechazado", "reembolsado"].includes(status)) {
      await db.run("UPDATE listings SET stock = stock + 1 WHERE id = ?", [
        order.listing_id,
      ]);
    }
    res.json({ status: "ok" });
  })
);

app.post(
  "/api/orders/:id/confirm-payment",
  requireRole(["administrador"], async (req, res) => {
    const db = await openDb();
    await db.run(
      "UPDATE orders SET status = 'pagado', paid_at = ? WHERE id = ?",
      [new Date().toISOString(), req.params.id]
    );
    res.json({ status: "ok" });
  })
);

app.post(
  "/api/orders/:id/confirm-delivery",
  requireRole(["administrador"], async (req, res) => {
    const db = await openDb();
    await db.run(
      "UPDATE orders SET status = 'entregado', delivered_at = ? WHERE id = ?",
      [new Date().toISOString(), req.params.id]
    );
    res.json({ status: "ok" });
  })
);

app.post(
  "/api/orders/:id/confirm-shipment",
  requireRole(["administrador"], async (req, res) => {
    const { provider, trackingId, trackingUrl } = req.body;
    const db = await openDb();
    await db.run(
      "INSERT INTO shipments (order_id, status, provider, tracking_id, tracking_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        req.params.id,
        "enviado",
        provider || "",
        trackingId || "",
        trackingUrl || "",
        new Date().toISOString(),
        new Date().toISOString(),
      ]
    );
    await db.run("UPDATE orders SET status = 'enviado' WHERE id = ?", [req.params.id]);
    res.json({ status: "ok" });
  })
);

app.get("/api/shipments", requireRole(["administrador"], async (req, res) => {
  const db = await openDb();
  const rows = await db.all(
    "SELECT shipments.id, shipments.order_id, shipments.status, shipments.provider, shipments.tracking_id, shipments.tracking_url, shipments.created_at, shipments.updated_at FROM shipments ORDER BY shipments.created_at DESC"
  );
  res.json(rows);
}));

app.post("/api/logistics/webhook", async (req, res) => {
  if (!LOGISTICS_WEBHOOK_SECRET) {
    return res.status(400).json({ error: "Logistics webhook secret no configurado" });
  }
  const signature = req.header("x-logistics-signature");
  const expected = crypto
    .createHmac("sha256", LOGISTICS_WEBHOOK_SECRET)
    .update(req.rawBody || "")
    .digest("hex");
  if (signature !== expected) {
    return res.status(401).json({ error: "Firma inválida" });
  }

  const { trackingId, status, providerPayload } = req.body;
  if (!trackingId || !status) {
    return res.status(400).json({ error: "Payload inválido" });
  }

  const db = await openDb();
  const shipment = await db.get(
    "SELECT id, order_id FROM shipments WHERE tracking_id = ? ORDER BY id DESC LIMIT 1",
    [trackingId]
  );
  if (!shipment) {
    return res.status(404).json({ error: "Envío no encontrado" });
  }

  const mapped = mapShipmentStatus(status);
  await db.run(
    "UPDATE shipments SET status = ?, updated_at = ? WHERE id = ?",
    [mapped.shipmentStatus, new Date().toISOString(), shipment.id]
  );
  await db.run(
    "INSERT INTO shipment_events (shipment_id, provider_status, mapped_order_status, payload, created_at) VALUES (?, ?, ?, ?, ?)",
    [
      shipment.id,
      String(status),
      mapped.orderStatus || "",
      JSON.stringify(providerPayload || {}),
      new Date().toISOString(),
    ]
  );

  if (mapped.orderStatus) {
    if (mapped.orderStatus === "entregado") {
      await db.run(
        "UPDATE orders SET status = ?, delivered_at = ? WHERE id = ?",
        [mapped.orderStatus, new Date().toISOString(), shipment.order_id]
      );
    } else {
      await db.run("UPDATE orders SET status = ? WHERE id = ?", [
        mapped.orderStatus,
        shipment.order_id,
      ]);
    }
  }

  res.json({ status: "ok" });
});

app.get(
  "/api/shipments/:id/events",
  requireRole(["administrador"], async (req, res) => {
    const db = await openDb();
    const rows = await db.all(
      "SELECT id, provider_status, mapped_order_status, payload, created_at FROM shipment_events WHERE shipment_id = ? ORDER BY created_at DESC",
      [req.params.id]
    );
    res.json(rows);
  })
);

app.post(
  "/api/payments/link",
  requireRole(
    [
      "administrador",
      "arrendatario",
      "dueno_residente",
      "dueno_no_residente",
    ],
    async (req, res) => {
      const { reference, amount } = req.body;
      if (!reference) {
        return res.status(400).json({ error: "Referencia requerida" });
      }
      const link = `${HAULMER_BASE_URL}?reference=${encodeURIComponent(
        reference
      )}&amount=${encodeURIComponent(amount || "0")}`;
      res.json({ link });
    }
  )
);

app.post(
  "/api/payments/webhook",
  async (req, res) => {
    if (!HAULMER_WEBHOOK_SECRET) {
      return res.status(400).json({ error: "Webhook secret no configurado" });
    }
    const signature = req.header("x-haulmer-signature");
    const expected = crypto
      .createHmac("sha256", HAULMER_WEBHOOK_SECRET)
      .update(req.rawBody || "")
      .digest("hex");
    if (signature !== expected) {
      return res.status(401).json({ error: "Firma inválida" });
    }
    const { orderId, status } = req.body;
    if (!orderId || !status) {
      return res.status(400).json({ error: "Payload inválido" });
    }
    const db = await openDb();
    if (status === "paid") {
      await db.run(
        "UPDATE orders SET status = 'pagado', paid_at = ? WHERE id = ?",
        [new Date().toISOString(), orderId]
      );
    }
    res.json({ status: "ok" });
  }
);

app.post(
  "/api/payments/confirm",
  requireRole(["administrador"], async (req, res) => {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ error: "Orden requerida" });
    }
    const db = await openDb();
    await db.run(
      "UPDATE orders SET status = 'pagado', paid_at = ? WHERE id = ?",
      [new Date().toISOString(), orderId]
    );
    res.json({ status: "ok" });
  })
);

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Servidor activo en http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Error al iniciar base de datos", error);
    process.exit(1);
  });
