

const express = require('express');
const admin = require('../middlewares/firebaseAdmin');

const User = require('../models/User');

const router = express.Router();

function extractIdToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization || '';

  if (auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }

  if (auth.startsWith('Firebase ')) {
    return auth.slice('Firebase '.length).trim();
  }

  return (
    req.headers['x-firebase-id-token'] ||
    req.headers['firebase-id-token'] ||
    req.body?.firebaseIdToken ||
    req.body?.idToken ||
    req.query?.firebaseIdToken ||
    req.query?.idToken ||
    ''
  )
    .toString()
    .trim();
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

    req.user = {
      id: user._id.toString(),
    };

    req.mongoUser = user;

    return next();
  } catch (e) {
    console.error('[push requireUser] error:', e);
    return res.status(401).json({ message: 'Token inválido' });
  }
}

// POST /api/push/register
router.post('/register', requireUser, async (req, res) => {
  try {
    const token = (req.body?.token || '').toString().trim();
    const platform = (req.body?.platform || 'unknown').toString().trim().toLowerCase();
    const deviceName = (req.body?.deviceName || '').toString().trim();

    if (!token) {
      return res.status(400).json({ message: 'FCM token requerido' });
    }

    const allowedPlatforms = ['ios', 'android', 'web', 'unknown'];

    await req.mongoUser.addFcmToken({
      token,
      platform: allowedPlatforms.includes(platform) ? platform : 'unknown',
      deviceName,
    });

    return res.json({
      ok: true,
      registered: true,
      tokensCount: Array.isArray(req.mongoUser.fcmTokens)
        ? req.mongoUser.fcmTokens.length
        : undefined,
    });
  } catch (e) {
    console.error('[POST /push/register] error:', e);
    return res.status(500).json({ message: 'Error registrando dispositivo push' });
  }
});

// DELETE /api/push/register
router.delete('/register', requireUser, async (req, res) => {
  try {
    const token = (req.body?.token || req.query?.token || '')
      .toString()
      .trim();

    if (!token) {
      return res.status(400).json({ message: 'FCM token requerido' });
    }

    const removed = await req.mongoUser.removeFcmToken(token);

    return res.json({
      ok: true,
      removed,
    });
  } catch (e) {
    console.error('[DELETE /push/register] error:', e);
    return res.status(500).json({ message: 'Error eliminando dispositivo push' });
  }
});

// GET /api/push/me
router.get('/me', requireUser, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select('fcmTokens')
      .lean();

    return res.json({
      ok: true,
      devices: Array.isArray(user?.fcmTokens)
        ? user.fcmTokens.map((entry) => ({
            platform: entry.platform || 'unknown',
            deviceName: entry.deviceName || '',
            lastSeenAt: entry.lastSeenAt || null,
            tokenPreview:
              typeof entry.token === 'string' && entry.token.length > 14
                ? `${entry.token.slice(0, 8)}...${entry.token.slice(-6)}`
                : 'hidden',
          }))
        : [],
    });
  } catch (e) {
    console.error('[GET /push/me] error:', e);
    return res.status(500).json({ message: 'Error cargando dispositivos push' });
  }
});

module.exports = router;
