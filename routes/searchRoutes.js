// routes/searchRoutes.js
const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Event = require("../models/Event");

// ---- helpers ----
function escapeRegex(s = "") {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function getPagination(req) {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize) || 20, 1), 50);
  const skip = (page - 1) * pageSize;
  return { page, pageSize, skip };
}

// Salud rápida
router.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

/* ========================== USERS =========================== */
/**
 * GET /search/users?q=texto&page=1&pageSize=20
 * Busca por username, email, entName, name o phoneNumber.
 */
router.get("/users", async (req, res) => {
  try {
    const qRaw = (req.query.q || "").toString().trim();
    const { page, pageSize, skip } = getPagination(req);

    if (!qRaw) {
      return res.json({ items: [], total: 0, page, pageSize, hasMore: false });
    }

    const rx = new RegExp(escapeRegex(qRaw), "i");
    const match = {
      $or: [
        { username: rx },
        { email: rx },
        { entName: rx },
        { name: rx },
        { phoneNumber: rx },
      ],
    };

    const [total, items] = await Promise.all([
      User.countDocuments(match),
      User.find(match)
        .select("username email entName profilePicture role phoneNumber")
        .sort({ username: 1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
    ]);

    res.json({
      items,
      total,
      page,
      pageSize,
      hasMore: skip + items.length < total,
    });
  } catch (err) {
    console.error("[search/users] error:", err);
    res.status(500).json({ message: "Error buscando usuarios" });
  }
});

/* ========================== EVENTS ========================== */
/**
 * GET /search/events
 * Query params: q, city, category, from, to, page, pageSize
 */
router.get("/events", async (req, res) => {
  try {
    const qRaw = (req.query.q || "").toString().trim();
    const city = (req.query.city || "").toString().trim();
    const category = (req.query.category || "").toString().trim();
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;

    const { page, pageSize, skip } = getPagination(req);

    const filter = {};
    if (qRaw) {
      const rx = new RegExp(escapeRegex(qRaw), "i");
      filter.$or = [
        { title: rx },
        { description: rx },
        { city: rx },
        { street: rx },
        { categories: rx }, // funciona para string o array
      ];
    }
    if (city) filter.city = new RegExp(`^${escapeRegex(city)}$`, "i");
    if (category) filter.categories = new RegExp(escapeRegex(category), "i");
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = from;
      if (to) filter.date.$lte = to;
    }

    const [total, items] = await Promise.all([
      Event.countDocuments(filter),
      Event.find(filter)
        .select("title date city street image categories createdBy attendees")
        .populate("createdBy", "username profilePicture")
        .sort({ date: 1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
    ]);

    res.json({
      items,
      total,
      page,
      pageSize,
      hasMore: skip + items.length < total,
    });
  } catch (err) {
    console.error("[search/events] error:", err);
    res.status(500).json({ message: "Error buscando eventos" });
  }
});

module.exports = router;
