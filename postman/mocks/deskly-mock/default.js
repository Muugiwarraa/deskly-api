/**
 * Deskly API Mock
 *
 * Stands in for the real Deskly server so consumer collections can run
 * without needing a live Node process.
 *
 * Public route (no auth):
 *   GET  /health
 *
 * Authenticated routes (X-API-Key: demo-key):
 *   GET  /desks              ?zone=north|south|quiet (optional filter)
 *   GET  /desks/:deskId
 *   GET  /bookings           ?date=YYYY-MM-DD  &deskId=desk-n  (optional)
 *   POST /bookings           body: { deskId, date, bookedBy? }
 *   GET  /bookings/:bookingId
 *   DELETE /bookings/:bookingId
 *
 * Booking state is held in pm.state and resets on server restart.
 * One seed booking (bkg_seed01 on desk-1) is created automatically so
 * GET /bookings/:id and the 409 conflict case work without any setup.
 */
const http = require("http");
const PORT = process.env.PORT || 4500;
const JSON_HEADER = { "Content-Type": "application/json" };
const API_KEY = "demo-key";

// ── Static desk catalogue (mirrors the real store) ──────────────────────────
const DESKS = [
  { id: "desk-1", label: "North 01", zone: "north", monitor: true,  standing: false },
  { id: "desk-2", label: "North 02", zone: "north", monitor: true,  standing: true  },
  { id: "desk-3", label: "South 01", zone: "south", monitor: false, standing: false },
  { id: "desk-4", label: "South 02", zone: "south", monitor: true,  standing: false },
  { id: "desk-5", label: "Quiet 01", zone: "quiet", monitor: true,  standing: true  },
  { id: "desk-6", label: "Quiet 02", zone: "quiet", monitor: false, standing: false },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Returns today's date offset by `days` as YYYY-MM-DD (UTC). */
function isoDate(days = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Seed booking present after every cold start — makes GET/:id and 409 demos work immediately. */
function seedBookings() {
  return [
    {
      id: "bkg_seed01",
      deskId: "desk-1",
      date: isoDate(1),                   // tomorrow — always in the future
      bookedBy: "priya@example.com",
      createdAt: new Date().toISOString(),
    },
  ];
}

/** Read and JSON-parse the request body. Returns {} on empty or invalid JSON. */
function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

/**
 * Checks X-API-Key header. Writes 401/403 and returns false when invalid,
 * returns true when the key is accepted.
 */
function requireApiKey(req, res) {
  const key = req.headers["x-api-key"];
  if (!key) {
    res.writeHead(401, JSON_HEADER);
    res.end(JSON.stringify({ error: "MISSING_API_KEY", message: "X-API-Key header is required." }));
    return false;
  }
  if (key !== API_KEY) {
    res.writeHead(403, JSON_HEADER);
    res.end(JSON.stringify({ error: "INVALID_API_KEY", message: "The provided API key is not valid." }));
    return false;
  }
  return true;
}

// ── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://localhost`);
  const path   = urlObj.pathname;
  const { method } = req;

  // Initialise (or restore) booking state for this session
  let bookings = await pm.state.get("bookings");
  if (!bookings) {
    bookings = seedBookings();
    await pm.state.set("bookings", bookings);
  }

  // @endpoint GET /health
  if (method === "GET" && path === "/health") {
    res.writeHead(200, JSON_HEADER);
    return res.end(JSON.stringify({ status: "ok", service: "deskly-mock" }));
  }

  // @endpoint GET /desks
  if (method === "GET" && path === "/desks") {
    if (!requireApiKey(req, res)) return;
    const zone    = urlObj.searchParams.get("zone");
    const results = zone
      ? DESKS.filter((d) => d.zone === zone.toLowerCase())
      : DESKS;
    res.writeHead(200, JSON_HEADER);
    return res.end(JSON.stringify({ count: results.length, desks: results }));
  }

  // @endpoint GET /desks/:deskId
  const deskMatch = path.match(/^\/desks\/([^/]+)$/);
  if (method === "GET" && deskMatch) {
    if (!requireApiKey(req, res)) return;
    const desk = DESKS.find((d) => d.id === deskMatch[1]);
    if (!desk) {
      res.writeHead(404, JSON_HEADER);
      return res.end(JSON.stringify({
        error: "DESK_NOT_FOUND",
        message: `No desk exists with id ${deskMatch[1]}.`,
      }));
    }
    res.writeHead(200, JSON_HEADER);
    return res.end(JSON.stringify(desk));
  }

  // @endpoint GET /bookings
  if (method === "GET" && path === "/bookings") {
    if (!requireApiKey(req, res)) return;
    const date   = urlObj.searchParams.get("date");
    const deskId = urlObj.searchParams.get("deskId");
    const results = bookings.filter(
      (b) => (!date || b.date === date) && (!deskId || b.deskId === deskId)
    );
    res.writeHead(200, JSON_HEADER);
    return res.end(JSON.stringify({ count: results.length, bookings: results }));
  }

  // @endpoint POST /bookings
  if (method === "POST" && path === "/bookings") {
    if (!requireApiKey(req, res)) return;
    const body = await readBody(req);

    // Required fields
    const missing = ["deskId", "date"].filter((f) => !body[f]);
    if (missing.length) {
      res.writeHead(400, JSON_HEADER);
      return res.end(JSON.stringify({
        error: "VALIDATION_ERROR",
        message: "Both deskId and date are required to create a booking.",
        details: missing.map((f) => ({ field: f, issue: "required" })),
      }));
    }

    // Date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      res.writeHead(400, JSON_HEADER);
      return res.end(JSON.stringify({
        error: "VALIDATION_ERROR",
        message: "date must be formatted as YYYY-MM-DD.",
        details: [{ field: "date", issue: "format" }],
      }));
    }

    // Date not in the past
    if (body.date < isoDate(0)) {
      res.writeHead(400, JSON_HEADER);
      return res.end(JSON.stringify({
        error: "VALIDATION_ERROR",
        message: "date must not be in the past.",
        details: [{ field: "date", issue: "past" }],
      }));
    }

    // Desk exists
    if (!DESKS.find((d) => d.id === body.deskId)) {
      res.writeHead(404, JSON_HEADER);
      return res.end(JSON.stringify({
        error: "DESK_NOT_FOUND",
        message: `No desk exists with id ${body.deskId}.`,
      }));
    }

    // Conflict
    const conflict = bookings.find(
      (b) => b.deskId === body.deskId && b.date === body.date
    );
    if (conflict) {
      res.writeHead(409, JSON_HEADER);
      return res.end(JSON.stringify({
        error: "DESK_UNAVAILABLE",
        message: `Desk ${body.deskId} is already booked on ${body.date}.`,
        conflictingBookingId: conflict.id,
      }));
    }

    const booking = {
      id: "bkg_" + Math.random().toString(16).slice(2, 8).padEnd(6, "0"),
      deskId: body.deskId,
      date: body.date,
      bookedBy: body.bookedBy || "unassigned",
      createdAt: new Date().toISOString(),
    };
    bookings.push(booking);
    await pm.state.set("bookings", bookings);
    res.writeHead(201, JSON_HEADER);
    return res.end(JSON.stringify(booking));
  }

  // @endpoint GET /bookings/:bookingId
  // @endpoint DELETE /bookings/:bookingId
  const bookingMatch = path.match(/^\/bookings\/([^/]+)$/);
  if (bookingMatch && (method === "GET" || method === "DELETE")) {
    if (!requireApiKey(req, res)) return;
    const booking = bookings.find((b) => b.id === bookingMatch[1]);

    if (!booking) {
      res.writeHead(404, JSON_HEADER);
      return res.end(JSON.stringify({
        error: "BOOKING_NOT_FOUND",
        message: `No booking exists with id ${bookingMatch[1]}.`,
      }));
    }

    if (method === "GET") {
      res.writeHead(200, JSON_HEADER);
      return res.end(JSON.stringify(booking));
    }

    // DELETE
    await pm.state.set("bookings", bookings.filter((b) => b.id !== bookingMatch[1]));
    res.writeHead(200, JSON_HEADER);
    return res.end(JSON.stringify({ released: true, bookingId: bookingMatch[1] }));
  }

  // ── 404 fallback ─────────────────────────────────────────────────────────
  res.writeHead(404, JSON_HEADER);
  res.end(JSON.stringify({
    error: "ENDPOINT_NOT_FOUND",
    message: `${method} ${path} is not defined in this mock.`,
  }));
});

server.listen(PORT, () => console.log(`Deskly Mock running on port ${PORT}`));