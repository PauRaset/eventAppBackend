// controllers/socialController.js
const mongoose = require('mongoose');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { sendPushNotificationToUser } = require('../utils/sendPushNotification');
const UserClubPromotionProgress = require('../models/UserClubPromotionProgress');

// Helpers
const oid = (v) => {
  try {
    return typeof v === 'string' && mongoose.Types.ObjectId.isValid(v) ? new mongoose.Types.ObjectId(v) : v;
  } catch {
    return v;
  }
};
const isObjectId = (v) => {
  try {
    return mongoose.Types.ObjectId.isValid(v);
  } catch {
    return false;
  }
};
const pickUserId = (req) => req.userId || req.user?.id || req.user?._id;

const syncFollowedUsersPromotionCounter = async (userId) => {
  try {
    if (!userId) return;

    const user = await User.findById(userId).select('_id following');
    if (!user) return;

    const followedUsersCount = Array.isArray(user.following) ? user.following.length : 0;

    await UserClubPromotionProgress.updateMany(
      { user: oid(user._id) },
      {
        $set: {
          'counters.followedUsers': followedUsersCount,
        },
      }
    );

    console.log('[promotions][followedUsers] synced user=', String(user._id), 'count=', followedUsersCount);
  } catch (err) {
    console.error('[promotions][followedUsers] sync error', err);
  }
};

const displayNameForUser = (user) => {
  return (
    user?.username ||
    user?.displayName ||
    user?.entityName ||
    user?.name ||
    'Alguien'
  );
};

const previewImageForUser = (user) => {
  return (
    user?.profilePicture ||
    user?.profilePic ||
    user?.avatar ||
    user?.photoURL ||
    user?.photoUrl ||
    null
  );
};

const isPrivateProfile = (user) => {
  return !!(
    user?.isPrivate ||
    user?.privateProfile ||
    user?.profilePrivate ||
    user?.privacy === 'private'
  );
};

const hasPendingFollowRequest = (me, target) => {
  return !!(
    me?.followRequestsSent?.some((id) => String(id) === String(target?._id)) ||
    target?.followRequestsReceived?.some((id) => String(id) === String(me?._id))
  );
};

const createFollowNotification = async ({ actor, target, isRequest = false }) => {
  try {
    if (!actor?._id || !target?._id) return;
    if (String(actor._id) === String(target._id)) return;

    const actorName = displayNameForUser(actor);

    const notification = await Notification.findOneAndUpdate(
      {
        user: target._id,
        actor: actor._id,
        type: isRequest ? 'follow_request' : 'follow',
      },
      {
        $set: {
          title: isRequest ? 'Solicitud de seguimiento' : 'Nuevo seguidor',
          body: isRequest
            ? `${actorName} quiere seguirte.`
            : `${actorName} empezó a seguirte.`,
          routeTarget: isRequest
            ? `follow_request:${actor._id}`
            : `profile:${actor._id}`,
          previewImage: previewImageForUser(actor),
          read: false,
          readAt: null,
          pushSent: false,
          meta: {
            actorUsername: actorName,
            requestPending: !!isRequest,
          },
        },
        $setOnInsert: {
          user: target._id,
          actor: actor._id,
          type: isRequest ? 'follow_request' : 'follow',
        },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );

    if (notification?._id) {
      await sendPushNotificationToUser(target._id, notification);
    }
  } catch (err) {
    console.warn('[notifications][follow] create failed:', err?.message || err);
  }
};

const clearFollowRequestNotification = async ({ actorId, targetId }) => {
  try {
    if (!actorId || !targetId) return;

    await Notification.deleteMany({
      user: targetId,
      actor: actorId,
      type: 'follow_request',
    });
  } catch (err) {
    console.warn('[notifications][follow_request] clear failed:', err?.message || err);
  }
};

// Safe resolve user by key (either ObjectId or firebaseUid)
const resolveUserByKey = async (key) => {
  if (!key) return null;
  if (isObjectId(key)) {
    try {
      return await User.findById(key);
    } catch {
      // ignore cast errors
      return null;
    }
  }
  // fallback to firebaseUid
  return await User.findOne({ firebaseUid: key });
};

// ———————————————————————————————————————————————————————————————————————
// Toggle follow (atomic, idempotent, robust a llamadas repetidas)
// ———————————————————————————————————————————————————————————————————————
exports.toggleFollow = async (req, res) => {
  try {
    const meId = pickUserId(req);
    const targetId = req.body?.targetId;

    console.log('[toggleFollow] meId=', meId, 'targetId=', targetId);

    if (!meId) return res.status(401).json({ message: 'Falta token de autenticación' });
    if (!targetId) return res.status(400).json({ message: 'targetId requerido o inválido' });

    if (String(meId) === String(targetId)) {
      return res.status(400).json({ message: 'No puedes seguirte a ti mismo' });
    }

    // Resolve me and target safely
    const me = isObjectId(meId) ? await resolveUserByKey(meId) : await resolveUserByKey(meId);
    let target;
    if (isObjectId(targetId)) {
      target = await resolveUserByKey(targetId);
    } else {
      target = await User.findOne({ firebaseUid: targetId });
    }

    if (!me) return res.status(401).json({ message: 'No autorizado' });
    if (!target) return res.status(404).json({ message: 'Usuario objetivo no encontrado' });

    // ¿ya lo sigo?
    const already = !!target.followers?.some((f) => String(f) === String(me._id));
    const requestPending = hasPendingFollowRequest(me, target);
    const targetIsPrivate = isPrivateProfile(target);

    // Si ya lo sigo, toggle = unfollow.
    if (already) {
      await Promise.all([
        User.updateOne(
          { _id: oid(me._id) },
          {
            $pull: {
              following: oid(target._id),
              followRequestsSent: oid(target._id),
            },
            $inc: { followingCount: -1 },
          }
        ),
        User.updateOne(
          { _id: oid(target._id) },
          {
            $pull: {
              followers: oid(me._id),
              followRequestsReceived: oid(me._id),
            },
            $inc: { followersCount: -1 },
          }
        ),
      ]);

      await syncFollowedUsersPromotionCounter(me._id);

      const t2 = await User.findById(target._id).select('_id followersCount followingCount followers followRequestsReceived');

      return res.json({
        ok: true,
        isFollowing: false,
        requestPending: false,
        isPrivate: targetIsPrivate,
        action: 'unfollowed',
        target: {
          id: t2._id,
          followers: t2.followersCount ?? (t2.followers?.length ?? 0),
          following: t2.followingCount ?? 0,
        },
      });
    }

    // Si el perfil es privado, toggle = crear/cancelar solicitud.
    if (targetIsPrivate) {
      if (requestPending) {
        await Promise.all([
          User.updateOne({ _id: oid(me._id) }, { $pull: { followRequestsSent: oid(target._id) } }),
          User.updateOne({ _id: oid(target._id) }, { $pull: { followRequestsReceived: oid(me._id) } }),
        ]);

        await clearFollowRequestNotification({ actorId: me._id, targetId: target._id });

        const t2 = await User.findById(target._id).select('_id followersCount followingCount followers followRequestsReceived');

        return res.json({
          ok: true,
          isFollowing: false,
          requestPending: false,
          isPrivate: true,
          action: 'request_cancelled',
          target: {
            id: t2._id,
            followers: t2.followersCount ?? (t2.followers?.length ?? 0),
            following: t2.followingCount ?? 0,
          },
        });
      }

      await Promise.all([
        User.updateOne({ _id: oid(me._id) }, { $addToSet: { followRequestsSent: oid(target._id) } }),
        User.updateOne({ _id: oid(target._id) }, { $addToSet: { followRequestsReceived: oid(me._id) } }),
      ]);

      await createFollowNotification({ actor: me, target, isRequest: true });

      const t2 = await User.findById(target._id).select('_id followersCount followingCount followers followRequestsReceived');

      return res.json({
        ok: true,
        isFollowing: false,
        requestPending: true,
        isPrivate: true,
        action: 'request_sent',
        target: {
          id: t2._id,
          followers: t2.followersCount ?? (t2.followers?.length ?? 0),
          following: t2.followingCount ?? 0,
        },
      });
    }

    // Perfil público: follow directo.
    await Promise.all([
      User.updateOne({ _id: oid(me._id) }, { $addToSet: { following: oid(target._id) }, $pull: { followRequestsSent: oid(target._id) }, $inc: { followingCount: 1 } }),
      User.updateOne({ _id: oid(target._id) }, { $addToSet: { followers: oid(me._id) }, $pull: { followRequestsReceived: oid(me._id) }, $inc: { followersCount: 1 } }),
    ]);

    await Promise.all([
      syncFollowedUsersPromotionCounter(me._id),
      createFollowNotification({ actor: me, target, isRequest: false }),
    ]);

    // Leer contadores consistentes tras la operación
    const t2 = await User.findById(target._id).select('_id followersCount followingCount followers');

    return res.json({
      ok: true,
      isFollowing: true,
      requestPending: false,
      isPrivate: false,
      action: 'followed',
      target: {
        id: t2._id,
        followers: t2.followersCount ?? (t2.followers?.length ?? 0),
        following: t2.followingCount ?? 0,
      },
    });
  } catch (err) {
    console.error('[toggleFollow] err', err);
    return res.status(500).json({ message: 'Error en servidor' });
  }
};

// ———————————————————————————————————————————————————————————————————————
// Follow explícito (legacy)
// ———————————————————————————————————————————————————————————————————————
exports.followUser = async (req, res) => {
  try {
    const meId = pickUserId(req);
    const targetId = req.params.id;

    if (!meId) return res.status(401).json({ message: 'Falta token de autenticación' });
    if (!targetId) return res.status(400).json({ message: 'targetId inválido' });
    if (String(meId) === String(targetId)) return res.status(400).json({ message: 'No puedes seguirte a ti mismo' });

    // Resolve me and target safely
    const me = isObjectId(meId) ? await resolveUserByKey(meId) : await resolveUserByKey(meId);
    let target;
    if (isObjectId(targetId)) {
      target = await resolveUserByKey(targetId);
    } else {
      target = await User.findOne({ firebaseUid: targetId });
    }

    if (!me) return res.status(401).json({ message: 'No autorizado' });
    if (!target) return res.status(404).json({ message: 'Usuario objetivo no encontrado' });

    // Idempotente (si ya sigue, no duplica)
    const already = !!target.followers?.some((f) => String(f) === String(me._id));
    const targetIsPrivate = isPrivateProfile(target);

    if (already) {
      const t2 = await User.findById(target._id).select('_id followersCount followingCount followers');
      return res.json({
        ok: true,
        isFollowing: true,
        requestPending: false,
        isPrivate: targetIsPrivate,
        action: 'already_following',
        target: {
          id: t2._id,
          followers: t2.followersCount ?? (t2.followers?.length ?? 0),
          following: t2.followingCount ?? 0,
        },
      });
    }

    if (targetIsPrivate) {
      await Promise.all([
        User.updateOne({ _id: oid(me._id) }, { $addToSet: { followRequestsSent: oid(target._id) } }),
        User.updateOne({ _id: oid(target._id) }, { $addToSet: { followRequestsReceived: oid(me._id) } }),
      ]);

      await createFollowNotification({ actor: me, target, isRequest: true });

      const t2 = await User.findById(target._id).select('_id followersCount followingCount followers');
      return res.json({
        ok: true,
        isFollowing: false,
        requestPending: true,
        isPrivate: true,
        action: 'request_sent',
        target: {
          id: t2._id,
          followers: t2.followersCount ?? (t2.followers?.length ?? 0),
          following: t2.followingCount ?? 0,
        },
      });
    }

    await Promise.all([
      User.updateOne({ _id: oid(me._id) }, { $addToSet: { following: oid(target._id) }, $pull: { followRequestsSent: oid(target._id) }, $inc: { followingCount: 1 } }),
      User.updateOne({ _id: oid(target._id) }, { $addToSet: { followers: oid(me._id) }, $pull: { followRequestsReceived: oid(me._id) }, $inc: { followersCount: 1 } }),
    ]);

    await Promise.all([
      syncFollowedUsersPromotionCounter(me._id),
      createFollowNotification({ actor: me, target, isRequest: false }),
    ]);

    const t2 = await User.findById(target._id).select('_id followersCount followingCount followers');
    return res.json({
      ok: true,
      isFollowing: true,
      requestPending: false,
      isPrivate: false,
      action: 'followed',
      target: {
        id: t2._id,
        followers: t2.followersCount ?? (t2.followers?.length ?? 0),
        following: t2.followingCount ?? 0,
      },
    });
  } catch (err) {
    console.error('[followUser] err', err);
    return res.status(500).json({ message: 'Error en servidor' });
  }
};

// ———————————————————————————————————————————————————————————————————————
// Unfollow explícito (legacy)
// ———————————————————————————————————————————————————————————————————————
exports.unfollowUser = async (req, res) => {
  try {
    const meId = pickUserId(req);
    const targetId = req.params.id;

    if (!meId) return res.status(401).json({ message: 'Falta token de autenticación' });
    if (!targetId) return res.status(400).json({ message: 'targetId inválido' });
    if (String(meId) === String(targetId)) return res.status(400).json({ message: 'No puedes dejar de seguirte' });

    // Resolve me and target safely
    const me = isObjectId(meId) ? await resolveUserByKey(meId) : await resolveUserByKey(meId);
    let target;
    if (isObjectId(targetId)) {
      target = await resolveUserByKey(targetId);
    } else {
      target = await User.findOne({ firebaseUid: targetId });
    }

    if (!me) return res.status(401).json({ message: 'No autorizado' });
    if (!target) return res.status(404).json({ message: 'Usuario objetivo no encontrado' });

    await Promise.all([
      User.updateOne(
        { _id: oid(me._id) },
        {
          $pull: {
            following: oid(target._id),
            followRequestsSent: oid(target._id),
          },
          $inc: { followingCount: -1 },
        }
      ),
      User.updateOne(
        { _id: oid(target._id) },
        {
          $pull: {
            followers: oid(me._id),
            followRequestsReceived: oid(me._id),
          },
          $inc: { followersCount: -1 },
        }
      ),
    ]);

    await clearFollowRequestNotification({ actorId: me._id, targetId: target._id });

    await syncFollowedUsersPromotionCounter(me._id);

    const t2 = await User.findById(target._id).select('_id followersCount followingCount followers');
    return res.json({
      ok: true,
      isFollowing: false,
      target: {
        id: t2._id,
        followers: t2.followersCount ?? (t2.followers?.length ?? 0),
        following: t2.followingCount ?? 0,
      },
    });
  } catch (err) {
    console.error('[unfollowUser] err', err);
    return res.status(500).json({ message: 'Error en servidor' });
  }
};

// ———————————————————————————————————————————————————————————————————————
// Listas
// ———————————————————————————————————————————————————————————————————————
exports.getFollowers = async (req, res) => {
  try {
    const u = await User.findById(req.params.id)
      .select('followers')
      .populate('followers', '_id username profilePicture');
    if (!u) return res.status(404).json({ message: 'Usuario no encontrado' });
    res.json({ count: u.followers.length, followers: u.followers });
  } catch (err) {
    console.error('[getFollowers] error', err);
    res.status(500).json({ message: 'Error en servidor' });
  }
};

exports.getFollowing = async (req, res) => {
  try {
    const u = await User.findById(req.params.id)
      .select('following')
      .populate('following', '_id username profilePicture');
    if (!u) return res.status(404).json({ message: 'Usuario no encontrado' });
    res.json({ count: u.following.length, following: u.following });
  } catch (err) {
    console.error('[getFollowing] error', err);
    res.status(500).json({ message: 'Error en servidor' });
  }
};

// ———————————————————————————————————————————————————————————————————————
// Stats
// ———————————————————————————————————————————————————————————————————————
exports.getUserStats = async (req, res) => {
  try {
    const meId = pickUserId(req);
    const u = await User.findById(req.params.id)
      .select('followersCount followingCount followers following');
    if (!u) return res.status(404).json({ message: 'Usuario no encontrado' });

    res.json({
      followers: u.followersCount ?? u.followers?.length ?? 0,
      following: u.followingCount ?? u.following?.length ?? 0,
      attending: 0, // el front calcula el grid y puede ajustar esto
      isFollowing: !!(meId && u.followers?.some((f) => String(f) === String(meId))),
    });
  } catch (err) {
    console.error('[getUserStats] err', err);
    res.status(500).json({ message: 'Error en servidor' });
  }
};

// ———————————————————————————————————————————————————————————————————————
// Follow Requests: aceptar / rechazar
// ———————————————————————————————————————————————————————————————————————
exports.acceptFollowRequest = async (req, res) => {
  try {
    const meId = pickUserId(req);
    const requesterId = req.params.id || req.body?.requesterId;

    if (!meId) return res.status(401).json({ message: 'Falta token de autenticación' });
    if (!requesterId) return res.status(400).json({ message: 'requesterId inválido' });

    const me = await resolveUserByKey(meId);
    const requester = await resolveUserByKey(requesterId);

    if (!me) return res.status(401).json({ message: 'No autorizado' });
    if (!requester) return res.status(404).json({ message: 'Usuario solicitante no encontrado' });

    const pending = hasPendingFollowRequest(requester, me);
    if (!pending) {
      return res.status(404).json({ message: 'Solicitud no encontrada' });
    }

    await Promise.all([
      User.updateOne(
        { _id: oid(requester._id) },
        {
          $pull: { followRequestsSent: oid(me._id) },
          $addToSet: { following: oid(me._id) },
          $inc: { followingCount: 1 },
        }
      ),
      User.updateOne(
        { _id: oid(me._id) },
        {
          $pull: { followRequestsReceived: oid(requester._id) },
          $addToSet: { followers: oid(requester._id) },
          $inc: { followersCount: 1 },
        }
      ),
    ]);

    await Promise.all([
      syncFollowedUsersPromotionCounter(requester._id),
      clearFollowRequestNotification({ actorId: requester._id, targetId: me._id }),
      createFollowNotification({ actor: requester, target: me, isRequest: false }),
    ]);

    const refreshed = await User.findById(me._id).select('_id followersCount followingCount followers followRequestsReceived');

    return res.json({
      ok: true,
      accepted: true,
      requesterId: requester._id,
      target: {
        id: refreshed._id,
        followers: refreshed.followersCount ?? (refreshed.followers?.length ?? 0),
        following: refreshed.followingCount ?? 0,
        pendingRequests: refreshed.followRequestsReceived?.length ?? 0,
      },
    });
  } catch (err) {
    console.error('[acceptFollowRequest] err', err);
    return res.status(500).json({ message: 'Error en servidor' });
  }
};

exports.rejectFollowRequest = async (req, res) => {
  try {
    const meId = pickUserId(req);
    const requesterId = req.params.id || req.body?.requesterId;

    if (!meId) return res.status(401).json({ message: 'Falta token de autenticación' });
    if (!requesterId) return res.status(400).json({ message: 'requesterId inválido' });

    const me = await resolveUserByKey(meId);
    const requester = await resolveUserByKey(requesterId);

    if (!me) return res.status(401).json({ message: 'No autorizado' });
    if (!requester) return res.status(404).json({ message: 'Usuario solicitante no encontrado' });

    await Promise.all([
      User.updateOne({ _id: oid(requester._id) }, { $pull: { followRequestsSent: oid(me._id) } }),
      User.updateOne({ _id: oid(me._id) }, { $pull: { followRequestsReceived: oid(requester._id) } }),
    ]);

    await clearFollowRequestNotification({ actorId: requester._id, targetId: me._id });

    const refreshed = await User.findById(me._id).select('_id followersCount followingCount followers followRequestsReceived');

    return res.json({
      ok: true,
      accepted: false,
      requesterId: requester._id,
      target: {
        id: refreshed._id,
        followers: refreshed.followersCount ?? (refreshed.followers?.length ?? 0),
        following: refreshed.followingCount ?? 0,
        pendingRequests: refreshed.followRequestsReceived?.length ?? 0,
      },
    });
  } catch (err) {
    console.error('[rejectFollowRequest] err', err);
    return res.status(500).json({ message: 'Error en servidor' });
  }
};
