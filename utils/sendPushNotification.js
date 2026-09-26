

const admin = require('../middlewares/firebaseAdmin');
const User = require('../models/User');

function normalizeRouteTarget(routeTarget) {
  return (routeTarget || '').toString().trim();
}

function notificationDataPayload(notification) {
  const routeTarget = normalizeRouteTarget(notification?.routeTarget);

  return {
    notificationId: notification?._id?.toString?.() || '',
    type: (notification?.type || '').toString(),
    routeTarget,
    eventId: notification?.event?.toString?.() || '',
    photoId: (notification?.photoId || '').toString(),
    reactionType: (notification?.reactionType || '').toString(),
  };
}

async function removeInvalidTokens(userId, invalidTokens = []) {
  if (!userId || !invalidTokens.length) return;

  try {
    await User.updateOne(
      { _id: userId },
      {
        $pull: {
          fcmTokens: {
            token: { $in: invalidTokens },
          },
        },
      }
    );
  } catch (e) {
    console.warn('[push] removeInvalidTokens failed:', e?.message || e);
  }
}

async function sendPushNotificationToUser(userId, notification) {
  try {
    if (!userId || !notification) {
      return { ok: false, sent: 0, reason: 'missing_user_or_notification' };
    }

    const user = await User.findById(userId).select('fcmTokens').lean();
    const tokens = Array.isArray(user?.fcmTokens)
      ? user.fcmTokens
          .map((entry) => (entry?.token || '').toString().trim())
          .filter(Boolean)
      : [];

    const uniqueTokens = Array.from(new Set(tokens));

    if (!uniqueTokens.length) {
      return { ok: true, sent: 0, reason: 'no_tokens' };
    }

    const message = {
      tokens: uniqueTokens,
      notification: {
        title: notification.title || 'NightVibe',
        body: notification.body || '',
      },
      data: notificationDataPayload(notification),
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'nightvibe_notifications',
        },
      },
    };

    const response = await admin.messaging().sendEachForMulticast(message);

    const invalidTokens = [];
    response.responses.forEach((r, index) => {
      if (!r.success) {
        const code = r.error?.code || '';
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/invalid-argument'
        ) {
          invalidTokens.push(uniqueTokens[index]);
        }

        console.warn('[push] token send failed:', code, r.error?.message || '');
      }
    });

    if (invalidTokens.length) {
      await removeInvalidTokens(userId, invalidTokens);
    }

    return {
      ok: true,
      sent: response.successCount || 0,
      failed: response.failureCount || 0,
      removedInvalid: invalidTokens.length,
    };
  } catch (e) {
    console.warn('[push] sendPushNotificationToUser failed:', e?.message || e);
    return { ok: false, sent: 0, error: e?.message || String(e) };
  }
}

module.exports = {
  sendPushNotificationToUser,
};
