// routes/referralAnalytics.js
const express = require('express');
const router = express.Router();

const Order = require('../models/Order');
const Event = require('../models/Event');
const mongoose = require('mongoose');

// (Opcional) clicks/uniqueClicks desde ShareLink
let ShareLink;
try { ShareLink = require('../models/ShareLink'); } catch (_) { ShareLink = null; }

// (Opcional) si quieres devolver username
let User;
try { User = require('../models/User'); } catch (_) { User = null; }

const isValidObjectId = (v) => mongoose.Types.ObjectId.isValid(String(v || ''));

async function enrichUsers(items, idKey = 'userId') {
  if (!User || !Array.isArray(items) || items.length === 0) return items || [];

  const rawIds = items
    .map((item) => String(item?.[idKey] || '').trim())
    .filter(Boolean);

  if (!rawIds.length) return items;

  const mongoIds = rawIds.filter((id) => isValidObjectId(id));
  const firebaseUids = rawIds.filter((id) => !isValidObjectId(id));

  const or = [];
  if (mongoIds.length) {
    or.push({ _id: { $in: mongoIds } });
  }
  if (firebaseUids.length) {
    or.push({ firebaseUid: { $in: firebaseUids } });
  }

  if (!or.length) return items;

  const users = await User.find({ $or: or })
    .select('_id firebaseUid username profilePicture')
    .lean();

  const byMongoId = new Map();
  const byFirebaseUid = new Map();

  for (const u of users) {
    byMongoId.set(String(u._id), u);
    if (u.firebaseUid) {
      byFirebaseUid.set(String(u.firebaseUid), u);
    }
  }

  return items.map((item) => {
    const key = String(item?.[idKey] || '').trim();
    return {
      ...item,
      user: byMongoId.get(key) || byFirebaseUid.get(key) || null,
    };
  });
}
/**
 * GET /api/referrals/club/:clubId/summary
 * Resumen global del club: KPIs, top usuarios, top eventos y canales.
 */
router.get('/club/:clubId/summary', async (req, res) => {
  try {
    const { clubId } = req.params;
    if (!clubId) {
      return res.status(400).json({ ok: false, error: 'clubId required' });
    }

    const paidOrdersMatch = {
      clubId: String(clubId),
      status: 'paid',
    };

    const [
      orderTotalsRaw,
      topUsersSalesRaw,
      topEventsSalesRaw,
      linkTotalsRaw,
      topUsersClicksRaw,
      topEventsClicksRaw,
      byChannelRaw,
    ] = await Promise.all([
      Order.aggregate([
        { $match: paidOrdersMatch },
        {
          $group: {
            _id: null,
            totalOrders: { $sum: 1 },
            totalTickets: { $sum: { $ifNull: ['$qty', 0] } },
            totalRevenueEUR: { $sum: { $ifNull: ['$amountEUR', 0] } },
          },
        },
      ]),

      Order.aggregate([
        { $match: { ...paidOrdersMatch, refUserId: { $ne: null } } },
        {
          $group: {
            _id: '$refUserId',
            orders: { $sum: 1 },
            tickets: { $sum: { $ifNull: ['$qty', 0] } },
            revenueEUR: { $sum: { $ifNull: ['$amountEUR', 0] } },
          },
        },
      ]),

      Order.aggregate([
        { $match: paidOrdersMatch },
        {
          $group: {
            _id: '$eventId',
            orders: { $sum: 1 },
            tickets: { $sum: { $ifNull: ['$qty', 0] } },
            revenueEUR: { $sum: { $ifNull: ['$amountEUR', 0] } },
          },
        },
      ]),

      ShareLink
        ? ShareLink.aggregate([
            { $match: { clubId: String(clubId) } },
            {
              $group: {
                _id: null,
                totalLinks: { $sum: 1 },
                totalClicks: { $sum: { $ifNull: ['$clicks', 0] } },
                totalUniqueClicks: { $sum: { $ifNull: ['$uniqueClicks', 0] } },
              },
            },
          ])
        : Promise.resolve([]),

      ShareLink
        ? ShareLink.aggregate([
            { $match: { clubId: String(clubId), createdByUserId: { $ne: null } } },
            {
              $group: {
                _id: '$createdByUserId',
                links: { $sum: 1 },
                clicks: { $sum: { $ifNull: ['$clicks', 0] } },
                uniqueClicks: { $sum: { $ifNull: ['$uniqueClicks', 0] } },
                lastClickedAt: { $max: '$lastClickedAt' },
              },
            },
          ])
        : Promise.resolve([]),

      ShareLink
        ? ShareLink.aggregate([
            { $match: { clubId: String(clubId) } },
            {
              $group: {
                _id: '$eventId',
                links: { $sum: 1 },
                clicks: { $sum: { $ifNull: ['$clicks', 0] } },
                uniqueClicks: { $sum: { $ifNull: ['$uniqueClicks', 0] } },
                lastClickedAt: { $max: '$lastClickedAt' },
              },
            },
          ])
        : Promise.resolve([]),

      ShareLink
        ? ShareLink.aggregate([
            { $match: { clubId: String(clubId) } },
            {
              $group: {
                _id: { $ifNull: ['$channel', 'unknown'] },
                links: { $sum: 1 },
                clicks: { $sum: { $ifNull: ['$clicks', 0] } },
                uniqueClicks: { $sum: { $ifNull: ['$uniqueClicks', 0] } },
              },
            },
          ])
        : Promise.resolve([]),
    ]);

    const orderTotals = orderTotalsRaw[0] || {
      totalOrders: 0,
      totalTickets: 0,
      totalRevenueEUR: 0,
    };

    const linkTotals = linkTotalsRaw[0] || {
      totalLinks: 0,
      totalClicks: 0,
      totalUniqueClicks: 0,
    };

    const topUsersMap = new Map();

    for (const row of topUsersSalesRaw || []) {
      const key = String(row._id || '');
      if (!key) continue;
      topUsersMap.set(key, {
        userId: key,
        links: 0,
        clicks: 0,
        uniqueClicks: 0,
        orders: Number(row.orders || 0),
        tickets: Number(row.tickets || 0),
        revenueEUR: Number(row.revenueEUR || 0),
        lastClickedAt: null,
      });
    }

    for (const row of topUsersClicksRaw || []) {
      const key = String(row._id || '');
      if (!key) continue;
      const existing = topUsersMap.get(key) || {
        userId: key,
        links: 0,
        clicks: 0,
        uniqueClicks: 0,
        orders: 0,
        tickets: 0,
        revenueEUR: 0,
        lastClickedAt: null,
      };

      existing.links += Number(row.links || 0);
      existing.clicks += Number(row.clicks || 0);
      existing.uniqueClicks += Number(row.uniqueClicks || 0);
      existing.lastClickedAt = row.lastClickedAt || existing.lastClickedAt;
      topUsersMap.set(key, existing);
    }

    let topUsers = Array.from(topUsersMap.values()).sort(
      (a, b) =>
        (b.revenueEUR - a.revenueEUR) ||
        (b.clicks - a.clicks) ||
        (b.uniqueClicks - a.uniqueClicks) ||
        (b.orders - a.orders)
    );

    topUsers = await enrichUsers(topUsers, 'userId');

    const eventIds = Array.from(
      new Set([
        ...(topEventsSalesRaw || []).map((row) => String(row._id || '')).filter(Boolean),
        ...(topEventsClicksRaw || []).map((row) => String(row._id || '')).filter(Boolean),
      ])
    );

    const events = eventIds.length
      ? await Event.find({ _id: { $in: eventIds } })
          .select('_id title name eventTitle coverImage image heroImage startsAt date')
          .lean()
      : [];

    const eventsById = new Map(events.map((ev) => [String(ev._id), ev]));
    const topEventsMap = new Map();

    for (const row of topEventsSalesRaw || []) {
      const key = String(row._id || '');
      if (!key) continue;
      const ev = eventsById.get(key) || null;
      topEventsMap.set(key, {
        eventId: key,
        eventTitle: ev?.title || ev?.name || ev?.eventTitle || 'Evento',
        coverImage: ev?.coverImage || ev?.image || ev?.heroImage || '',
        startsAt: ev?.startsAt || ev?.date || null,
        links: 0,
        clicks: 0,
        uniqueClicks: 0,
        orders: Number(row.orders || 0),
        tickets: Number(row.tickets || 0),
        revenueEUR: Number(row.revenueEUR || 0),
        lastClickedAt: null,
      });
    }

    for (const row of topEventsClicksRaw || []) {
      const key = String(row._id || '');
      if (!key) continue;
      const ev = eventsById.get(key) || null;
      const existing = topEventsMap.get(key) || {
        eventId: key,
        eventTitle: ev?.title || ev?.name || ev?.eventTitle || 'Evento',
        coverImage: ev?.coverImage || ev?.image || ev?.heroImage || '',
        startsAt: ev?.startsAt || ev?.date || null,
        links: 0,
        clicks: 0,
        uniqueClicks: 0,
        orders: 0,
        tickets: 0,
        revenueEUR: 0,
        lastClickedAt: null,
      };

      existing.links += Number(row.links || 0);
      existing.clicks += Number(row.clicks || 0);
      existing.uniqueClicks += Number(row.uniqueClicks || 0);
      existing.lastClickedAt = row.lastClickedAt || existing.lastClickedAt;
      topEventsMap.set(key, existing);
    }

    const topEvents = Array.from(topEventsMap.values()).sort(
      (a, b) =>
        (b.clicks - a.clicks) ||
        (b.uniqueClicks - a.uniqueClicks) ||
        (b.revenueEUR - a.revenueEUR) ||
        (b.orders - a.orders)
    );

    const byChannel = (byChannelRaw || [])
      .map((row) => ({
        channel: String(row._id || 'unknown'),
        links: Number(row.links || 0),
        clicks: Number(row.clicks || 0),
        uniqueClicks: Number(row.uniqueClicks || 0),
        orders: 0,
        tickets: 0,
        revenueEUR: 0,
      }))
      .sort((a, b) => (b.clicks - a.clicks) || (b.uniqueClicks - a.uniqueClicks) || (b.links - a.links));

    return res.json({
      ok: true,
      clubId,
      totalLinks: Number(linkTotals.totalLinks || 0),
      totalClicks: Number(linkTotals.totalClicks || 0),
      totalUniqueClicks: Number(linkTotals.totalUniqueClicks || 0),
      totalOrders: Number(orderTotals.totalOrders || 0),
      totalTickets: Number(orderTotals.totalTickets || 0),
      totalRevenueEUR: Number(orderTotals.totalRevenueEUR || 0),
      topUsers,
      topEvents,
      byChannel,
    });
  } catch (e) {
    console.error('[referrals analytics summary]', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

/**
 * GET /api/referrals/club/:clubId/event/:eventId
 * Ventas atribuidas por usuario que compartió + canal
 */
router.get('/club/:clubId/event/:eventId', async (req, res) => {
  try {
    const { clubId, eventId } = req.params;

    // Validar que el evento pertenece al club. En algunos documentos antiguos
    // puede venir asociado por `clubId`, `club`, `owner`, `createdBy` o `userId`.
    const ev = await Event.findById(eventId)
      .select('clubId club owner createdBy userId')
      .lean();
    if (!ev) return res.status(404).json({ ok: false, error: 'Event not found' });

    const eventClubId = String(
      ev.clubId || ev.club || ev.owner || ev.createdBy || ev.userId || ''
    );

    if (eventClubId !== String(clubId || '')) {
      return res.status(403).json({ ok: false, error: 'Event does not belong to club' });
    }

    const pipeline = [
      {
        $match: {
          clubId: String(clubId),
          eventId: String(eventId),
          status: 'paid',
          refUserId: { $ne: null },
        },
      },
      {
        $group: {
          _id: {
            refUserId: '$refUserId',
            shareChannel: { $ifNull: ['$shareChannel', 'unknown'] },
          },
          orders: { $sum: 1 },

          // ✅ tu schema: qty = nº entradas
          tickets: { $sum: { $ifNull: ['$qty', 0] } },

          // ✅ tu schema: amountEUR = total en euros
          revenueEUR: { $sum: { $ifNull: ['$amountEUR', 0] } },
        },
      },
      { $sort: { revenueEUR: -1, tickets: -1, orders: -1 } },
    ];

    const salesRows = await Order.aggregate(pipeline);

    // === Click analytics (from ShareLink) ===
    let clickRows = [];
    if (ShareLink) {
      clickRows = await ShareLink.aggregate([
        {
          $match: {
            clubId: String(clubId),
            eventId: String(eventId),
            createdByUserId: { $ne: null },
          },
        },
        {
          $group: {
            _id: {
              refUserId: '$createdByUserId',
              shareChannel: { $ifNull: ['$channel', 'unknown'] },
            },
            links: { $sum: 1 },
            clicks: { $sum: { $ifNull: ['$clicks', 0] } },
            uniqueClicks: { $sum: { $ifNull: ['$uniqueClicks', 0] } },
            lastClickedAt: { $max: '$lastClickedAt' },
          },
        },
      ]);
    }

    // bucket por usuario
    const byUser = new Map();
    for (const r of salesRows) {
      const uid = String(r._id.refUserId);
      const ch = String(r._id.shareChannel || 'unknown');

      if (!byUser.has(uid)) {
        byUser.set(uid, {
          refUserId: uid,
          totals: { orders: 0, tickets: 0, revenueEUR: 0, clicks: 0, uniqueClicks: 0, links: 0 },
          channels: [],
        });
      }
      const u = byUser.get(uid);

      u.channels.push({
        channel: ch,
        orders: r.orders || 0,
        tickets: r.tickets || 0,
        revenueEUR: r.revenueEUR || 0,
        clicks: 0,
        uniqueClicks: 0,
        links: 0,
        lastClickedAt: null,
      });

      u.totals.orders += r.orders || 0;
      u.totals.tickets += r.tickets || 0;
      u.totals.revenueEUR += r.revenueEUR || 0;
    }

    // Merge clicks into the same structure (includes users with clicks but 0 sales)
    for (const c of clickRows) {
      const uid = String(c._id.refUserId);
      const ch = String(c._id.shareChannel || 'unknown');

      if (!byUser.has(uid)) {
        byUser.set(uid, {
          refUserId: uid,
          totals: { orders: 0, tickets: 0, revenueEUR: 0, clicks: 0, uniqueClicks: 0, links: 0 },
          channels: [],
        });
      }
      const u = byUser.get(uid);

      // Find or create channel bucket
      let bucket = u.channels.find(x => x.channel === ch);
      if (!bucket) {
        bucket = {
          channel: ch,
          orders: 0,
          tickets: 0,
          revenueEUR: 0,
          clicks: 0,
          uniqueClicks: 0,
          links: 0,
          lastClickedAt: null,
        };
        u.channels.push(bucket);
      }

      bucket.clicks += c.clicks || 0;
      bucket.uniqueClicks += c.uniqueClicks || 0;
      bucket.links += c.links || 0;
      bucket.lastClickedAt = c.lastClickedAt || bucket.lastClickedAt;

      u.totals.clicks += c.clicks || 0;
      u.totals.uniqueClicks += c.uniqueClicks || 0;
      u.totals.links += c.links || 0;
    }

    // Normalize fields for consistent frontend rendering
    for (const u of byUser.values()) {
      u.totals = {
        orders: u.totals.orders || 0,
        tickets: u.totals.tickets || 0,
        revenueEUR: u.totals.revenueEUR || 0,
        clicks: u.totals.clicks || 0,
        uniqueClicks: u.totals.uniqueClicks || 0,
        links: u.totals.links || 0,
      };
      u.channels = (u.channels || []).map(ch => ({
        channel: ch.channel,
        orders: ch.orders || 0,
        tickets: ch.tickets || 0,
        revenueEUR: ch.revenueEUR || 0,
        clicks: ch.clicks || 0,
        uniqueClicks: ch.uniqueClicks || 0,
        links: ch.links || 0,
        lastClickedAt: ch.lastClickedAt || null,
      }));
    }

    let referrals = Array.from(byUser.values()).sort(
      (a, b) =>
        (b.totals.revenueEUR - a.totals.revenueEUR) ||
        (b.totals.tickets - a.totals.tickets) ||
        (b.totals.clicks - a.totals.clicks) ||
        (b.totals.orders - a.totals.orders)
    );

    referrals = await enrichUsers(referrals, 'refUserId');

    const rows = referrals.map((entry) => ({
      userId: entry.refUserId,
      username: entry.user?.username || '',
      profilePicture: entry.user?.profilePicture || '',
      channel: entry.channels?.[0]?.channel || 'unknown',
      links: Number(entry.totals.links || 0),
      clicks: Number(entry.totals.clicks || 0),
      uniqueClicks: Number(entry.totals.uniqueClicks || 0),
      orders: Number(entry.totals.orders || 0),
      tickets: Number(entry.totals.tickets || 0),
      revenueEUR: Number(entry.totals.revenueEUR || 0),
      channels: entry.channels || [],
      user: entry.user || null,
    }));

    return res.json({ ok: true, clubId, eventId, referrals, rows });
  } catch (e) {
    console.error('[referrals analytics]', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
