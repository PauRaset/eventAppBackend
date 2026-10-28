// controllers/socialController.js
const mongoose = require('mongoose');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { sendPushNotificationToUser } = require('../utils/sendPushNotification');
const UserClubPromotionProgress = require('../models/UserClubPromotionProgress');
// Nombres públicos: nunca nada derivado del teléfono (utils/publicName.js)
const {
  publicUsername,
  publicDisplayName,
  sanitizePublicUser,
  NOT_PHONE_DERIVED_USERNAME,
} = require('../utils/publicName');

// Helpers
const oid = (v) => {
  try {
    return typeof v === 'string' && mongoose.Types.ObjectId.isValid(v) ? new mongoose.Types.ObjectId(v) : v;
  } catch {
    return v;
  }
};
// _id de Mongo de verdad: 24 hex (o un ObjectId). mongoose.isValid acepta
// cualquier texto de 12 caracteres, y un uid de Firebase así se tomaba por _id.
const isObjectId = (v) =>
  v instanceof mongoose.Types.ObjectId || (typeof v === 'string' && /^[a-fA-F0-9]{24}$/.test(v));
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

// Nombre en notificaciones ("X empezó a seguirte"): público, nunca del teléfono
const displayNameForUser = (user) => (user ? publicUsername(user) : 'Alguien');

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

// ———————————————————————————————————————————————————————————————————————
// Seguimientos: alta y baja con contadores CORRECTOS
// El $inc va en la MISMA operación que el cambio del array y condicionado a
// que el cambio ocurra de verdad (filtro: ya estaba / no estaba). Antes el
// $inc era incondicional: dejar de seguir a quien no seguías restaba 1, y dos
// "seguir" a la vez sumaban 2. Cada lado se ajusta a su propio array.
// ———————————————————————————————————————————————————————————————————————
const wasModified = (r) => Number(r?.nModified ?? r?.modifiedCount ?? 0) > 0;

/** followerId empieza a seguir a followeeId. Devuelve { added } (false si ya lo seguía). */
const addFollowEdge = async (followerId, followeeId) => {
  const follower = oid(followerId);
  const followee = oid(followeeId);
  const [a, b] = await Promise.all([
    User.updateOne(
      { _id: follower, following: { $ne: followee } },
      { $addToSet: { following: followee }, $inc: { followingCount: 1 } }
    ),
    User.updateOne(
      { _id: followee, followers: { $ne: follower } },
      { $addToSet: { followers: follower }, $inc: { followersCount: 1 } }
    ),
  ]);
  // La solicitud pendiente (si la había) deja de estarlo
  await Promise.all([
    User.updateOne({ _id: follower }, { $pull: { followRequestsSent: followee } }),
    User.updateOne({ _id: followee }, { $pull: { followRequestsReceived: follower } }),
  ]);
  return { added: wasModified(a) || wasModified(b) };
};

/** followerId deja de seguir a followeeId. Devuelve { removed } (false si no lo seguía). */
const removeFollowEdge = async (followerId, followeeId) => {
  const follower = oid(followerId);
  const followee = oid(followeeId);
  const [a, b] = await Promise.all([
    User.updateOne(
      { _id: follower, following: followee },
      { $pull: { following: followee }, $inc: { followingCount: -1 } }
    ),
    User.updateOne(
      { _id: followee, followers: follower },
      { $pull: { followers: follower }, $inc: { followersCount: -1 } }
    ),
  ]);
  await Promise.all([
    User.updateOne({ _id: follower }, { $pull: { followRequestsSent: followee } }),
    User.updateOne({ _id: followee }, { $pull: { followRequestsReceived: follower } }),
  ]);
  return { removed: wasModified(a) || wasModified(b) };
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
      await removeFollowEdge(me._id, target._id);

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
    await addFollowEdge(me._id, target._id);

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

    await addFollowEdge(me._id, target._id);

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

    await removeFollowEdge(me._id, target._id);

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
const PRIVACY_FIELDS = 'isPrivate privateProfile profilePrivate privacy';

/**
 * ¿Puede quien hace la petición ver las listas (seguidores/seguidos) de `target`?
 * Perfil público: sí. Perfil privado: solo él mismo o quien le sigue DE VERDAD:
 * está en los followers del perfil Y el perfil está en su following (la
 * relación completa, la que la app enseña como "Siguiendo"). Si solo está en
 * un lado (relación rota), NO cuenta: antes bastaba con estar en followers y
 * alguien a quien la app mostraba "Seguir" veía las listas de un privado.
 * Una solicitud pendiente tampoco cuenta.
 * `target` debe venir en bruto (lean): con un documento de Mongoose los campos
 * de privacidad fuera del esquema (privacy, privateProfile...) no se leen.
 * `target.followers` puede venir como ids o ya populado (objetos con _id).
 */
const canViewSocialLists = async (req, target) => {
  if (!isPrivateProfile(target)) return true;
  // El token puede traer uid de Firebase o _id de Mongo: resolvemos al _id
  const viewer = await resolveUserByKey(pickUserId(req));
  if (!viewer) return false;
  const viewerId = String(viewer._id);
  const targetId = String(target._id);
  if (viewerId === targetId) return true;
  const inTheirFollowers = (target.followers || []).some((f) => String(f?._id ?? f) === viewerId);
  const inMyFollowing = (viewer.following || []).some((f) => String(f?._id ?? f) === targetId);
  return inTheirFollowers && inMyFollowing;
};

// Requiere auth (socialRoutes). Perfil privado: solo lo ve él mismo o quien le sigue.
exports.getFollowers = async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    const u = await User.findById(req.params.id)
      .select(`followers ${PRIVACY_FIELDS}`)
      .populate('followers', '_id username phoneNumber profilePicture')
      .lean(); // en bruto: si no, privacy/privateProfile/profilePrivate no se leen
    if (!u) return res.status(404).json({ message: 'Usuario no encontrado' });

    if (!(await canViewSocialLists(req, u))) {
      return res.status(403).json({ message: 'Este perfil es privado' });
    }

    // Misma forma que antes ({ _id, username, profilePicture }); username público, sin teléfono
    const followers = u.followers.map((f) => {
      const { phoneNumber, ...pub } = sanitizePublicUser(f);
      return pub;
    });
    res.json({ count: followers.length, followers });
  } catch (err) {
    console.error('[getFollowers] error', err);
    res.status(500).json({ message: 'Error en servidor' });
  }
};

// Requiere auth (socialRoutes). Perfil privado: solo lo ve él mismo o quien le sigue.
exports.getFollowing = async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    const u = await User.findById(req.params.id)
      .select(`following followers ${PRIVACY_FIELDS}`)
      .populate('following', '_id username phoneNumber profilePicture')
      .lean(); // en bruto: si no, privacy/privateProfile/profilePrivate no se leen
    if (!u) return res.status(404).json({ message: 'Usuario no encontrado' });

    if (!(await canViewSocialLists(req, u))) {
      return res.status(403).json({ message: 'Este perfil es privado' });
    }

    // Misma forma que antes ({ _id, username, profilePicture }); username público, sin teléfono
    const following = u.following.map((f) => {
      const { phoneNumber, ...pub } = sanitizePublicUser(f);
      return pub;
    });
    res.json({ count: following.length, following });
  } catch (err) {
    console.error('[getFollowing] error', err);
    res.status(500).json({ message: 'Error en servidor' });
  }
};


// ———————————————————————————————————————————————————————————————————————
// Listas paginadas (pantalla Seguidores / Seguidos)
// GET /api/social/users/:id/followers/page   y   /following/page
//   :id = _id o "me". Query: limit (1..50, 30), cursor, q (búsqueda por nombre).
// Orden: primero a quienes sigue quien consulta, después el resto; dentro de
// cada grupo, del seguimiento más reciente al más antiguo (posición en el
// array: los nuevos se añaden al final). El cursor guarda grupo + id (y la
// posición, por si esa persona desaparece de la lista entre páginas).
// Cada fila: { _id, displayName, username, avatarUrl, iFollow, isMe, requested }
// ———————————————————————————————————————————————————————————————————————
const PAGE_DEFAULT = 30;
const PAGE_MAX = 50;

const backendBase = (req) => process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;
const absUrlFromUpload = (req, p) => {
  if (!p) return null;
  const str = String(p);
  if (str.startsWith('http')) {
    const idx = str.indexOf('/uploads/');
    return idx !== -1 ? `${backendBase(req)}${str.substring(idx)}` : str;
  }
  return `${backendBase(req)}${str.startsWith('/') ? str : `/${str}`}`;
};

const encodeCursor = (c) => Buffer.from(JSON.stringify(c)).toString('base64url');
const decodeCursor = (raw) => {
  try {
    const c = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (c && (c.g === 0 || c.g === 1) && typeof c.id === 'string' && Number.isInteger(c.i)) return c;
  } catch (_) {}
  return null;
};
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const listSocialPage = (kind) => async (req, res) => {
  try {
    const viewer = await resolveUserByKey(pickUserId(req));
    if (!viewer) return res.status(401).json({ error: 'unauthorized', message: 'No autorizado' });
    const viewerId = String(viewer._id);

    const rawId = String(req.params.id || '');
    const targetId = rawId === 'me' ? viewerId : rawId;
    if (!isObjectId(targetId)) return res.status(404).json({ error: 'user_not_found', message: 'Usuario no encontrado' });

    // followers: siempre, para saber si quien consulta puede ver un perfil privado
    const fields = kind === 'followers' ? 'followers' : 'following followers';
    const target = await User.findById(targetId).select(`${fields} ${PRIVACY_FIELDS}`).lean();
    if (!target) return res.status(404).json({ error: 'user_not_found', message: 'Usuario no encontrado' });

    if (!(await canViewSocialLists(req, target))) {
      return res.status(403).json({ error: 'private_profile', message: 'Este perfil es privado' });
    }

    const limitRaw = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), PAGE_MAX) : PAGE_DEFAULT;

    // Lista completa con su posición (posición mayor = seguimiento más reciente)
    let entries = (target[kind] || []).map((id, i) => ({ id: String(id), i }));

    // Búsqueda por nombre (sin distinguir mayúsculas, por el principio), dentro de esta lista
    const q = String(req.query.q || '').trim().replace(/^@/, '').slice(0, 50);
    if (q && entries.length) {
      const rx = new RegExp(`^${escapeRegExp(q)}`, 'i');
      const hits = await User.find({
        _id: { $in: entries.map((e) => oid(e.id)) },
        $or: [
          // un username sacado del teléfono no se puede buscar
          { $and: [{ username: rx }, NOT_PHONE_DERIVED_USERNAME] },
          { entityName: rx },
          { entName: rx },
        ],
      })
        .select('_id')
        .lean();
      const hitSet = new Set(hits.map((h) => String(h._id)));
      entries = entries.filter((e) => hitSet.has(e.id));
    }

    const iFollowSet = new Set((viewer.following || []).map(String));
    const requestedSet = new Set((viewer.followRequestsSent || []).map(String));

    // Orden: grupo (0 = lo sigo, 1 = el resto) y, dentro, más reciente primero
    const ordered = entries
      .map((e) => ({ ...e, g: iFollowSet.has(e.id) ? 0 : 1 }))
      .sort((a, b) => a.g - b.g || b.i - a.i);

    // Cursor: continuar justo después del último de la página anterior
    let start = 0;
    if (req.query.cursor) {
      const c = decodeCursor(req.query.cursor);
      if (!c) return res.status(400).json({ error: 'invalid_cursor', message: 'Cursor inválido' });
      const pos = ordered.findIndex((e) => e.id === c.id && e.g === c.g);
      start = pos !== -1
        ? pos + 1
        // Ya no está en ese grupo (dejó de seguir, etc.): por su posición guardada
        : ordered.findIndex((e) => e.g > c.g || (e.g === c.g && e.i < c.i));
      if (start === -1) start = ordered.length;
    }

    const page = ordered.slice(start, start + limit);
    const users = page.length
      ? await User.find({ _id: { $in: page.map((e) => oid(e.id)) } })
          // phoneNumber: solo para detectar nombres sacados del teléfono; nunca sale
          .select('_id username entityName entName phoneNumber profilePicture')
          .lean()
      : [];
    const byId = new Map(users.map((u) => [String(u._id), u]));

    const items = page
      .filter((e) => byId.has(e.id)) // cuentas borradas que aún figuran en el array
      .map((e) => {
        const u = byId.get(e.id);
        const iFollow = iFollowSet.has(e.id);
        return {
          _id: e.id,
          displayName: publicDisplayName(u),
          username: publicUsername(u),
          avatarUrl: absUrlFromUpload(req, u.profilePicture),
          iFollow,
          isMe: e.id === viewerId,
          requested: !iFollow && requestedSet.has(e.id),
        };
      });

    const last = page[page.length - 1];
    const hasMore = start + limit < ordered.length;
    return res.json({
      items,
      nextCursor: hasMore && last ? encodeCursor({ g: last.g, i: last.i, id: last.id }) : null,
      total: ordered.length,
    });
  } catch (err) {
    console.error(`[listSocialPage:${kind}] error`, err);
    return res.status(500).json({ message: 'Error en servidor' });
  }
};

exports.getFollowersPage = listSocialPage('followers');
exports.getFollowingPage = listSocialPage('following');

// ———————————————————————————————————————————————————————————————————————
// Eliminar a alguien de MIS seguidores
// DELETE /api/social/users/me/followers/:id
// Para el seguidor eliminado es como si hubiera dejado de seguirme: deja de
// seguirme (contadores de los dos), y se sincroniza su contador de follow_users
// (la misión se recalcula al abrir promociones: los niveles canjeados no se tocan).
// Sin notificación, igual que al dejar de seguir.
// ———————————————————————————————————————————————————————————————————————
exports.removeFollower = async (req, res) => {
  try {
    const me = await resolveUserByKey(pickUserId(req));
    if (!me) return res.status(401).json({ error: 'unauthorized', message: 'No autorizado' });

    const followerId = String(req.params.id || '');
    if (!isObjectId(followerId)) {
      return res.status(404).json({ error: 'not_a_follower', message: 'Esta persona no te sigue' });
    }
    if (followerId === String(me._id)) {
      return res.status(400).json({ error: 'cannot_remove_self', message: 'No puedes eliminarte a ti mismo' });
    }

    const { removed } = await removeFollowEdge(followerId, me._id);
    if (!removed) {
      return res.status(404).json({ error: 'not_a_follower', message: 'Esta persona no te sigue' });
    }

    await syncFollowedUsersPromotionCounter(followerId);

    const refreshed = await User.findById(me._id).select('followersCount').lean();
    return res.json({ ok: true, removed: true, followersCount: refreshed?.followersCount ?? 0 });
  } catch (err) {
    console.error('[removeFollower] err', err);
    return res.status(500).json({ message: 'Error en servidor' });
  }
};

// ———————————————————————————————————————————————————————————————————————
// Stats
// ———————————————————————————————————————————————————————————————————————
exports.getUserStats = async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Usuario no encontrado' });
    const u = await User.findById(req.params.id)
      .select('followersCount followingCount followers following followRequestsReceived');
    if (!u) return res.status(404).json({ message: 'Usuario no encontrado' });

    // isFollowing por _id de Mongo: se resuelve antes quién consulta (el token
    // puede traer el uid de Firebase; antes se comparaba ese uid con los _id
    // del array y salía false aunque le siguiera). Mismo criterio que
    // canViewSocialLists: la relación completa (en sus followers y en mi following).
    const viewer = await resolveUserByKey(pickUserId(req));
    const viewerId = viewer ? String(viewer._id) : null;
    const targetId = String(u._id);

    // Solicitud pendiente de quien consulta hacia este usuario (por _id de Mongo)
    const requestPending = !!(
      viewerId &&
      (viewer.followRequestsSent?.some((f) => String(f) === targetId) ||
        u.followRequestsReceived?.some((f) => String(f) === viewerId))
    );
    // Con solicitud pendiente todavía no le sigue
    const isFollowing = !requestPending && !!(
      viewerId &&
      u.followers?.some((f) => String(f) === viewerId) &&
      viewer.following?.some((f) => String(f) === targetId)
    );

    res.json({
      followers: u.followersCount ?? u.followers?.length ?? 0,
      following: u.followingCount ?? u.following?.length ?? 0,
      attending: 0, // el front calcula el grid y puede ajustar esto
      isFollowing,
      requestPending,
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

    // requester pasa a seguirme (contadores condicionados; quita la solicitud)
    await addFollowEdge(requester._id, me._id);

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
