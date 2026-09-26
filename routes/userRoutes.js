// routes/userRoutes.js
const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const sharp = require("sharp");

const User = require("../models/User");
const Event = require("../models/Event");
const authenticateToken = require("../middlewares/authMiddleware");

// Inicializa firebase-admin (igual que en eventRoutes)
require("../middlewares/firebaseAdmin");
const admin = require("firebase-admin");

/* -------------------------------------------------------------
   Helpers
------------------------------------------------------------- */
function backendBase(req) {
  return process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`;
}

function absUrlFromUpload(req, p) {
  if (!p) return null;
  const base = backendBase(req);

  if (typeof p !== "string") p = String(p);

  if (p.startsWith("http")) {
    const idx = p.indexOf("/uploads/");
    if (idx !== -1) return `${base}${p.substring(idx)}`;
    return p; // URL externa no /uploads
  }
  const clean = p.startsWith("/") ? p : `/${p}`;
  return `${base}${clean}`;
}

// Saca idToken de headers, si viene
function extractIdToken(req) {
  const h = req.headers || {};
  const auth = h.authorization || h.Authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  if (auth.startsWith("Firebase ")) return auth.slice(8).trim();
  return (
    h["x-firebase-id-token"] ||
    h["firebase-id-token"] ||
    h["firebase_token"] ||
    h["idtoken"] ||
    (req.body && (req.body.firebaseIdToken || req.body.idToken)) ||
    null
  );
}

/* -------------------------------------------------------------
   AUTH BRIDGE: acepta Firebase O tu JWT propio
------------------------------------------------------------- */
async function anyAuth(req, res, next) {
  const token = extractIdToken(req);
  if (!token) {
    // sin token Firebase -> intenta tu JWT
    return authenticateToken(req, res, next);
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.firebaseUser = {
      uid: decoded.uid,
      phone: decoded.phone_number || decoded.phoneNumber || null,
      displayName: decoded.name || null,
      photoURL: decoded.picture || null,
    };
    return next();
  } catch (_) {
    // no era Firebase válido -> usa tu JWT
    return authenticateToken(req, res, next);
  }
}
// Variante "opcional": intenta auth pero no bloquea si no hay token o es inválido.
async function optionalAnyAuth(req, res, next) {
  const token = extractIdToken(req);
  if (!token) return next();

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.firebaseUser = {
      uid: decoded.uid,
      phone: decoded.phone_number || decoded.phoneNumber || null,
      displayName: decoded.name || null,
      photoURL: decoded.picture || null,
    };
    return next();
  } catch (_) {
    // Si no era Firebase válido, intenta JWT, pero sin bloquear si falla.
    try {
      return authenticateToken(req, res, next);
    } catch (e) {
      return next();
    }
  }
}

// Garantiza req.user.id (ObjectId string de Mongo)
// - si viene de tu JWT: ya lo pone el middleware
// - si viene de Firebase: crea/encuentra el User y lo setea
async function ensureUserId(req, res, next) {
  if (req.user && req.user.id) return next();
  if (req.firebaseUser && req.firebaseUser.uid) {
    try {
      const user = await User.findOrCreateFromFirebase({
        uid: req.firebaseUser.uid,
        phoneNumber: req.firebaseUser.phone,
        displayName: req.firebaseUser.displayName,
        photoURL: req.firebaseUser.photoURL,
      });
      req.user = { id: user._id.toString() };
      return next();
    } catch (err) {
      console.error("[ensureUserId] error:", err);
      return res.status(401).json({ message: "No autorizado" });
    }
  }
  return res.status(401).json({ message: "Usuario no autenticado" });
}

/* -------------------------------------------------------------
   Multer + Sharp para avatar
------------------------------------------------------------- */
const ROOT_UPLOADS_DIR = path.join(__dirname, "..", "uploads");
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureDir(ROOT_UPLOADS_DIR);
    cb(null, ROOT_UPLOADS_DIR);
  },
  filename: (req, file, cb) => cb(null, Date.now() + "_" + file.originalname),
});
const upload = multer({ storage });

async function processImageToJpg(srcPath, outDir, baseName) {
  ensureDir(outDir);
  const outPath = path.join(outDir, `${baseName}.jpg`);
  try {
    await sharp(srcPath)
      .rotate()
      .resize(800, 800, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toFile(outPath);
    return outPath;
  } catch (e) {
    const fallback = path.join(outDir, `${baseName}${path.extname(srcPath) || ""}`);
    fs.copyFileSync(srcPath, fallback);
    return fallback;
  } finally {
    try { fs.unlinkSync(srcPath); } catch {}
  }
}

/* -------------------------------------------------------------
   GET /api/users/me/attending  (ahora con anyAuth)
------------------------------------------------------------- */
router.get("/me/attending", anyAuth, ensureUserId, async (req, res) => {
  try {
    const userId = req.user.id;
    const events = await Event.find({ attendees: userId })
      .select("title date image createdBy")
      .sort({ date: -1 })
      .lean();

    const out = events.map((e) => ({
      id: e._id.toString(),
      title: e.title,
      date: e.date,
      imageUrl: absUrlFromUpload(req, e.image),
    }));

    res.json(out);
  } catch (err) {
    console.error("[/me/attending] error:", err);
    res.status(500).json({ message: "Error obteniendo tus eventos" });
  }
});

/* -------------------------------------------------------------
   GET /api/users/me  (JWT o Firebase)
------------------------------------------------------------- */
router.get("/me", anyAuth, ensureUserId, async (req, res) => {
  try {
    const u = await User.findById(req.user.id).lean();
    if (!u) return res.status(404).json({ message: "Usuario no encontrado" });

    const avatarRaw = u.profilePicture || u.avatar || null;

    return res.json({
      _id: u._id,
      id: u._id,
      username: u.username,
      email: u.email || null,
      phoneNumber: u.phoneNumber || null,
      role: u.role || null,
      entName: u.entName || "",
      wUser: u.wUser || "",
      profilePicture: u.profilePicture || "",
      profilePictureUrl: absUrlFromUpload(req, avatarRaw),
      isPrivate: !!u.isPrivate,
      privacySettings: u.privacySettings || {},
      attendancesVisibility: u.attendancesVisibility || u.privacySettings?.attendancesVisibility || "followers",
      momentsVisibility: u.momentsVisibility || u.privacySettings?.momentsVisibility || "followers",
      locationVisibility: u.locationVisibility || u.privacySettings?.locationVisibility || "private",
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    });
  } catch (err) {
    console.error("[GET /api/users/me] error:", err);
    return res.status(500).json({ message: "No se pudo obtener el usuario actual" });
  }
});

/* -------------------------------------------------------------
   PATCH/PUT /api/users/me  (actualiza perfil)
   Campos permitidos: username, entName, wUser, role (opcional)
------------------------------------------------------------- */
function normalizeVisibility(value, fallback = "followers") {
  const raw = (value || fallback).toString().toLowerCase().trim();
  if (["public", "followers", "private"].includes(raw)) return raw;
  return fallback;
}

function sanitizeProfileUpdate(body) {
  const allowed = ["username", "entName", "wUser", "role", "isPrivate"];
  const out = {};

  for (const k of allowed) {
    if (typeof body[k] !== "undefined") out[k] = body[k];
  }

  const incomingPrivacy = body.privacySettings && typeof body.privacySettings === "object"
    ? body.privacySettings
    : {};

  const attendancesVisibility = normalizeVisibility(
    body.attendancesVisibility || incomingPrivacy.attendancesVisibility,
    "followers"
  );
  const momentsVisibility = normalizeVisibility(
    body.momentsVisibility || incomingPrivacy.momentsVisibility,
    "followers"
  );
  const locationVisibility = normalizeVisibility(
    body.locationVisibility || incomingPrivacy.locationVisibility,
    "private"
  );

  if (
    typeof body.attendancesVisibility !== "undefined" ||
    typeof body.momentsVisibility !== "undefined" ||
    typeof body.locationVisibility !== "undefined" ||
    body.privacySettings
  ) {
    out.attendancesVisibility = attendancesVisibility;
    out.momentsVisibility = momentsVisibility;
    out.locationVisibility = locationVisibility;
    out.privacySettings = {
      attendancesVisibility,
      momentsVisibility,
      locationVisibility,
    };
  }

  return out;
}

router.patch("/me", anyAuth, ensureUserId, async (req, res) => {
  try {
    const update = sanitizeProfileUpdate(req.body);
    const user = await User.findByIdAndUpdate(req.user.id, update, { new: true }).lean();
    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

    return res.json({
      _id: user._id,
      id: user._id,
      username: user.username,
      entName: user.entName || "",
      wUser: user.wUser || "",
      role: user.role || null,
      isPrivate: !!user.isPrivate,
      privacySettings: user.privacySettings || {},
      attendancesVisibility: user.attendancesVisibility || user.privacySettings?.attendancesVisibility || "followers",
      momentsVisibility: user.momentsVisibility || user.privacySettings?.momentsVisibility || "followers",
      locationVisibility: user.locationVisibility || user.privacySettings?.locationVisibility || "private",
      profilePictureUrl: absUrlFromUpload(req, user.profilePicture || user.avatar || null),
    });
  } catch (err) {
    console.error("[PATCH /api/users/me] error:", err);
    res.status(500).json({ message: "No se pudo actualizar el perfil" });
  }
});

router.put("/me", anyAuth, ensureUserId, async (req, res) => {
  // mismo handler que PATCH
  return router.handle({ ...req, method: "PATCH" }, res);
});

/* -------------------------------------------------------------
   POST /api/users/me/avatar  (subir/cambiar avatar)
------------------------------------------------------------- */

router.post("/me/avatar", anyAuth, ensureUserId, upload.single("avatar"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Falta el archivo "avatar"' });

    const processedDir = ROOT_UPLOADS_DIR;
    const processedImagePath = await processImageToJpg(
      req.file.path,
      processedDir,
      `avatar-${Date.now()}-${path.parse(req.file.originalname).name}`
    );

    const rel = path
      .relative(path.join(__dirname, ".."), processedImagePath)
      .replace(/\\/g, "/");

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { profilePicture: rel },
      { new: true }
    ).lean();

    return res.json({
      _id: user._id,
      id: user._id,
      profilePicture: rel,
      profilePictureUrl: absUrlFromUpload(req, rel),
    });
  } catch (err) {
    console.error("[POST /api/users/me/avatar] error:", err);
    res.status(500).json({ message: "No se pudo subir el avatar", error: err.message });
  }
});

/* -------------------------------------------------------------
   GET /api/users/:id/moments
   Fotos aprobadas subidas por un usuario en eventos/clubs.
------------------------------------------------------------- */
async function resolveUserByAnyId(id) {
  const or = [];
  if (/^[a-fA-F0-9]{24}$/.test(id)) or.push({ _id: id });
  or.push({ firebaseUid: id }, { username: id }, { phoneNumber: id });
  return User.findOne({ $or: or }).lean();
}

async function resolveViewerMongoId(req) {
  if (req.user && req.user.id) return String(req.user.id);

  const firebaseUid = req.firebaseUser && req.firebaseUser.uid
    ? String(req.firebaseUser.uid)
    : '';

  if (!firebaseUid) return '';

  const viewer = await User.findOne({ firebaseUid }).select('_id').lean();
  return viewer?._id ? String(viewer._id) : '';
}

function userFollowsTarget(viewerId, targetUser) {
  if (!viewerId || !targetUser) return false;

  const followers = Array.isArray(targetUser.followers) ? targetUser.followers : [];
  return followers.some((id) => String(id) === String(viewerId));
}

function visibilityFor(targetUser, key, fallback) {
  const nested = targetUser?.privacySettings && typeof targetUser.privacySettings === "object"
    ? targetUser.privacySettings[key]
    : null;
  return normalizeVisibility(targetUser?.[key] || nested, fallback);
}

function canViewByVisibility({ visibility, isOwner, viewerId, targetUser }) {
  if (isOwner) return true;
  if (visibility === "public") return true;
  if (visibility === "followers") return userFollowsTarget(viewerId, targetUser);
  return false;
}

function rawPhotoValue(photo) {
  if (!photo) return '';
  return (
    photo.url ||
    photo.imageUrl ||
    photo.path ||
    photo.src ||
    photo.file ||
    photo.filename ||
    ''
  ).toString();
}

function photoReactionsSummary(photo) {
  const reactions = Array.isArray(photo?.reactions) ? photo.reactions : [];
  const byType = {};

  for (const reaction of reactions) {
    const type = (reaction?.type || '').toString().trim();
    if (!type) continue;
    byType[type] = (byType[type] || 0) + 1;
  }

  return {
    total: reactions.length,
    byType,
  };
}

router.get('/:id/moments', optionalAnyAuth, async (req, res) => {
  try {
    const target = await resolveUserByAnyId(req.params.id);
    if (!target) return res.status(404).json({ message: 'Usuario no encontrado' });

    const viewerId = await resolveViewerMongoId(req);
    const targetId = String(target._id);
    const targetUid = target.firebaseUid ? String(target.firebaseUid) : '';
    const viewerUid = req.firebaseUser && req.firebaseUser.uid ? String(req.firebaseUser.uid) : '';
    const isOwner =
      (viewerId && viewerId === targetId) ||
      (viewerUid && targetUid && viewerUid === targetUid);

    const momentsVisibility = visibilityFor(target, "momentsVisibility", target.isPrivate ? "followers" : "public");
    const canSeeMoments = canViewByVisibility({
      visibility: momentsVisibility,
      isOwner,
      viewerId,
      targetUser: target,
    });

    if (!canSeeMoments) {
      return res.status(403).json({ message: 'Momentos privados' });
    }

    const events = await Event.find({
      'photos.by': target._id,
    })
      .select('title date image createdBy photos')
      .populate('createdBy', 'username displayName entName profilePicture')
      .sort({ date: -1, updatedAt: -1 })
      .lean();

    const moments = [];

    for (const event of events) {
      const eventId = String(event._id);
      const eventTitle = event.title || 'Evento NightVibe';
      const club = event.createdBy || null;

      const photos = Array.isArray(event.photos) ? event.photos : [];
      for (const photo of photos) {
        if (!photo?.by || String(photo.by) !== targetId) continue;

        const status = (photo.status || '').toString().toLowerCase();
        const validationResult = (photo.validationResult || '').toString().toLowerCase();
        const isApproved =
          status === 'approved' ||
          validationResult === 'approved' ||
          validationResult === 'valid';

        // Para terceros solo mostramos momentos aprobados. El dueño puede ver también pendientes/rechazados.
        if (!isOwner && !isApproved) continue;

        const reactions = photoReactionsSummary(photo);
        const photoUrl = absUrlFromUpload(req, rawPhotoValue(photo));
        if (!photoUrl) continue;

        moments.push({
          id: photo.photoId || `${eventId}:${rawPhotoValue(photo)}`,
          photoId: photo.photoId || '',
          photoUrl,
          uploadedAt: photo.uploadedAt || photo.createdAt || event.date || null,
          status: photo.status || null,
          validationResult: photo.validationResult || null,
          isApproved,
          reactionsTotal: reactions.total,
          reactionsByType: reactions.byType,
          event: {
            id: eventId,
            title: eventTitle,
            imageUrl: absUrlFromUpload(req, event.image),
            date: event.date || null,
          },
          club: club
            ? {
                id: String(club._id || ''),
                username: club.username || club.displayName || club.entName || '',
                displayName: club.displayName || club.username || club.entName || '',
                profilePictureUrl: absUrlFromUpload(req, club.profilePicture),
              }
            : null,
        });
      }
    }

    moments.sort((a, b) => {
      const ad = a.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
      const bd = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
      return bd - ad;
    });

    const limit = Math.min(Math.max(parseInt(req.query.limit || '60', 10) || 60, 1), 120);

    return res.json({
      ok: true,
      userId: targetId,
      count: moments.length,
      moments: moments.slice(0, limit),
    });
  } catch (err) {
    console.error('[GET /users/:id/moments]', err);
    return res.status(500).json({ message: 'Error obteniendo momentos del usuario' });
  }
});


/* -------------------------------------------------------------
   GET /api/users/:id/club-moments
   Fotos aprobadas subidas por asistentes en eventos creados por un club.
------------------------------------------------------------- */
router.get('/:id/club-moments', optionalAnyAuth, async (req, res) => {
  try {
    const clubUser = await resolveUserByAnyId(req.params.id);
    if (!clubUser) return res.status(404).json({ message: 'Club no encontrado' });

    const clubId = String(clubUser._id);

    const events = await Event.find({
      createdBy: clubUser._id,
      photos: { $exists: true, $ne: [] },
    })
      .select('title date image createdBy photos')
      .populate('createdBy', 'username displayName entName profilePicture')
      .populate('photos.by', 'username displayName profilePicture')
      .sort({ date: -1, updatedAt: -1 })
      .lean();

    const moments = [];

    for (const event of events) {
      const eventId = String(event._id);
      const eventTitle = event.title || 'Evento NightVibe';
      const club = event.createdBy || clubUser;
      const photos = Array.isArray(event.photos) ? event.photos : [];

      for (const photo of photos) {
        const status = (photo.status || '').toString().toLowerCase();
        const validationResult = (photo.validationResult || '').toString().toLowerCase();
        const isApproved =
          status === 'approved' ||
          validationResult === 'approved' ||
          validationResult === 'valid';

        // En perfiles de club solo mostramos contenido ya aprobado/validado.
        if (!isApproved) continue;

        const photoUrl = absUrlFromUpload(req, rawPhotoValue(photo));
        if (!photoUrl) continue;

        const uploader = photo.by && typeof photo.by === 'object' ? photo.by : null;
        const reactions = photoReactionsSummary(photo);

        moments.push({
          id: photo.photoId || `${eventId}:${rawPhotoValue(photo)}`,
          photoId: photo.photoId || '',
          photoUrl,
          uploadedAt: photo.uploadedAt || photo.createdAt || event.date || null,
          status: photo.status || null,
          validationResult: photo.validationResult || null,
          isApproved,
          reactionsTotal: reactions.total,
          reactionsByType: reactions.byType,
          event: {
            id: eventId,
            title: eventTitle,
            imageUrl: absUrlFromUpload(req, event.image),
            date: event.date || null,
          },
          club: {
            id: String(club._id || clubId),
            username: club.username || club.displayName || club.entName || '',
            displayName: club.displayName || club.username || club.entName || '',
            profilePictureUrl: absUrlFromUpload(req, club.profilePicture),
          },
          uploader: uploader
            ? {
                id: String(uploader._id || ''),
                username: uploader.username || uploader.displayName || photo.byUsername || '',
                displayName: uploader.displayName || uploader.username || photo.byUsername || '',
                profilePictureUrl: absUrlFromUpload(req, uploader.profilePicture),
              }
            : {
                id: photo.by ? String(photo.by) : '',
                username: photo.byUsername || '',
                displayName: photo.byUsername || '',
                profilePictureUrl: null,
              },
        });
      }
    }

    moments.sort((a, b) => {
      const ad = a.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
      const bd = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
      return bd - ad;
    });

    const limit = Math.min(Math.max(parseInt(req.query.limit || '80', 10) || 80, 1), 160);

    return res.json({
      ok: true,
      clubId,
      count: moments.length,
      moments: moments.slice(0, limit),
    });
  } catch (err) {
    console.error('[GET /users/:id/club-moments]', err);
    return res.status(500).json({ message: 'Error obteniendo momentos del club' });
  }
});

/* =============================================================
   NUEVOS ENDPOINTS PARA HIDRATAR ASISTENTES (no tocan nada más)
   - GET /api/users/:id
   - GET /api/users?ids=a,b,c
   - POST /api/users/batch
   - GET /api/users/:id/avatar
   (Colocados después de /me* para evitar conflictos de orden)
============================================================= */

// GET /api/users/:id/attending  -> lista de eventos donde el usuario asiste
router.get("/:id/attending", optionalAnyAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const or = [];
    if (/^[a-fA-F0-9]{24}$/.test(id)) or.push({ _id: id });
    or.push({ firebaseUid: id }, { username: id }, { phoneNumber: id });

    const user = await User.findOne({ $or: or })
      .select("_id firebaseUid isPrivate followers privacySettings attendancesVisibility")
      .lean();
    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

    // Privacy gate: si el perfil es privado, solo el dueño puede ver asistencias.
    const viewerMongoId = req.user && req.user.id ? String(req.user.id) : "";
    const viewerUid = req.firebaseUser && req.firebaseUser.uid ? String(req.firebaseUser.uid) : "";
    const targetMongoId = String(user._id);
    const targetUid = user.firebaseUid ? String(user.firebaseUid) : "";
    const isOwner = (viewerMongoId && viewerMongoId === targetMongoId) || (viewerUid && targetUid && viewerUid === targetUid);

    const attendancesVisibility = visibilityFor(user, "attendancesVisibility", user.isPrivate ? "followers" : "public");
    const canSeeAttendances = canViewByVisibility({
      visibility: attendancesVisibility,
      isOwner,
      viewerId: viewerMongoId,
      targetUser: user,
    });

    if (!canSeeAttendances) {
      return res.status(403).json({ message: "Asistencias privadas" });
    }

    const events = await Event.find({ attendees: user._id })
      .select("title date image createdBy")
      .sort({ date: -1 })
      .lean();

    const out = events.map((e) => ({
      id: e._id.toString(),
      title: e.title,
      date: e.date,
      imageUrl: absUrlFromUpload(req, e.image),
    }));

    return res.json(out);
  } catch (err) {
    console.error("[GET /users/:id/attending]", err);
    return res.status(500).json({ message: "Error obteniendo eventos asistidos" });
  }
});

// GET /api/users/:id  -> admite _id Mongo, firebaseUid, username o phoneNumber
router.get("/:id", optionalAnyAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const or = [];
    if (/^[a-fA-F0-9]{24}$/.test(id)) or.push({ _id: id });
    or.push({ firebaseUid: id }, { username: id }, { phoneNumber: id });

    const user = await User.findOne({ $or: or })
      // Incluimos posibles campos sociales si existen (arrays o counters)
      .select(
        "username displayName profilePicture followers following followersCount followingCount firebaseUid phoneNumber isPrivate privacySettings attendancesVisibility momentsVisibility locationVisibility"
      )
      .lean();

    if (!user) return res.status(404).json({ message: "Usuario no encontrado" });

    const viewerMongoId = req.user && req.user.id ? String(req.user.id) : "";
    const viewerUid = req.firebaseUser && req.firebaseUser.uid ? String(req.firebaseUser.uid) : "";
    const targetMongoId = String(user._id);
    const targetUid = user.firebaseUid ? String(user.firebaseUid) : "";
    const isOwner = (viewerMongoId && viewerMongoId === targetMongoId) || (viewerUid && targetUid && viewerUid === targetUid);

    // Followers/Following: soporta dos esquemas comunes
    // - arrays: user.followers / user.following
    // - counters: user.followersCount / user.followingCount
    const followersCount = Array.isArray(user.followers)
      ? user.followers.length
      : Number(user.followersCount || 0);

    const followingCount = Array.isArray(user.following)
      ? user.following.length
      : Number(user.followingCount || 0);

    const attendancesVisibility = visibilityFor(user, "attendancesVisibility", user.isPrivate ? "followers" : "public");
    const momentsVisibility = visibilityFor(user, "momentsVisibility", user.isPrivate ? "followers" : "public");
    const locationVisibility = visibilityFor(user, "locationVisibility", "private");
    const canSeeAttendances = canViewByVisibility({
      visibility: attendancesVisibility,
      isOwner,
      viewerId: viewerMongoId,
      targetUser: user,
    });

    // Attendances: contamos eventos donde el usuario aparece en `attendees`
    let attendancesCount = 0;
    try {
      // Si el perfil es privado, ocultamos el contador a terceros (solo dueño).
      if (canSeeAttendances) {
        attendancesCount = await Event.countDocuments({ attendees: user._id });
      } else {
        attendancesCount = 0;
      }
    } catch (_) {
      attendancesCount = 0;
    }

    return res.json({
      id: String(user._id || id),
      username: user.username || "",
      displayName: user.displayName || "",
      profilePicture: user.profilePicture || null,
      avatarUrl: absUrlFromUpload(req, user.profilePicture),
      followersCount,
      followingCount,
      attendancesCount,
      isPrivate: !!user.isPrivate,
      privacySettings: {
        attendancesVisibility,
        momentsVisibility,
        locationVisibility,
      },
      canSeeAttendances,
      canSeeMoments: canViewByVisibility({
        visibility: momentsVisibility,
        isOwner,
        viewerId: viewerMongoId,
        targetUser: user,
      }),
      canSeeLocation: canViewByVisibility({
        visibility: locationVisibility,
        isOwner,
        viewerId: viewerMongoId,
        targetUser: user,
      }),
    });
  } catch (err) {
    console.error("[GET /users/:id]", err);
    return res.status(500).json({ message: "Error interno" });
  }
});

// GET /api/users?ids=a,b,c  -> batch por querystring
router.get("/", async (req, res) => {
  try {
    const idsRaw = (req.query.ids || "").toString();
    if (!idsRaw) return res.json([]);

    const ids = idsRaw.split(",").map((s) => s.trim()).filter(Boolean);
    const byObjectId = ids.filter((s) => /^[a-fA-F0-9]{24}$/.test(s));

    const users = await User.find({
      $or: [
        { _id: { $in: byObjectId } },
        { firebaseUid: { $in: ids } },
        { username: { $in: ids } },
        { phoneNumber: { $in: ids } },
      ],
    })
      .select("username displayName profilePicture")
      .lean();

    const out = users.map((u) => ({
      id: String(u._id),
      username: u.username || "",
      displayName: u.displayName || "",
      profilePicture: u.profilePicture || null,
      avatarUrl: absUrlFromUpload(req, u.profilePicture),
    }));
    res.json(out);
  } catch (err) {
    console.error("[GET /users?ids]", err);
    res.status(500).json({ message: "Error interno" });
  }
});

// POST /api/users/batch  -> { ids: [...] }
router.post("/batch", async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    if (!ids.length) return res.json([]);

    const byObjectId = ids.filter((s) => /^[a-fA-F0-9]{24}$/.test(s));

    const users = await User.find({
      $or: [
        { _id: { $in: byObjectId } },
        { firebaseUid: { $in: ids } },
        { username: { $in: ids } },
        { phoneNumber: { $in: ids } },
      ],
    })
      .select("username displayName profilePicture")
      .lean();

    const out = users.map((u) => ({
      id: String(u._id),
      username: u.username || "",
      displayName: u.displayName || "",
      profilePicture: u.profilePicture || null,
      avatarUrl: absUrlFromUpload(req, u.profilePicture),
    }));
    res.json(out);
  } catch (err) {
    console.error("[POST /users/batch]", err);
    res.status(500).json({ message: "Error interno" });
  }
});

// GET /api/users/:id/avatar  -> redirige a la imagen real
router.get("/:id/avatar", async (req, res) => {
  try {
    const id = req.params.id;
    const or = [];
    if (/^[a-fA-F0-9]{24}$/.test(id)) or.push({ _id: id });
    or.push({ firebaseUid: id }, { username: id }, { phoneNumber: id });

    const user = await User.findOne({ $or: or })
      .select("profilePicture")
      .lean();

    if (!user || !user.profilePicture) return res.status(404).end();

    const url = absUrlFromUpload(req, user.profilePicture);
    if (!url) return res.status(404).end();
    return res.redirect(url);
  } catch (err) {
    console.error("[GET /users/:id/avatar]", err);
    res.status(500).end();
  }
});

module.exports = router;
