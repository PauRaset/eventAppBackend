

const express = require('express');
const mongoose = require('mongoose');
const admin = require('../middlewares/firebaseAdmin');

const Notification = require('../models/Notification');
const User = require('../models/User');

const router = express.Router();

function extractIdToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization || '';

  if (auth.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();
  if (auth.startsWith('Firebase ')) return auth.slice('Firebase '.length).trim();

  return (
    req.headers['x-firebase-id-token'] ||
    req.headers['firebase-id-token'] ||
    req.body?.firebaseIdToken ||
    req.body?.idToken ||
    req.query?.firebaseIdToken ||
    req.query?.idToken ||
    ''
  ).toString().trim();
}

async function requireUser(req, res, next) {
  try {
    if (req.user && req.user.id) return next();

    const token = extractIdToken(req);
    if (!token) {
      return res.status(401).json({ message: 'Token requerido' });
    }

    const decoded = await admin.auth().verifyIdToken(token);
    const user = await User.findOrCreateFromFirebase({
      uid: decoded.uid,
      phoneNumber: decoded.phone_number || decoded.phoneNumber || null,
    });

    req.firebaseUser = {
      uid: decoded.uid,
      phone: decoded.phone_number || decoded.phoneNumber || null,
    };

    req.user = { id: user._id.toString() };

    return next();
  } catch (e) {
    console.error('[notifications requireUser] error:', e);
    return res.status(401).json({ message: 'Token inválido' });
  }
}

function normalizeLimit(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return 30;
  return Math.max(1, Math.min(n, 80));
}

function formatNotification(n) {
  const actor = n.actor && typeof n.actor === 'object' ? n.actor : null;
  const event = n.event && typeof n.event === 'object' ? n.event : null;

  const actorUsername = actor?.username || actor?.name || actor?.displayName || null;
  const actorAvatar =
    actor?.profilePicture ||
    actor?.profilePic ||
    actor?.avatar ||
    actor?.photoURL ||
    actor?.photoUrl ||
    null;

  const eventTitle = event?.title || event?.name || null;
  const eventImage = event?.image || event?.coverImage || event?.imageUrl || null;

  return {
    id: n._id.toString(),
    type: n.type,
    title: n.title,
    body: n.body,
    routeTarget: n.routeTarget,
    read: !!n.read,
    readAt: n.readAt || null,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    previewImage: n.previewImage || eventImage || actorAvatar || null,
    reactionType: n.reactionType || null,
    photoId: n.photoId || null,
    actor: actor
      ? {
          id: actor._id?.toString?.() || null,
          username: actorUsername,
          avatar: actorAvatar,
        }
      : null,
    event: event
      ? {
          id: event._id?.toString?.() || null,
          title: eventTitle,
          image: eventImage,
        }
      : null,
    meta: n.meta || {},
  };
}

// GET /api/notifications?limit=30&before=<ISO|ObjectId>&unreadOnly=1&type=photo_reaction
router.get('/', requireUser, async (req, res) => {
  try {
    const limit = normalizeLimit(req.query.limit);
    const unreadOnly = ['1', 'true', 'yes'].includes(
      (req.query.unreadOnly || '').toString().toLowerCase()
    );
    const type = (req.query.type || '').toString().trim();
    const before = (req.query.before || '').toString().trim();

    const query = {
      user: req.user.id,
    };

    if (unreadOnly) query.read = false;
    if (type) query.type = type;

    if (before) {
      if (mongoose.isValidObjectId(before)) {
        const cursor = await Notification.findById(before).select('createdAt').lean();
        if (cursor?.createdAt) query.createdAt = { $lt: cursor.createdAt };
      } else {
        const dt = new Date(before);
        if (!Number.isNaN(dt.getTime())) query.createdAt = { $lt: dt };
      }
    }

    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('actor', 'username name displayName profilePicture profilePic avatar photoURL photoUrl')
      .populate('event', 'title name image coverImage imageUrl')
      .lean();

    const unreadCount = await Notification.countDocuments({
      user: req.user.id,
      read: false,
    });

    return res.json({
      ok: true,
      unreadCount,
      notifications: notifications.map(formatNotification),
      nextCursor:
        notifications.length === limit
          ? notifications[notifications.length - 1]._id.toString()
          : null,
    });
  } catch (e) {
    console.error('[GET /notifications] error:', e);
    return res.status(500).json({ message: 'Error cargando notificaciones' });
  }
});

// GET /api/notifications/unread-count
router.get('/unread-count', requireUser, async (req, res) => {
  try {
    const unreadCount = await Notification.countDocuments({
      user: req.user.id,
      read: false,
    });

    return res.json({ ok: true, unreadCount });
  } catch (e) {
    console.error('[GET /notifications/unread-count] error:', e);
    return res.status(500).json({ message: 'Error cargando contador' });
  }
});

// PUT /api/notifications/read-all
router.put('/read-all', requireUser, async (req, res) => {
  try {
    const now = new Date();

    const result = await Notification.updateMany(
      {
        user: req.user.id,
        read: false,
      },
      {
        $set: {
          read: true,
          readAt: now,
        },
      }
    );

    return res.json({
      ok: true,
      modifiedCount: result.modifiedCount || 0,
    });
  } catch (e) {
    console.error('[PUT /notifications/read-all] error:', e);
    return res.status(500).json({ message: 'Error marcando como leídas' });
  }
});

// PUT /api/notifications/:id/read
router.put('/:id/read', requireUser, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'ID de notificación inválido' });
    }

    const notification = await Notification.findOneAndUpdate(
      {
        _id: id,
        user: req.user.id,
      },
      {
        $set: {
          read: true,
          readAt: new Date(),
        },
      },
      { new: true }
    )
      .populate('actor', 'username name displayName profilePicture profilePic avatar photoURL photoUrl')
      .populate('event', 'title name image coverImage imageUrl')
      .lean();

    if (!notification) {
      return res.status(404).json({ message: 'Notificación no encontrada' });
    }

    return res.json({
      ok: true,
      notification: formatNotification(notification),
    });
  } catch (e) {
    console.error('[PUT /notifications/:id/read] error:', e);
    return res.status(500).json({ message: 'Error marcando notificación como leída' });
  }
});

// DELETE /api/notifications/:id
router.delete('/:id', requireUser, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'ID de notificación inválido' });
    }

    const deleted = await Notification.findOneAndDelete({
      _id: id,
      user: req.user.id,
    }).lean();

    if (!deleted) {
      return res.status(404).json({ message: 'Notificación no encontrada' });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /notifications/:id] error:', e);
    return res.status(500).json({ message: 'Error eliminando notificación' });
  }
});

module.exports = router;
