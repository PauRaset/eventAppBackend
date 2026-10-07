// routes/eventRoutes.js
const express = require("express");
const multer = require("multer");
const path = require("path");
const sharp = require("sharp");
const fs = require("fs");
const mongoose = require("mongoose");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");

const router = express.Router();

const Event = require("../models/Event");
const Order = require("../models/Order"); // entradas: compra pagada = Order.status 'paid'
const Ticket = require("../models/Ticket");
const Club = require("../models/Club");
const QrScan = require("../models/QrScan");
const { makeToken } = require("../utils/ticketToken");
const User = require("../models/User");
const Notification = require("../models/Notification");
const { sendPushNotificationToUser } = require("../utils/sendPushNotification");
const { geocodeAddress, applyGeo, buildAddress } = require("../utils/geocode");
const { sanitizeTiers, validateTierChanges, syncEventPrice } = require("../utils/tiers");

/** ticketTiers puede llegar como array (JSON) o como string (FormData). */
function parseTiersInput(raw) {
  if (raw === undefined || raw === null || raw === "") return { value: undefined };
  if (Array.isArray(raw)) return { value: raw };
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? { value: parsed }
        : { error: "ticketTiers debe ser una lista" };
    } catch (_) {
      return { error: "ticketTiers no es un JSON válido" };
    }
  }
  return { error: "ticketTiers debe ser una lista" };
}
const PromotionLevelTemplate = require("../models/PromotionLevelTemplate");
const UserClubPromotionProgress = require("../models/UserClubPromotionProgress");

// Tu middleware JWT actual (export default)
const authenticateToken = require("../middlewares/authMiddleware");

// Inicializa firebase-admin (y permite usar admin directamente)
require("../middlewares/firebaseAdmin");
const admin = require("firebase-admin");

/* -------------------------------------------------------------
   Helpers
------------------------------------------------------------- */
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

function backendBase(req) {
  return process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`;
}

/**
 * Devuelve URL absoluta para cualquier path/URL de /uploads.
 * - Si ya es http(s) y contiene /uploads/, lo re-mapea al dominio actual.
 * - Si ya es http(s) y no es de /uploads, lo deja tal cual.
 * - Si es relativo (p.ej. "uploads/..." o "/uploads/..."), lo normaliza.
 */
function absUrlFromUpload(req, p) {
  if (!p) return null;
  const base = backendBase(req);
  if (typeof p !== "string") p = String(p);

  if (p.startsWith("http")) {
    const idx = p.indexOf("/uploads/");
    if (idx !== -1) return `${base}${p.substring(idx)}`;
    return p; // URL externa ajena a /uploads
  }
  const clean = p.startsWith("/") ? p : `/${p}`;
  return `${base}${clean}`;
}

function joinUrl(base, rel) {
  if (!base) return rel || null;
  if (!rel) return null;
  const b = base.replace(/\/+$/, "");
  const r = rel.replace(/^\/+/, "");
  return `${b}/${r}`;
}

function buildEventPhotoAccessUrl(req, eventId, photoId) {
  return joinUrl(backendBase(req), `/api/events/${eventId}/photos/${photoId}/file`);
}

function summarizePhotoReactions(reactions = []) {
  const summary = {
    hype: 0,
    love: 0,
    party: 0,
    energy: 0,
  };

  for (const r of reactions || []) {
    const key = (r?.type || "").toString();
    if (summary[key] !== undefined) {
      summary[key] += 1;
    }
  }

  return {
    counts: summary,
    total: Object.values(summary).reduce((a, b) => a + b, 0),
  };
}

function shapePhotoSignatures(req, signatures = [], viewerUserId = null, cap = 60) {
  const list = Array.isArray(signatures) ? signatures : [];
  const shaped = list.slice(0, cap).map((s) => ({
    userId: String(s?.userId || ""),
    username: s?.username || null,
    avatarUrl: absUrlFromUpload(req, s?.profilePicture || null),
    x: typeof s?.x === "number" ? s.x : 0,
    y: typeof s?.y === "number" ? s.y : 0,
  }));
  const mine = list.find(
    (s) => String(s?.userId || "") === String(viewerUserId)
  );
  return {
    signatures: shaped,
    signatureCount: list.length,
    mySignature: mine ? { x: mine.x, y: mine.y } : null,
  };
}

// --- Notification helpers for photo reactions ---
function reactionLabel(type) {
  switch (type) {
    case "hype":
      return "hype";
    case "love":
      return "corazón";
    case "party":
      return "fiesta";
    case "energy":
      return "energía";
    default:
      return "reacción";
  }
}

async function createPhotoReactionNotification({ req, event, photo, reactionType, userReaction }) {
  try {
    if (!userReaction) return;

    const actorId = req.user?.id;
    const ownerId = photo?.by ? String(photo.by) : "";

    if (!actorId || !ownerId) return;

    // No notificar si reaccionas a tu propia foto.
    if (String(actorId) === String(ownerId)) return;

    const actor = await User.findById(actorId).select("username displayName profilePicture").lean();
    const actorName =
      actor?.username ||
      actor?.displayName ||
      "Alguien";

    const eventTitle = event?.title || "un evento";
    const photoId = photo?.photoId || rawPhotoValue(photo) || "";
    const previewImage = absUrlFromUpload(req, rawPhotoValue(photo));

    const notification = await Notification.findOneAndUpdate(
      {
        user: ownerId,
        actor: actorId,
        event: event._id,
        photoId,
        type: "photo_reaction",
      },
      {
        $set: {
          reactionType,
          title: "Nueva reacción en tu foto",
          body: `${actorName} reaccionó a tu foto en ${eventTitle}.`,
          routeTarget: `event:${event._id}/photos`,
          previewImage,
          read: false,
          readAt: null,
          pushSent: false,
          meta: {
            reactionLabel: reactionLabel(reactionType),
            eventTitle,
          },
        },
        $setOnInsert: {
          user: ownerId,
          actor: actorId,
          event: event._id,
          photoId,
          type: "photo_reaction",
        },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );

    if (notification?._id) {
      await sendPushNotificationToUser(ownerId, notification);
    }
  } catch (e) {
    console.warn("[notifications] createPhotoReactionNotification failed:", e?.message || e);
  }
}

// --- Notification helpers for new approved event photo ---
async function createNewEventPhotoNotifications({ req, event, photo }) {
  try {
    if (!event || !photo) return;

    const eventId = event._id;
    const eventTitle = event.title || "un evento";
    const photoId = photo?.photoId || rawPhotoValue(photo) || "";
    const previewImage = absUrlFromUpload(req, rawPhotoValue(photo));
    const uploaderId = photo?.by ? String(photo.by) : null;
    const ownerId = event.createdBy ? String(event.createdBy) : null;

    const attendeeIds = Array.isArray(event.attendees)
      ? event.attendees.map((id) => String(id)).filter(Boolean)
      : [];

    const recipients = Array.from(new Set(attendeeIds)).filter((userId) => {
      if (!userId) return false;
      if (uploaderId && String(userId) === String(uploaderId)) return false;
      if (ownerId && String(userId) === String(ownerId)) return false;
      return true;
    });

    if (!recipients.length) return;

    for (const userId of recipients) {
      const notification = await Notification.findOneAndUpdate(
        {
          user: userId,
          event: eventId,
          photoId,
          type: "new_event_photo",
        },
        {
          $set: {
            title: "Nuevas fotos disponibles",
            body: `Se añadieron nuevas fotos a ${eventTitle}.`,
            routeTarget: `event:${eventId}/photos`,
            previewImage,
            read: false,
            readAt: null,
            pushSent: false,
            meta: {
              eventTitle,
              photoId,
            },
          },
          $setOnInsert: {
            user: userId,
            event: eventId,
            photoId,
            type: "new_event_photo",
          },
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        }
      );

      if (notification?._id) {
        await sendPushNotificationToUser(userId, notification);
      }
    }
  } catch (e) {
    console.warn("[notifications] createNewEventPhotoNotifications failed:", e?.message || e);
  }
}

function rawPhotoValue(entry) {
  if (!entry) return "";
  if (typeof entry === "string") return entry;
  return entry.url || entry.path || entry.href || entry.secure_url || entry.photo || entry.image || "";
}

function parseLevelNumberMaybe(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function extractPhotoMissionMeta(body = {}) {
  return {
    missionType: (body.missionType || body.photoMissionType || body.targetMissionType || "").toString().trim() || null,
    missionId: (body.missionId || body.photoMissionId || body.targetMissionId || "").toString().trim() || null,
    missionTitle: (body.missionTitle || body.photoMissionTitle || body.targetMissionTitle || "").toString().trim() || null,
    missionDescription:
      (body.missionDescription ||
        body.photoMissionDescription ||
        body.targetMissionDescription ||
        "").toString().trim() || null,
    missionCurrent: parseLevelNumberMaybe(
      body.missionCurrent || body.photoMissionCurrent || body.targetMissionCurrent
    ),
    missionTarget: parseLevelNumberMaybe(
      body.missionTarget || body.photoMissionTarget || body.targetMissionTarget
    ),
    levelNumber: parseLevelNumberMaybe(body.levelNumber || body.photoLevelNumber || body.targetLevelNumber),
  };
}

function extractPhotoValidationMeta(body = {}) {
  return {
    validatedForMissionType: (body.validatedForMissionType || body.missionType || "").toString().trim() || null,
    validatedForMissionId: (body.validatedForMissionId || body.missionId || "").toString().trim() || null,
    validatedForMissionTitle: (body.validatedForMissionTitle || body.missionTitle || "").toString().trim() || null,
    validatedForLevelNumber: parseLevelNumberMaybe(
      body.validatedForLevelNumber || body.levelNumber
    ),
    validationResult: (body.validationResult || "").toString().trim() || null,
  };
}

function parseQrPayloadValue(value) {
  const raw = (value || "").toString().trim();
  if (!raw) return null;

  if (raw.startsWith("NV_EVENT:")) {
    const parts = raw.split(":");
    return {
      eventId: (parts[1] || "").trim() || null,
      qrToken: (parts[2] || "").trim() || null,
    };
  }

  return {
    eventId: null,
    qrToken: raw,
  };
}

function buildQrResolveResponse(req, event, activePhotoMission = null) {
  const eventId = String(event._id);
  return {
    ok: true,
    eventId,
    qrToken: event.qrToken || null,
    tokenUploadUrl: joinUrl(backendBase(req), `/api/events/scan/${event.qrToken}/photo`),
    uploadUrl: joinUrl(backendBase(req), `/api/events/scan/${event.qrToken}/photo`),
    photoUploadUrl: joinUrl(backendBase(req), `/api/events/scan/${event.qrToken}/photo`),
    mission: activePhotoMission
      ? {
          missionKey: activePhotoMission.missionKey || null,
          missionId: activePhotoMission.missionId || activePhotoMission.missionKey || null,
          type: activePhotoMission.type || null,
          title: activePhotoMission.title || "",
          target: activePhotoMission.target ?? 1,
          current: activePhotoMission.current ?? 0,
          levelNumber: activePhotoMission.levelNumber ?? null,
          status: activePhotoMission.status || null,
          requiresApproval: !!activePhotoMission.requiresApproval,
        }
      : null,
    missionType: activePhotoMission?.type || null,
    missionId: activePhotoMission?.missionId || activePhotoMission?.missionKey || null,
    missionTitle: activePhotoMission?.title || "",
    missionTarget: activePhotoMission?.target ?? 1,
    missionCurrent: activePhotoMission?.current ?? 0,
    levelNumber: activePhotoMission?.levelNumber ?? null,
    event: {
      _id: eventId,
      id: eventId,
      title: event.title || "Evento",
      imageUrl: absUrlFromUpload(req, event.image),
      startAt: event.startAt || event.date || null,
      date: event.date || event.startAt || null,
      city: event.city || "",
      street: event.street || "",
      postalCode: event.postalCode || "",
      categories: Array.isArray(event.categories)
        ? event.categories
        : parseCategoriesMaybe(event.categories),
    },
    flow: {
      type: "event_qr_camera_upload",
      cameraOnly: true,
      allowGallery: false,
      allowRetake: true,
    },
    upload: {
      method: "POST",
      url: joinUrl(backendBase(req), `/api/events/${eventId}/photos`),
      tokenUploadUrl: joinUrl(backendBase(req), `/api/events/scan/${event.qrToken}/photo`),
      uploadUrl: joinUrl(backendBase(req), `/api/events/scan/${event.qrToken}/photo`),
      photoUploadUrl: joinUrl(backendBase(req), `/api/events/scan/${event.qrToken}/photo`),
      fieldNames: ["file", "files", "photo", "image"],
    },
  };
}

/* Utils de ficheros */
const ROOT_UPLOADS_DIR = path.join(__dirname, "..", "uploads");
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/* -------------------------------------------------------------
   Normalizadores de payload
------------------------------------------------------------- */
function parseDateMaybe(v) {
  if (!v) return undefined;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
}

function parseNumberMaybe(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

function parseCategoriesMaybe(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    // Soporta JSON string o "a,b,c"
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch (_) {
      return value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(String);
    }
  }
  return [];
}

/* ------------------------------------------------------------------
   AUTH BRIDGE
------------------------------------------------------------------- */

// decide en tiempo real si verificar Firebase o JWT
async function anyAuth(req, res, next) {
  const token = extractIdToken(req);
  if (!token) {
    // no hubo token Firebase -> probamos tu JWT clásico
    return authenticateToken(req, res, next);
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.firebaseUser = {
      uid: decoded.uid,
      phone: decoded.phone_number || decoded.phoneNumber || null,
      // Email solo fiable si Firebase lo marca como verificado (lo usa /my-tickets/full)
      email: decoded.email || null,
      emailVerified: decoded.email_verified === true,
    };
    return next();
  } catch (_) {
    // No era (o no válido) como Firebase -> usar tu JWT clásico
    return authenticateToken(req, res, next);
  }
}

// a partir de lo que haya puesto anyAuth, garantizamos req.user.id
async function ensureUserId(req, res, next) {
  if (req.user && req.user.id) return next(); // ya viene de tu JWT

  if (req.firebaseUser && req.firebaseUser.uid) {
    try {
      const user = await User.findOrCreateFromFirebase({
        uid: req.firebaseUser.uid,
        phoneNumber: req.firebaseUser.phone,
      });

      req.user = { id: user._id.toString() };
      return next();
    } catch (err) {
      console.error("[ensureUserId] fallo resolviendo usuario desde Firebase:", err);
      return res.status(401).json({ message: "No autorizado" });
    }
  }

  // No hubo ni JWT ni Firebase
  return res.status(401).json({ message: "Usuario no autenticado" });
}

async function optionalUserId(req, res, next) {
  try {
    if (req.user && req.user.id) return next();

    const token = extractIdToken(req);
    if (!token) return next();

    try {
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
    } catch (_) {}

    return next();
  } catch (e) {
    console.warn("[optionalUserId] error:", e?.message || e);
    return next();
  }
}

/* ------------------------------------------------------------------
   PROMOTIONS BRIDGE (auto-progress levels)
------------------------------------------------------------------- */

async function getGlobalPromotionTemplates() {
  const templates = await PromotionLevelTemplate.find({ scope: "global", active: true })
    .sort({ levelNumber: 1 })
    .lean();
  return templates || [];
}

function computeLevelProgress(level) {
  const missions = Array.isArray(level?.missions) ? level.missions : [];
  if (!missions.length) return 0;
  const ratios = missions.map((m) => {
    const target = Number(m.target || 1);
    const cur = Number(m.current || 0);
    if (!target || target <= 0) return 0;
    return Math.max(0, Math.min(1, cur / target));
  });
  return Math.max(0, Math.min(1, ratios.reduce((a, b) => a + b, 0) / ratios.length));
}

function allMissionsCompleted(level) {
  const missions = Array.isArray(level?.missions) ? level.missions : [];
  if (!missions.length) return false;
  return missions.every((m) => m.status === "completed");
}

function unlockNextLevel(progress, completedLevelNumber) {
  const nextLevelNumber = Number(completedLevelNumber) + 1;
  const next = (progress.levels || []).find((l) => Number(l.levelNumber) === nextLevelNumber);
  if (!next) return;

  if (next.status === "locked") {
    next.status = "in_progress";
    for (const m of next.missions || []) {
      if (m.status === "locked") m.status = "in_progress";
      if (!m.startedAt) m.startedAt = new Date();
      m.updatedAt = new Date();
    }
  }

  progress.currentLevel = nextLevelNumber;
  progress.currentRewardTitle = next.reward?.title || "";
}

function refreshCurrentSnapshot(progress) {
  const cur = (progress.levels || []).find((l) => Number(l.levelNumber) === Number(progress.currentLevel));
  if (!cur) {
    progress.currentProgress = 0;
    return;
  }
  cur.progress = computeLevelProgress(cur);
  progress.currentProgress = cur.progress;
  progress.currentRewardTitle = cur.reward?.title || "";
}

function clampNonNegative(n) {
  const x = Number(n || 0);
  return x < 0 ? 0 : x;
}

function updateAttendMissionsForLevel(level, counters) {
  for (const m of level.missions || []) {
    if (m.type !== "attend_event") continue;

    const platformWide = !!(m.params && m.params.platformWide) || !!(m.meta && m.meta.platformWide);
    const count = platformWide ? Number(counters.attendancesPlatform || 0) : Number(counters.attendancesInClub || 0);

    m.current = Math.min(count, Number(m.target || 1));

    if (level.status === "locked") continue;

    if (m.current >= Number(m.target || 1)) {
      m.status = "completed";
      m.completedAt = m.completedAt || new Date();
    } else {
      if (m.status !== "pending") m.status = "in_progress";
      m.completedAt = null;
    }

    m.updatedAt = new Date();
  }
}

/**
 * Aplica UNA foto aprobada a UNA misión concreta, identificada por su missionKey.
 * ⚠️ Sin missionKey no se toca nada: una foto sin misión es una foto del muro.
 * (Antes, sin datos de misión, contaba para TODAS las misiones de foto de todos
 * los niveles, y también se emparejaba por tipo o título.)
 */
function updatePhotoMissionsForLevel(level, eventId, missionKey) {
  if (!missionKey) return false;
  let matched = false;

  for (const m of level.missions || []) {
    if (String(m.missionKey || "") !== String(missionKey)) continue;
    if (!isPhotoMissionType(m.type, m)) continue;
    matched = true;

    const perEvent = !!(m.params && m.params.perEvent) || !!(m.meta && m.meta.perEvent);

    if (perEvent) {
      const list = Array.isArray(m.meta?.eventIds) ? m.meta.eventIds : [];
      const set = new Set(list.map(String));
      if (eventId) set.add(String(eventId));
      const updated = Array.from(set);
      m.meta = { ...(m.meta || {}), eventIds: updated, perEvent: true };
      m.current = Math.min(updated.length, Number(m.target || 1));
    } else {
      // Cada foto aprobada PARA ESTA misión suma 1 (antes usaba el contador global
      // del club, que mezclaba fotos de cualquier misión y del muro).
      m.current = Math.min(Number(m.current || 0) + 1, Number(m.target || 1));
    }

    if (level.status === "locked") continue;

    if (m.current >= Number(m.target || 1)) {
      m.status = "completed";
      m.completedAt = m.completedAt || new Date();
    } else {
      if (m.status !== "pending") m.status = "in_progress";
      m.completedAt = null;
    }

    m.updatedAt = new Date();
  }

  return matched;
}


async function ensurePromotionProgressDoc({ userId, clubId }) {
  let progress = await UserClubPromotionProgress.findOne({ user: userId, club: clubId });
  if (progress) return progress;

  const templates = await getGlobalPromotionTemplates();
  if (!templates.length) return null;

  const built = UserClubPromotionProgress.buildFromTemplates({ templates, startLevel: 1 });
  progress = await UserClubPromotionProgress.create({
    user: userId,
    club: clubId,
    ...built,
  });

  return progress;
}

function isPhotoMissionType(type, mission = null) {
  const normalized = (type || "").toString().trim().toLowerCase();

  const exactTypes = new Set([
    "upload_event_photo",
    "event_photo",
    "upload_photo",
    "photo_upload",
    "upload-photo",
    "event-photo",
    "group_photo",
    "photo_group",
    "group-event-photo",
    "selfie_photo",
    "photo_selfie",
  ]);

  if (exactTypes.has(normalized)) return true;

  if (
    normalized.includes("photo") ||
    normalized.includes("foto") ||
    normalized.includes("selfie")
  ) {
    return true;
  }

  const title = (mission?.title || "").toString().trim().toLowerCase();
  if (
    title.includes("foto") ||
    title.includes("photo") ||
    title.includes("selfie")
  ) {
    return true;
  }

  return false;
}

function isActivePhotoMissionStatus(status) {
  const normalized = (status || "").toString().trim().toLowerCase();
  return ["in_progress", "pending", "rejected"].includes(normalized);
}

async function resolveActivePhotoMissionForUser({ userId, event }) {
  if (!userId || !event) return null;

  const clubId =
    event.createdBy ||
    event.clubId ||
    event.club ||
    null;

  if (!clubId) return null;

  const progress = await UserClubPromotionProgress.findOne({
    user: userId,
    club: clubId,
  }).lean();

  if (!progress) return null;

  const currentLevelNumber = Number(progress.currentLevel || 1);
  const levels = Array.isArray(progress.levels) ? progress.levels : [];
  const currentLevel = levels.find(
    (level) => Number(level?.levelNumber) === currentLevelNumber
  );

  if (!currentLevel) return null;

  const missions = Array.isArray(currentLevel.missions) ? currentLevel.missions : [];
  const mission = missions.find((m) => {
    if (!m) return false;
    return isPhotoMissionType(m.type, m) && isActivePhotoMissionStatus(m.status);
  });

  if (!mission) return null;

  return {
    missionKey: mission.missionKey || null,
    missionId: mission.missionKey || null,
    type: mission.type || null,
    title: mission.title || "",
    target: Number(mission.target || 1),
    current: Number(mission.current || 0),
    levelNumber: currentLevel.levelNumber ?? currentLevelNumber,
    status: mission.status || null,
    requiresApproval: mission.requiresApproval !== false,
  };
}

/**
 * Clave de "club" con la que se guarda el progreso de promociones de un evento.
 * Mismo criterio que resolveActivePhotoMissionForUser (createdBy primero), para
 * que validar, escanear y aprobar miren el MISMO documento de progreso.
 */
function promotionClubKeyForEvent(event) {
  const raw = event?.createdBy || event?.clubId || event?.club || null;
  if (!raw) return null;
  return String(raw._id || raw);
}

/**
 * EL SERVIDOR DECIDE LA MISIÓN: valida el missionKey que manda la app contra el
 * progreso real del usuario en el club del evento. Debe existir, ser del nivel
 * actual, ser de foto y no estar completada. Devuelve los datos de la misión
 * sacados del PROGRESO (no del cuerpo de la petición), o null si no es válida.
 */
async function resolvePhotoMissionForUpload({ userId, event, missionKey }) {
  const clubId = promotionClubKeyForEvent(event);
  if (!userId || !clubId || !missionKey) return null;

  const progress = await UserClubPromotionProgress.findOne({ user: userId, club: clubId }).lean();
  if (!progress) return null;

  const currentLevelNumber = Number(progress.currentLevel || 1);
  const level = (progress.levels || []).find((l) => Number(l?.levelNumber) === currentLevelNumber);
  if (!level || level.status === "locked") return null;

  const mission = (level.missions || []).find((m) => m && String(m.missionKey || "") === String(missionKey));
  if (!mission) return null;
  if (!isPhotoMissionType(mission.type, mission)) return null;
  if (String(mission.status || "") === "completed") return null;

  return {
    missionType: mission.type || null,
    missionId: mission.missionKey,
    missionTitle: mission.title || null,
    missionTarget: Number(mission.target || 1),
    missionCurrent: Number(mission.current || 0),
    levelNumber: Number(level.levelNumber),
  };
}

// Una foto de misión exige haber escaneado el QR del evento en este margen.
const QR_SCAN_WINDOW_MS = 4 * 60 * 60 * 1000;

async function hasRecentQrScan(userId, eventId) {
  if (!mongoose.isValidObjectId(String(userId || "")) || !mongoose.isValidObjectId(String(eventId || ""))) {
    return false;
  }
  const since = new Date(Date.now() - QR_SCAN_WINDOW_MS);
  const scan = await QrScan.findOne({ user: userId, event: eventId, scannedAt: { $gte: since } })
    .select("_id")
    .lean();
  return !!scan;
}

/** Registra un escaneo (prueba de presencia). Devuelve { firstScan } (primer escaneo de ese evento). */
async function recordQrScan(req, event) {
  const userId = req.user?.id;
  if (!mongoose.isValidObjectId(String(userId || ""))) return { firstScan: false };

  const previous = await QrScan.findOne({ user: userId, event: event._id }).select("_id").lean();
  await QrScan.create({
    user: userId,
    event: event._id,
    scannedAt: new Date(),
    ip: (req.ip || "").toString(),
    userAgent: (req.headers["user-agent"] || "").toString().slice(0, 300),
  });
  return { firstScan: !previous };
}

/**
 * Un escaneo (de un evento nuevo) suma 1 a las misiones scan_qr de los niveles
 * YA desbloqueados. Los niveles bloqueados no acumulan: el reto "encuentra el
 * QR" de un nivel se cumple estando en ese nivel, no con escaneos anteriores.
 */
function updateScanQrMissionsForLevel(level) {
  if (level.status === "locked") return;

  for (const m of level.missions || []) {
    if (m.type !== "scan_qr") continue;
    if (m.status === "completed") continue;

    m.current = Math.min(Number(m.current || 0) + 1, Number(m.target || 1));

    if (m.current >= Number(m.target || 1)) {
      m.status = "completed";
      m.completedAt = m.completedAt || new Date();
    } else if (m.status !== "pending") {
      m.status = "in_progress";
    }
    m.updatedAt = new Date();
  }
}

/**
 * Misiones scan_qr: cuenta EVENTOS distintos escaneados en el club (solo se llama
 * en el primer escaneo de cada evento), para que reescanear el mismo QR no infle
 * el contador. Mismo patrón que syncPromotionAfterAttend.
 */
async function syncPromotionAfterQrScan({ userId, clubId, eventId }) {
  try {
    const progress = await ensurePromotionProgressDoc({ userId, clubId });
    if (!progress) return;

    progress.counters = progress.counters || {};
    progress.counters.qrScansInClub = clampNonNegative((progress.counters.qrScansInClub || 0) + 1);

    for (const lvl of progress.levels || []) {
      updateScanQrMissionsForLevel(lvl);
      lvl.progress = computeLevelProgress(lvl);
    }

    let guard = 0;
    while (guard++ < 15) {
      const cur = (progress.levels || []).find((l) => Number(l.levelNumber) === Number(progress.currentLevel));
      if (!cur) break;

      cur.progress = computeLevelProgress(cur);
      if (cur.status !== "completed" && allMissionsCompleted(cur)) {
        cur.status = "completed";
        cur.completedAt = new Date();
        unlockNextLevel(progress, cur.levelNumber);
        continue;
      }
      break;
    }

    refreshCurrentSnapshot(progress);
    progress.lastEventId = eventId || progress.lastEventId;
    progress.lastActivityAt = new Date();
    await progress.save();
  } catch (e) {
    console.warn("[promotions] syncPromotionAfterQrScan failed:", e?.message || e);
  }
}

/**
 * ¿Puede este usuario gestionar el evento? Dueño (createdBy) o dueño/manager
 * del Club vinculado. Solo por ids (_id de Mongo / uid de Firebase), NUNCA por
 * email: User.email se puede cambiar sin verificar.
 */
async function canManageEvent(req, event) {
  const ids = new Set([req.user?.id, req.firebaseUser?.uid].filter(Boolean).map(String));
  if (!ids.size) return false;

  const createdBy = event?.createdBy ? String(event.createdBy._id || event.createdBy) : "";
  if (createdBy && ids.has(createdBy)) return true;

  const clubRef = event?.club || (/^[a-fA-F0-9]{24}$/.test(String(event?.clubId || "")) ? event.clubId : null);
  if (!clubRef) return false;

  const club = await Club.findById(clubRef).select("ownerUserId managers").lean();
  if (!club) return false;

  if (mongoose.isValidObjectId(String(req.user?.id || ""))) {
    const me = await User.findById(req.user.id).select("firebaseUid").lean();
    if (me?.firebaseUid) ids.add(String(me.firebaseUid));
  }
  return [club.ownerUserId, ...(club.managers || [])].filter(Boolean).some((p) => ids.has(String(p)));
}

async function syncPromotionAfterAttend({ userId, clubId, eventId, attendedNow }) {
  try {
    const progress = await ensurePromotionProgressDoc({ userId, clubId });
    if (!progress) return;

    progress.counters = progress.counters || {};
    const delta = attendedNow ? 1 : -1;

    progress.counters.attendancesInClub = clampNonNegative((progress.counters.attendancesInClub || 0) + delta);
    progress.counters.attendancesPlatform = clampNonNegative((progress.counters.attendancesPlatform || 0) + delta);

    for (const lvl of progress.levels || []) {
      updateAttendMissionsForLevel(lvl, progress.counters);
      lvl.progress = computeLevelProgress(lvl);
    }

    let guard = 0;
    while (guard++ < 15) {
      const cur = (progress.levels || []).find((l) => Number(l.levelNumber) === Number(progress.currentLevel));
      if (!cur) break;

      cur.progress = computeLevelProgress(cur);
      if (cur.status !== "completed" && allMissionsCompleted(cur)) {
        cur.status = "completed";
        cur.completedAt = new Date();
        unlockNextLevel(progress, cur.levelNumber);
        continue;
      }
      break;
    }

    refreshCurrentSnapshot(progress);
    progress.lastEventId = eventId || progress.lastEventId;
    progress.lastActivityAt = new Date();
    await progress.save();
  } catch (e) {
    console.warn("[promotions] syncPromotionAfterAttend failed:", e?.message || e);
  }
}

/**
 * Una foto APROBADA avanza SOLO la misión cuyo missionKey lleva. Sin missionKey
 * no hace nada (foto del muro). Sin emparejar por tipo/título ni "la primera
 * misión de foto activa": eso permitía que una foto contara para misiones que
 * el usuario no eligió.
 */
async function syncPromotionAfterPhotoApproved({
  userId,
  clubId,
  eventId,
  missionType = null,
  missionKey = null,
  missionTitle = null,
  levelNumber = null,
}) {
  try {
    if (!missionKey) return;

    const progress = await ensurePromotionProgressDoc({ userId, clubId });
    if (!progress) return;

    progress.counters = progress.counters || {};
    progress.counters.photosUploadedInClub = clampNonNegative((progress.counters.photosUploadedInClub || 0) + 1);

    const levels = progress.levels || [];
    const numericLevelNumber = levelNumber == null ? null : Number(levelNumber);

    let matchedMission = false;

    for (const lvl of levels) {
      const sameLevel = numericLevelNumber == null || Number(lvl.levelNumber) === numericLevelNumber;
      if (sameLevel && updatePhotoMissionsForLevel(lvl, eventId, missionKey)) {
        matchedMission = true;
      }
      lvl.progress = computeLevelProgress(lvl);
    }

    if (!matchedMission) {
      console.warn("[promotions] syncPromotionAfterPhotoApproved: no mission matched", {
        userId: String(userId || ""),
        clubId: String(clubId || ""),
        eventId: String(eventId || ""),
        missionType,
        missionKey,
        missionTitle,
        levelNumber,
      });
    }

    let guard = 0;
    while (guard++ < 15) {
      const cur = (progress.levels || []).find((l) => Number(l.levelNumber) === Number(progress.currentLevel));
      if (!cur) break;

      cur.progress = computeLevelProgress(cur);
      if (cur.status !== "completed" && allMissionsCompleted(cur)) {
        cur.status = "completed";
        cur.completedAt = new Date();
        unlockNextLevel(progress, cur.levelNumber);
        continue;
      }
      break;
    }

    refreshCurrentSnapshot(progress);
    progress.lastEventId = eventId || progress.lastEventId;
    progress.lastActivityAt = new Date();
    await progress.save();
  } catch (e) {
    console.warn("[promotions] syncPromotionAfterPhotoApproved failed:", e?.message || e);
  }
}

/* ------------------------------------------------------------------
   Configuración de multer
------------------------------------------------------------------- */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureDir(ROOT_UPLOADS_DIR);
    cb(null, ROOT_UPLOADS_DIR);
  },
  filename: (req, file, cb) => cb(null, Date.now() + "_" + file.originalname),
});
const upload = multer({ storage });
// Para aceptar múltiples campos/arrays con nombres distintos:
const uploadAny = multer({ storage });

/** Borra los temporales de multer de una subida que se rechaza antes de procesarla. */
function cleanupUploadedFiles(files) {
  for (const f of files || []) {
    try { if (f?.path) fs.unlinkSync(f.path); } catch {}
  }
}

/* Proceso de imagen (resize → .jpg) */
async function processImageToJpg(srcPath, outDir, baseName) {
  ensureDir(outDir);
  const outPath = path.join(outDir, `${baseName}.jpg`);
  try {
    await sharp(srcPath)
      .rotate()
      .resize(1080, 1920, { fit: "cover" }) // 9:16 vertical (formato del feed)
      .jpeg({ quality: 82 })
      .toFile(outPath);
    return outPath;
  } catch (e) {
    // fallback: copia tal cual si sharp falla (p.ej., formato raro)
    const fallback = path.join(outDir, `${baseName}${path.extname(srcPath) || ""}`);
    fs.copyFileSync(srcPath, fallback);
    return fallback;
  } finally {
    try { fs.unlinkSync(srcPath); } catch {}
  }
}

/* -------------------------------------------------------------
   Helpers de normalización de fotos con metadatos
------------------------------------------------------------- */
function usernameFromUserDoc(u) {
  if (!u) return null;
  return (
    u.username ||
    (u.phoneNumber ? u.phoneNumber.replace("+", "") : null) ||
    null
  );
}

function toPhotoTileAbs(req, entry, viewerUserId = null) {
  // Acepta string o objeto y devuelve objeto { url, byUsername?, uploadedAt? } con URL absoluta
  if (!entry) return null;

  if (typeof entry === "string") {
    return { url: absUrlFromUpload(req, entry) };
  }
  if (typeof entry === "object") {
    const url =
      absUrlFromUpload(req, entry.url || entry.path || entry.href || entry.secure_url || entry.photo || entry.image);
    const byUsername =
      entry.byUsername ||
      (entry.byUser && entry.byUser.username) ||
      (entry.user && entry.user.username) ||
      entry.username ||
      null;

    const reactionSummary = summarizePhotoReactions(entry.reactions || []);
    const sig = shapePhotoSignatures(req, entry.signatures, viewerUserId);

    return {
      url,
      ...(entry.photoId ? { photoId: entry.photoId } : {}),
      ...(entry.by ? { by: entry.by } : {}),
      ...(byUsername ? { byUsername } : {}),
      ...(entry.uploadedAt ? { uploadedAt: entry.uploadedAt } : {}),
      reactions: reactionSummary.counts,
      reactionsTotal: reactionSummary.total,
      myReaction: (entry.reactions || []).find(
        (r) => String(r?.userId || "") === String(viewerUserId)
      )?.type || null,
      ...sig,
    };
  }
  return null;
}

function isApprovedPhotoEntry(p) {
  if (!p) return false;
  if (typeof p === "string") return true; // legacy
  if (typeof p === "object") {
    const st = String(p.status || "approved");
    return st === "approved";
  }
  return false;
}

function approvedOnly(list) {
  return Array.isArray(list) ? list.filter(isApprovedPhotoEntry) : [];
}

/* -------------------------------------------------------------
   Normalizador público de usuario (para asistentes)
------------------------------------------------------------- */
function shapePublicUser(req, u) {
  if (!u) return null;

  // Cuenta privada: NO exponemos identidad (ni nombre, ni foto, ni id real).
  // Enviamos un id OPACO (hash estable, no reversible al perfil) para que el
  // cliente la coloque como "presencia" sin poder abrir su perfil.
  if (u.isPrivate) {
    const anonId =
      "priv_" +
      crypto.createHash("sha1").update(String(u._id)).digest("hex").slice(0, 12);
    return {
      id: anonId,
      private: true,
      username: "",
      displayName: "",
      profilePicture: null,
      avatarUrl: null,
    };
  }

  const username =
    u.username ||
    (u.phoneNumber ? String(u.phoneNumber).replace("+", "") : "") ||
    "";
  const displayName = u.displayName || u.name || "";
  const profilePicture = u.profilePicture || null; // relativo (frontend lo sabe resolver)
  return {
    _id: u._id,
    id: String(u._id || ""),
    private: false,
    username,
    displayName,
    profilePicture,                             // 👈 clave que busca el front
    avatarUrl: absUrlFromUpload(req, profilePicture), // comodidad
  };
}

/* ------------------------------------------------------------------
   CREAR EVENTO  (requiere usuario)
------------------------------------------------------------------- */
router.post("/", anyAuth, ensureUserId, upload.single("image"), async (req, res) => {
  try {
    const {
      title,
      description,
      // fechas (compat: si solo viene "date", la usamos como startAt)
      startAt: startAtRaw,
      endAt: endAtRaw,
      date: legacyDate,

      // ubicación
      city,
      street,
      postalCode,

      // extras
      categories, // puede venir string o array
      age,
      dressCode,
      price,
    } = req.body;

    let image = null;
    const userId = req.user.id;

    if (req.file) {
      const processedDir = ROOT_UPLOADS_DIR;
      const processedImagePath = await processImageToJpg(
        req.file.path,
        processedDir,
        `resized-${Date.now()}-${path.parse(req.file.originalname).name}`
      );
      // Guardamos path relativo desde /uploads
      image = path.relative(path.join(__dirname, ".."), processedImagePath).replace(/\\/g, "/");
    }

    // Normalizar fechas
    const startAt = parseDateMaybe(startAtRaw || legacyDate);
    const endAt   = parseDateMaybe(endAtRaw);

    // Normalizar categorías
    const parsedCategories = parseCategoriesMaybe(categories);

    // age/price a número (si vienen string)
    const ageNum   = parseNumberMaybe(age);
    const priceNum = parseNumberMaybe(price);

    const newEvent = new Event({
      title,
      description,

      // fechas
      startAt,
      endAt,
      date: startAt || undefined, // compat con código legacy que mire "date"

      // ubicación
      city,
      street,
      postalCode,

      // imagen principal
      image,

      // extras
      categories: parsedCategories,
      age: typeof ageNum === "number" ? ageNum : age,
      dressCode,
      price: typeof priceNum === "number" ? priceNum : price,

      // Relación del evento con el usuario/club autenticado.
      // Por ahora usamos el mismo userId como owner del panel club.
      createdBy: userId,
      clubId: userId,
      club: userId,

      // photos se inicializa por schema ([])
      // QR subir foto a evento
      qrToken: new mongoose.Types.ObjectId().toString(),
    });

    // Geocodificamos una sola vez, aquí, para que el mapa no tenga que
    // hacerlo en el móvil. Si falla, el evento se guarda igualmente con
    // geoStatus 'failed' y se puede reintentar luego.
    const geo = await geocodeAddress({ street, postalCode, city });
    applyGeo(newEvent, geo, buildAddress({ street, postalCode, city }));

    // Tandas (opcional). Sin ticketTiers, el evento es legacy (price/capacity).
    const tiersInput = parseTiersInput(req.body.ticketTiers);
    if (tiersInput.error) {
      return res.status(400).json({ message: tiersInput.error });
    }
    if (Array.isArray(tiersInput.value) && tiersInput.value.length > 0) {
      const { tiers, error } = sanitizeTiers(tiersInput.value);
      if (error) return res.status(400).json({ message: error });
      newEvent.ticketTiers = tiers;
      syncEventPrice(newEvent);
    }

    const savedEvent = await newEvent.save();
    res.status(201).json({
      ...savedEvent.toObject(),
      qrPayload: `NV_EVENT:${savedEvent._id}:${savedEvent.qrToken}`,
    });
  } catch (error) {
    console.error("Error al guardar el evento:", error);
    res.status(500).json({ message: "Error al guardar el evento", error: error.message });
  }
});

  /* ------------------------------------------------------------------
    LISTAR SOLO EVENTOS DEL CLUB/AUTH ACTUAL (panel clubs)
  ------------------------------------------------------------------- */

router.get("/mine", anyAuth, ensureUserId, async (req, res) => {
  try {
    const userId = req.user.id;

    const docs = await Event.find({
      $or: [
        { createdBy: userId },
        { clubId: userId },
        { club: userId },
      ],
    })
      // Eventos del propio club (ruta autenticada): sí incluye el secreto del QR.
      // Sin "+qrToken" el backfill de abajo regeneraría el token en cada carga.
      .select("+qrToken")
      .sort({ startAt: -1, date: -1, createdAt: -1 })
      .populate("createdBy", "username email profilePicture displayName");

    // Backfill de qrToken para eventos antiguos que no lo tengan todavía.
    for (const doc of docs) {
      if (!doc.qrToken) {
        doc.qrToken = new mongoose.Types.ObjectId().toString();
        await doc.save();
      }
    }

    const events = docs.map((doc) => doc.toObject());

    const formattedEvents = events.map((event) => {
      const photos = approvedOnly(event.photos)
        .map((p) => toPhotoTileAbs(req, p, req.user?.id || null))
        .filter(Boolean);

      return {
        ...event,
        imageUrl: absUrlFromUpload(req, event.image),
        photos,
        createdBy: event.createdBy
          ? {
              ...event.createdBy,
              profilePictureUrl: absUrlFromUpload(req, event.createdBy.profilePicture),
            }
          : null,
        categories: Array.isArray(event.categories)
          ? event.categories
          : parseCategoriesMaybe(event.categories),
      };
    });

    return res.json(formattedEvents);
  } catch (error) {
    console.error("[GET /events/mine] Error al obtener eventos del club:", error);
    return res.status(500).json({
      message: "Error al obtener los eventos del club",
      error: error.message || String(error),
    });
  }
});

/* ------------------------------------------------------------------
   LISTAR EVENTOS (público)
------------------------------------------------------------------- */
router.get("/", optionalUserId, async (req, res) => {
  try {
    const events = await Event.find().populate("createdBy", "username email profilePicture displayName").lean();

    const formattedEvents = events.map((event) => {
      // normaliza fotos a objetos con url absoluta (manteniendo compatibilidad)
      const photos = approvedOnly(event.photos)
        .map((p) => toPhotoTileAbs(req, p, req.user?.id || null))
        .filter(Boolean);

      return {
        ...event,
        imageUrl: absUrlFromUpload(req, event.image),
        photos,
        createdBy: event.createdBy
          ? {
              ...event.createdBy,
              profilePictureUrl: absUrlFromUpload(req, event.createdBy.profilePicture),
            }
          : null,
        categories: Array.isArray(event.categories)
          ? event.categories
          : parseCategoriesMaybe(event.categories),
      };
    });

    res.json(formattedEvents);
  } catch (error) {
    console.error("Error al obtener los eventos:", error);
    res.status(500).json({ message: "Error al obtener los eventos", error });
  }
});

/* ------------------------------------------------------------------
   BUSCAR EVENTOS (público)
   GET /api/events/search?q=...
   ⚠️ IMPORTANTE: esta ruta debe ir ANTES que cualquier /:id
------------------------------------------------------------------- */
router.get("/search", optionalUserId, async (req, res) => {
  try {
    const qRaw = (req.query.q || req.query.query || req.query.search || "").toString();
    const q = qRaw.trim();

    if (!q) {
      return res.json([]);
    }

    // Escapar regex para evitar caracteres especiales.
    const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(escapeRegExp(q), "i");

    // Busca por campos comunes.
    // (Si quieres afinar luego: categorías, clubName/entityName, etc.)
    const filter = {
      $or: [
        { title: rx },
        { description: rx },
        { city: rx },
        { street: rx },
        { postalCode: rx },
        { categories: rx }, // categories suele ser array; Mongoose soporta regex sobre arrays de strings
      ],
    };

    const events = await Event.find(filter)
      .sort({ startAt: 1, date: 1, createdAt: -1 })
      .limit(40)
      .populate("createdBy", "username email profilePicture displayName")
      .lean();

    const formattedEvents = events.map((event) => {
      const photos = approvedOnly(event.photos)
        .map((p) => toPhotoTileAbs(req, p, req.user?.id || null))
        .filter(Boolean);

      return {
        ...event,
        imageUrl: absUrlFromUpload(req, event.image),
        photos,
        createdBy: event.createdBy
          ? {
              ...event.createdBy,
              profilePictureUrl: absUrlFromUpload(req, event.createdBy.profilePicture),
            }
          : null,
        categories: Array.isArray(event.categories)
          ? event.categories
          : parseCategoriesMaybe(event.categories),
      };
    });

    return res.json(formattedEvents);
  } catch (error) {
    console.error("[GET /events/search] Error al buscar eventos:", error);
    return res.status(500).json({
      message: "Error al buscar eventos",
      error: error.message || String(error),
    });
  }
});

/* ------------------------------------------------------------------
   MAPA — proyección mínima para pintar pines
   ⚠️  Debe quedar ANTES de /:id para que Express no lo interprete como id
------------------------------------------------------------------- */
router.get("/map", optionalUserId, async (req, res) => {
  try {
    const now = new Date();

    const geoFilter = { "location.coordinates": { $exists: true } };

    // Solo eventos publicados y no terminados
    const dateFilter = {
      isPublished: { $ne: false },
      $or: [
        { endAt: { $gte: now } },
        { startAt: { $gte: now } },
        { endAt: null, startAt: null },
      ],
    };

    let filter = { ...geoFilter, ...dateFilter };

    // Bounding box opcional: ?swLat=&swLng=&neLat=&neLng=
    const { swLat, swLng, neLat, neLng } = req.query;
    if (swLat != null && swLng != null && neLat != null && neLng != null) {
      const sw = [parseFloat(swLng), parseFloat(swLat)];
      const ne = [parseFloat(neLng), parseFloat(neLat)];
      if (!sw.some(Number.isNaN) && !ne.some(Number.isNaN)) {
        filter.location = {
          $geoWithin: { $box: [sw, ne] },
        };
      }
    }

    const projection = {
      _id: 1,
      title: 1,
      image: 1,
      startAt: 1,
      date: 1,
      city: 1,
      street: 1,
      price: 1,
      currency: 1,
      location: 1,
      categories: 1,
      clubId: 1,
      attendees: 1, // solo para contar, no se devuelve
    };

    const events = await Event.find(filter, projection).lean();

    const result = events.map((e) => ({
      _id: e._id,
      title: e.title,
      image: e.image,
      imageUrl: absUrlFromUpload(req, e.image),
      startAt: e.startAt,
      date: e.date,
      city: e.city,
      street: e.street,
      price: e.price,
      currency: e.currency,
      location: e.location,
      categories: Array.isArray(e.categories)
        ? e.categories
        : parseCategoriesMaybe(e.categories),
      clubId: e.clubId,
      attendeesCount: Array.isArray(e.attendees) ? e.attendees.length : 0,
    }));

    return res.json(result);
  } catch (err) {
    console.error("[GET /events/map] error:", err);
    return res
      .status(500)
      .json({ message: "Error obteniendo eventos del mapa", error: err.message });
  }
});

/* ------------------------------------------------------------------
   Devuelve asistentes
   - ?full=1 -> lista plana de usuarios (frontend la admite)
   - sin ?full -> { attendees: [...] } (compat)
   - alias: /:id/attendees/populated -> fuerza full
------------------------------------------------------------------- */
async function attendeesHandler(req, res, forceFull = false) {
  try {
    const id = req.params.id;
    const full = forceFull || req.query.full === "1" || req.query.full === "true";

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }

    const event = await Event.findById(id)
      .populate("attendees", "username displayName profilePicture phoneNumber isPrivate")
      .lean();

    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    const list = (event.attendees || []).map((u) => shapePublicUser(req, u)).filter(Boolean);


    if (full) {
      // lista directa (frontend lo soporta)
      return res.json(list);
    }
    // compat: objeto con clave attendees
    return res.json({ attendees: list });
  } catch (err) {
    console.error("[GET /events/:id/attendees] error:", err);
    res.status(500).json({ message: "Error obteniendo asistentes" });
  }
}

/* ------------------------------------------------------------------
   QR SCAN FLOW
   - El QR del evento abre la cámara dentro de la app
   - La app resuelve el token y sube la foto al evento correcto
------------------------------------------------------------------- */
/**
 * Escanear el QR del local = prueba de presencia. Registra el escaneo (QrScan),
 * hace avanzar las misiones scan_qr (solo en el primer escaneo de cada evento)
 * y devuelve la misión de foto activa del usuario.
 */
async function handleQrScanResolve(req, res, rawPayload, logTag) {
  try {
    const parsed = parseQrPayloadValue(rawPayload);

    if (!parsed || !parsed.qrToken) {
      return res.status(400).json({ message: "QR inválido" });
    }

    const query = { qrToken: parsed.qrToken };
    if (parsed.eventId && mongoose.isValidObjectId(parsed.eventId)) {
      query._id = parsed.eventId;
    }

    // +qrToken: buildQrResolveResponse lo usa para las URLs de subida
    const event = await Event.findOne(query).select("+qrToken").lean();
    if (!event) {
      return res.status(404).json({ message: "Evento no encontrado para este QR" });
    }

    const { firstScan } = await recordQrScan(req, event);
    const clubId = promotionClubKeyForEvent(event);
    if (firstScan && clubId) {
      await syncPromotionAfterQrScan({ userId: req.user.id, clubId, eventId: event._id });
    }

    const activePhotoMission = await resolveActivePhotoMissionForUser({
      userId: req.user.id,
      event,
    });

    return res.json(buildQrResolveResponse(req, event, activePhotoMission));
  } catch (e) {
    console.error(`[${logTag}] error:`, e);
    return res.status(500).json({ message: "Error resolviendo QR" });
  }
}

router.post("/scan/resolve", anyAuth, ensureUserId, (req, res) =>
  handleQrScanResolve(
    req,
    res,
    req.body?.qrPayload || req.body?.payload || req.body?.qr || req.body?.token,
    "POST /events/scan/resolve"
  )
);

router.get("/scan/:token/resolve", anyAuth, ensureUserId, (req, res) =>
  handleQrScanResolve(req, res, req.params.token, "GET /events/scan/:token/resolve")
);

router.post("/scan/:token/photo", anyAuth, ensureUserId, uploadAny.any(), async (req, res, next) => {
  try {
    const parsed = parseQrPayloadValue(req.params.token);

    if (!parsed || !parsed.qrToken) {
      return res.status(400).json({ message: "QR inválido" });
    }

    const query = { qrToken: parsed.qrToken };
    if (parsed.eventId && mongoose.isValidObjectId(parsed.eventId)) {
      query._id = parsed.eventId;
    }

    const event = await Event.findOne(query).select("_id").lean();
    if (!event) {
      return res.status(404).json({ message: "Evento no encontrado para este QR" });
    }

    req.params.id = String(event._id);
    req.viaQrScan = true; // la foto queda marcada como subida por el flujo del QR
    return postPhotosHandler(req, res, next);
  } catch (e) {
    console.error("[POST /events/scan/:token/photo] error:", e);
    return res.status(500).json({ message: "Error subiendo foto desde QR" });
  }
});

/* =======================================================================
   ENTRADAS COMPRADAS (has-ticket)
   Compras guardadas en Order.userId = UID de Firebase. Casamos contra el uid
   de Firebase (y req.user.id por robustez). Compra válida = status 'paid'.
   ======================================================================= */

// GET /api/events/my-tickets -> { eventIds: [...] }
// El Home lo pide UNA vez y construye un Set (evita N peticiones, una por tarjeta).
// IMPORTANTE: debe quedar ANTES de `router.get("/:id", ...)`, si no Express
// interpretaría "my-tickets" como un :id.
router.get("/my-tickets", optionalUserId, async (req, res) => {
  try {
    const buyerIds = [req.firebaseUser?.uid, req.user?.id].filter(Boolean);
    if (buyerIds.length === 0) return res.json({ eventIds: [] });

    // Tiene entrada si la compró (Order pagada) O si se la han asignado (Ticket)
    const [orderEventIds, assignedEventIds] = await Promise.all([
      Order.distinct("eventId", { userId: { $in: buyerIds }, status: "paid" }),
      Ticket.distinct("eventId", { assignedToUserId: { $in: buyerIds }, status: { $ne: "refunded" } }),
    ]);

    const eventIds = [
      ...new Set([...(orderEventIds || []), ...(assignedEventIds || [])].map((x) => String(x)).filter(Boolean)),
    ];
    return res.json({ eventIds });
  } catch (err) {
    console.error("[GET /events/my-tickets] error:", err);
    return res.status(500).json({ eventIds: [] });
  }
});

/* ------------------------------------------------------------------
   MIS ENTRADAS (detalle completo para la app)
   GET /api/events/my-tickets/full
   ANTES de "/:id" para que Express no lo tome como un id.

   Busca por:
   - ownerUserId = uid de Firebase
   - ownerUserId = _id de Mongo
   - email del comprador, SOLO si Firebase lo da como verificado. User.email
     no sirve: /api/auth/update deja poner cualquiera sin verificar, y como el
     check-in valida por serial, devolver el serial a quien no es el dueño
     permitiría entrar con su entrada.

   Nunca devuelve tokenHash, token ni checkedInBy.
------------------------------------------------------------------- */

// Un evento se considera terminado en endAt; si no lo tiene, 12 h después de
// empezar (eventos nocturnos que no rellenan la hora de fin).
const EVENT_DEFAULT_DURATION_MS = 12 * 60 * 60 * 1000;

function eventTimes(ev) {
  const start = ev?.startAt || ev?.date || null;
  const startMs = start ? new Date(start).getTime() : null;
  let endMs = ev?.endAt ? new Date(ev.endAt).getTime() : null;
  if (endMs === null && startMs !== null) endMs = startMs + EVENT_DEFAULT_DURATION_MS;
  return {
    startMs: Number.isFinite(startMs) ? startMs : null,
    endMs: Number.isFinite(endMs) ? endMs : null,
  };
}

function escapeRegExpLiteral(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Identidad del usuario para decidir qué entradas son suyas.
 * Hay DOS criterios, a propósito separados (no mezclar ni duplicar en otro sitio):
 *  (b) PROPIEDAD = comprador: ticketOwnerFilter / isTicketOwner.
 *      Gobierna asignar y quitar la asignación.
 *  (a) VISIBILIDAD = comprador O destinatario asignado (assignedToUserId):
 *      ticketViewerFilter / canViewTicket. Gobierna /my-tickets/full y el QR.
 * ⚠️ Nunca uses (a) para asignar: el destinatario podría reasignar la entrada.
 * - ownerIds: uid de Firebase y _id de Mongo.
 * - verifiedEmail: SOLO el email que Firebase marca como verificado
 *   (User.email se puede cambiar sin verificar en /api/auth/update).
 */
function ticketOwnerFromRequest(req) {
  const ownerIds = [...new Set([req.firebaseUser?.uid, req.user?.id].filter(Boolean).map(String))];
  const email =
    req.firebaseUser?.emailVerified === true && typeof req.firebaseUser.email === "string"
      ? req.firebaseUser.email.trim().toLowerCase()
      : "";
  const verifiedEmail = email && !/@firebase\.local$/.test(email) ? email : "";
  return { ownerIds, verifiedEmail };
}

/** Filtro de Mongo con las entradas del usuario, o null si no hay identidad. */
function ticketOwnerFilter(owner) {
  const or = [];
  if (owner.ownerIds.length) or.push({ ownerUserId: { $in: owner.ownerIds } });
  if (owner.verifiedEmail) {
    or.push({ email: new RegExp(`^${escapeRegExpLiteral(owner.verifiedEmail)}$`, "i") });
  }
  return or.length ? { $or: or } : null;
}

/** Misma regla que ticketOwnerFilter, aplicada a un ticket ya cargado. (b) PROPIEDAD: solo el comprador. */
function isTicketOwner(ticket, owner) {
  if (!ticket) return false;
  if (ticket.ownerUserId && owner.ownerIds.includes(String(ticket.ownerUserId))) return true;
  if (
    owner.verifiedEmail &&
    typeof ticket.email === "string" &&
    ticket.email.toLowerCase() === owner.verifiedEmail // = regex ^email$ con flag i
  ) {
    return true;
  }
  return false;
}

/** ¿Es el usuario el destinatario asignado de la entrada? (uid de Firebase o _id de Mongo) */
function isTicketAssignee(ticket, owner) {
  return !!(ticket?.assignedToUserId && owner.ownerIds.includes(String(ticket.assignedToUserId)));
}

/**
 * (a) VISIBILIDAD: ¿puede ver la entrada y mostrar su QR? Comprador o destinatario.
 * ⚠️ NO usar para asignar/quitar la asignación: eso es isTicketOwner.
 */
function canViewTicket(ticket, owner) {
  return isTicketOwner(ticket, owner) || isTicketAssignee(ticket, owner);
}

/** Filtro de Mongo de (a): entradas compradas por el usuario + las que le han asignado. */
function ticketViewerFilter(owner) {
  const or = [...(ticketOwnerFilter(owner)?.$or || [])];
  if (owner.ownerIds.length) or.push({ assignedToUserId: { $in: owner.ownerIds } });
  return or.length ? { $or: or } : null;
}

/* ------------------------------------------------------------------
   ENTRADAS CON NOMBRE (asignación a un acompañante)
   El comprador NUNCA pierde la custodia: la asignación es una invitación
   (enlace con claimToken), no una cesión. La propiedad sigue siendo
   ticketOwnerFromRequest / isTicketOwner.
------------------------------------------------------------------- */
function newClaimToken() {
  return crypto.randomBytes(16).toString("base64url"); // 128 bits, corto para URL
}

function claimUrlFor(claimToken) {
  const base = (process.env.PUBLIC_WEB_URL || "https://nightvibe.life").replace(/\/+$/, "");
  return `${base}/t/${claimToken}`;
}

/**
 * Teléfono a formato internacional (+34...) si se puede; si no, lo que llegó.
 * Solo informativo: NO se usa para autenticar.
 */
function normalizePhoneLoose(raw) {
  const input = String(raw || "").trim().slice(0, 40);
  if (!input) return "";
  let s = input.replace(/[\s\-().]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (/^\+\d{8,15}$/.test(s)) return s;
  if (/^[6789]\d{8}$/.test(s)) return `+34${s}`;   // número español sin prefijo
  if (/^34[6789]\d{8}$/.test(s)) return `+${s}`;   // español con 34 pero sin "+"
  return input;
}

/**
 * Asignación para /my-tickets/full, SOLO para el comprador (role 'owner'), o null.
 * userId: destinatario de la app (asignación a usuario) o null (asignación por enlace).
 */
function assignmentView(t) {
  if (!t.claimToken && !t.assignedAt && !t.assignedToUserId) return null;
  return {
    name: t.assignedToName || "",
    phone: t.assignedToPhone || "",
    userId: t.assignedToUserId || null,
    assignedAt: t.assignedAt || null,
    claimToken: t.claimToken || null,
    claimUrl: t.claimToken ? claimUrlFor(t.claimToken) : null,
    claimedAt: t.claimedAt || null,
  };
}

/**
 * Busca al destinatario de una asignación por _id de Mongo o uid de Firebase
 * (nunca por teléfono, email ni username).
 */
async function findAssignableUser(userId) {
  const key = typeof userId === "string" ? userId.trim() : "";
  if (!key) return null;
  const filter = /^[a-fA-F0-9]{24}$/.test(key) ? { _id: key } : { firebaseUid: key };
  return User.findOne(filter).select("_id username role firebaseUid").lean();
}

/**
 * Notificación (bandeja + push) al destinatario de una entrada asignada.
 * Mismo patrón que socialController: documento Notification y luego push.
 * Nunca lanza: un fallo aquí no debe deshacer la asignación.
 */
async function notifyTicketAssigned({ req, ticket, recipient }) {
  try {
    const buyerId = String(req.user?.id || "");
    const [buyer, ev] = await Promise.all([
      mongoose.isValidObjectId(buyerId) ? User.findById(buyerId).select("username").lean() : null,
      mongoose.isValidObjectId(String(ticket.eventId))
        ? Event.findById(ticket.eventId).select("_id title image").lean()
        : null,
    ]);
    const buyerName = buyer?.username || "Alguien";
    const eventTitle = ev?.title || "un evento";

    const notification = await Notification.findOneAndUpdate(
      { user: recipient._id, type: "ticket_assigned", ticketId: ticket._id },
      {
        $set: {
          title: "Tienes una entrada",
          body: `${buyerName} te ha dado una entrada para ${eventTitle}`,
          // Mismo criterio que `event:<id>/photos`: entidad + pestaña
          routeTarget: `profile:${recipient._id}/tickets`,
          previewImage: ev ? absUrlFromUpload(req, ev.image) : null,
          actor: buyer?._id || null,
          event: ev?._id || null,
          read: false,
          readAt: null,
          pushSent: false,
          meta: { eventTitle, givenByUsername: buyer?.username || "" },
        },
        $setOnInsert: { user: recipient._id, type: "ticket_assigned", ticketId: ticket._id },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    if (notification?._id) {
      await sendPushNotificationToUser(recipient._id, notification);
    }
  } catch (e) {
    console.warn("[notifications] notifyTicketAssigned failed:", e?.message || e);
  }
}

/**
 * Carga el ticket de :ticketId comprobando que es del usuario y que no está usado.
 * Devuelve { ticket } o { status, body } con el error a responder.
 */
async function loadOwnTicketForAssignment(req, logTag) {
  const { ticketId } = req.params;
  if (!mongoose.isValidObjectId(ticketId)) {
    return { status: 400, body: { error: "invalid_id", message: "ID de entrada inválido" } };
  }

  const ticket = await Ticket.findById(ticketId)
    .select("_id eventId status ownerUserId email claimToken assignedToUserId")
    .lean();
  if (!ticket) {
    return { status: 404, body: { error: "not_found", message: "Entrada no encontrada" } };
  }

  // ⚠️ (b) PROPIEDAD: solo el COMPRADOR asigna o quita la asignación. NO canViewTicket:
  // el destinatario puede ver la entrada, pero no reasignarla.
  if (!isTicketOwner(ticket, ticketOwnerFromRequest(req))) {
    console.warn(`[${logTag}] acceso denegado`, {
      ticketId: String(ticket._id),
      userId: req.user?.id || null,
    });
    return { status: 403, body: { error: "forbidden", message: "Esta entrada no es tuya" } };
  }

  if (ticket.status === "checked_in") {
    return { status: 409, body: { error: "already_used", message: "Esta entrada ya se ha usado" } };
  }

  return { ticket };
}

/**
 * Precio unitario (EUR) de una entrada, por orden de preferencia:
 * 1) priceEUR del tier del evento, 2) unitAmount (céntimos) del item de la orden
 * con ese ticketTypeId, 3) amountEUR / qty de la orden. Si nada aplica, null.
 */
function ticketUnitPriceEUR(ticket, tier, order) {
  const tierPrice = Number(tier?.priceEUR);
  if (tier && tier.priceEUR != null && Number.isFinite(tierPrice)) return tierPrice;

  if (ticket.ticketTypeId && Array.isArray(order?.items)) {
    const item = order.items.find((it) => it?.ticketTypeId === ticket.ticketTypeId);
    const cents = Number(item?.unitAmount);
    if (item && item.unitAmount != null && Number.isFinite(cents)) return cents / 100;
  }

  const total = Number(order?.amountEUR);
  const qty = Number(order?.qty);
  if (order?.amountEUR != null && Number.isFinite(total) && Number.isFinite(qty) && qty > 0) {
    return Math.round((total / qty) * 100) / 100;
  }

  return null;
}

router.get("/my-tickets/full", anyAuth, ensureUserId, async (req, res) => {
  try {
    // (a) VISIBILIDAD: las que compré + las que me han asignado
    const owner = ticketOwnerFromRequest(req);
    const viewerFilter = ticketViewerFilter(owner);
    if (!viewerFilter) return res.json([]);

    // ownerUserId/email solo para decidir el papel (isTicketOwner); NO se devuelven.
    const tickets = await Ticket.find(viewerFilter)
      .select(
        "_id eventId orderId serial status issuedAt checkedInAt ticketTypeId ownerUserId email " +
          "assignedToName assignedToPhone assignedToUserId assignedAt claimToken claimedAt"
      )
      .lean();
    if (!tickets.length) return res.json([]);

    // Papel de cada entrada: 'owner' (la compré yo) o 'assigned' (me la han dado)
    const roleById = new Map(
      tickets.map((t) => [String(t._id), isTicketOwner(t, owner) ? "owner" : "assigned"])
    );

    // Quién me dio las asignadas: username del comprador (ownerUserId = uid de Firebase o _id)
    const giverKeys = [
      ...new Set(
        tickets
          .filter((t) => roleById.get(String(t._id)) === "assigned" && t.ownerUserId)
          .map((t) => String(t.ownerUserId))
      ),
    ];
    const givers = giverKeys.length
      ? await User.find({
          $or: [
            { _id: { $in: giverKeys.filter((k) => /^[a-fA-F0-9]{24}$/.test(k)) } },
            { firebaseUid: { $in: giverKeys } },
          ],
        })
          .select("_id firebaseUid username")
          .lean()
      : [];
    const giverNameByKey = new Map();
    for (const g of givers) {
      giverNameByKey.set(String(g._id), g.username || "");
      if (g.firebaseUid) giverNameByKey.set(String(g.firebaseUid), g.username || "");
    }

    // --- Carga en bloque: eventos, órdenes y clubs ---
    const eventIds = [...new Set(tickets.map((t) => String(t.eventId)).filter(mongoose.isValidObjectId))];
    const orderIds = [...new Set(tickets.map((t) => t.orderId && String(t.orderId)).filter(Boolean))];

    const [events, orders] = await Promise.all([
      Event.find({ _id: { $in: eventIds } })
        .select("_id title image startAt endAt date city street ticketTiers.tierId ticketTiers.name ticketTiers.priceEUR club createdBy")
        .lean(),
      Order.find({ _id: { $in: orderIds } })
        .select("_id amountEUR currency qty tierName items.ticketTypeId items.unitAmount")
        .lean(),
    ]);
    const eventById = new Map(events.map((e) => [String(e._id), e]));
    const orderById = new Map(orders.map((o) => [String(o._id), o]));

    // Nombre del club: Club por event.club; si no, el User propietario (entityName...)
    const clubRefIds = [...new Set(events.map((e) => e.club && String(e.club)).filter(Boolean))];
    const ownerRefIds = [...new Set(events.map((e) => e.createdBy && String(e.createdBy)).filter(Boolean))];
    const [clubs, owners] = await Promise.all([
      clubRefIds.length ? Club.find({ _id: { $in: clubRefIds } }).select("_id name").lean() : [],
      ownerRefIds.length
        ? User.find({ _id: { $in: ownerRefIds } }).select("_id entityName entName displayName username").lean()
        : [],
    ]);
    const clubNameById = new Map(clubs.map((c) => [String(c._id), c.name]));
    const ownerNameById = new Map(
      owners.map((u) => [String(u._id), u.entityName || u.entName || u.displayName || u.username || ""])
    );

    const now = Date.now();

    const rows = tickets.map((t) => {
      const ev = eventById.get(String(t.eventId)) || null;
      const ord = t.orderId ? orderById.get(String(t.orderId)) : null;
      const { startMs, endMs } = eventTimes(ev);
      const ended = endMs !== null && endMs < now;

      const tier = t.ticketTypeId
        ? (ev?.ticketTiers || []).find((x) => x.tierId === t.ticketTypeId)
        : null;

      let state;
      if (t.status === "refunded") state = "reembolsada";
      else if (t.status === "checked_in") state = "usada";
      else if (ended) state = "pasada";
      else state = "activa";

      const clubName =
        (ev?.club && clubNameById.get(String(ev.club))) ||
        (ev?.createdBy && ownerNameById.get(String(ev.createdBy))) ||
        "";

      const role = roleById.get(String(t._id));
      const isOwnerRole = role === "owner";

      return {
        _sortStart: startMs,
        _upcoming: !ended,
        ticketId: String(t._id),
        role, // 'owner' = la compré yo | 'assigned' = me la han dado
        givenBy: isOwnerRole
          ? null
          : { username: (t.ownerUserId && giverNameByKey.get(String(t.ownerUserId))) || "" },
        serial: t.serial,
        status: t.status,
        state,
        issuedAt: t.issuedAt || null,
        checkedInAt: t.checkedInAt || null,
        ticketTypeId: t.ticketTypeId || null,
        tierName: tier?.name || ord?.tierName || null,
        event: ev
          ? {
              _id: String(ev._id),
              title: ev.title || "",
              imageUrl: absUrlFromUpload(req, ev.image),
              startAt: ev.startAt || ev.date || null,
              city: ev.city || "",
              street: ev.street || "",
            }
          : null,
        club: clubName ? { name: clubName } : null,
        // amountEUR es el total de la orden (qty entradas), sin la comisión.
        // unitAmountEUR es el precio de ESTA entrada.
        // Solo para el comprador: lo que pagó no es asunto del destinatario.
        order: ord && isOwnerRole
          ? {
              amountEUR: ord.amountEUR ?? null,
              unitAmountEUR: ticketUnitPriceEUR(t, tier, ord),
              currency: ord.currency || "eur",
              qty: ord.qty || 1,
            }
          : null,
        // Asignación (claimToken/claimUrl incluidos) SOLO para el comprador
        assignment: isOwnerRole ? assignmentView(t) : null,
      };
    });

    // Futuras primero (la más próxima arriba); luego pasadas (la más reciente arriba).
    // Sin fecha: al final de su grupo.
    rows.sort((a, b) => {
      if (a._upcoming !== b._upcoming) return a._upcoming ? -1 : 1;
      const as = a._sortStart, bs = b._sortStart;
      if (as === null && bs === null) return 0;
      if (as === null) return 1;
      if (bs === null) return -1;
      return a._upcoming ? as - bs : bs - as;
    });

    return res.json(rows.map(({ _sortStart, _upcoming, ...rest }) => rest));
  } catch (err) {
    console.error("[GET /events/my-tickets/full] error:", err);
    return res.status(500).json({ message: "Error obteniendo tus entradas" });
  }
});

/* ------------------------------------------------------------------
   QR DE UNA ENTRADA (solo su dueño)
   GET /api/events/my-tickets/:ticketId/qr -> { serial, qrPayload }
   ANTES de "/:id". qrPayload = JSON.stringify({ serial, token: makeToken(serial) }),
   el mismo formato que el QR del email; la app pinta la imagen en el cliente.
------------------------------------------------------------------- */
router.get("/my-tickets/:ticketId/qr", anyAuth, ensureUserId, async (req, res) => {
  try {
    // El QR da acceso al evento: que nadie lo guarde en caché.
    res.set("Cache-Control", "no-store");

    const { ticketId } = req.params;
    if (!mongoose.isValidObjectId(ticketId)) {
      return res.status(400).json({ message: "ID de entrada inválido" });
    }

    const ticket = await Ticket.findById(ticketId)
      .select("_id serial status ownerUserId email assignedToUserId")
      .lean();
    if (!ticket) return res.status(404).json({ message: "Entrada no encontrada" });

    // ⚠️ (a) VISIBILIDAD: comprador o destinatario asignado, como /my-tickets/full.
    if (!canViewTicket(ticket, ticketOwnerFromRequest(req))) {
      console.warn("[GET /events/my-tickets/:ticketId/qr] acceso denegado", {
        ticketId: String(ticket._id),
        userId: req.user?.id || null,
      });
      return res.status(403).json({ message: "Esta entrada no es tuya" });
    }

    if (ticket.status === "refunded") {
      return res.status(403).json({ reason: "refunded", message: "Esta entrada está reembolsada" });
    }

    if (!ticket.serial) {
      return res.status(409).json({ message: "La entrada no tiene serial" });
    }

    const serial = ticket.serial;
    const qrPayload = JSON.stringify({ serial, token: makeToken(serial) });
    return res.json({ serial, qrPayload });
  } catch (err) {
    console.error("[GET /events/my-tickets/:ticketId/qr] error:", err);
    return res.status(500).json({ message: "Error generando el QR" });
  }
});

/** Respuesta 409 coherente cuando el update atómico no encuentra la entrada en 'issued'. */
async function assignmentConflict(res, ticketId) {
  const fresh = await Ticket.findById(ticketId).select("status").lean();
  if (fresh?.status === "checked_in") {
    return res.status(409).json({ error: "already_used", message: "Esta entrada ya se ha usado" });
  }
  if (fresh?.status === "refunded") {
    return res.status(409).json({ error: "refunded", message: "Esta entrada está reembolsada" });
  }
  return res.status(409).json({ error: "conflict", message: "La entrada ha cambiado, inténtalo de nuevo" });
}

/**
 * Asignación a un USUARIO de la app ({ userId }). Sin enlace: el destinatario la
 * ve en su perfil. Sustituye cualquier asignación previa (enlace o usuario):
 * el claimToken anterior deja de valer.
 */
async function assignToAppUser(req, res, ticket) {
  const recipient = await findAssignableUser(req.body.userId);
  if (!recipient) {
    return res.status(404).json({ error: "user_not_found", message: "Usuario no encontrado" });
  }
  if (recipient.role === "club") {
    return res.status(400).json({ error: "cannot_assign_to_club", message: "No se puede asignar una entrada a un club" });
  }
  const owner = ticketOwnerFromRequest(req);
  if (
    owner.ownerIds.includes(String(recipient._id)) ||
    (recipient.firebaseUid && owner.ownerIds.includes(String(recipient.firebaseUid)))
  ) {
    return res.status(400).json({ error: "cannot_assign_to_self", message: "Esta entrada ya es tuya" });
  }

  const recipientId = String(recipient._id);

  // Solo a quien sigues (como el selector /api/users/me/assignable): evita mandar
  // notificaciones push a desconocidos cambiando de destinatario.
  const buyer = mongoose.isValidObjectId(String(req.user?.id || ""))
    ? await User.findById(req.user.id).select("following").lean()
    : null;
  const follows = (buyer?.following || []).some((f) => String(f) === recipientId);
  if (!follows) {
    return res.status(403).json({ error: "not_following", message: "Solo puedes asignar entradas a gente que sigues" });
  }
  const updated = await Ticket.findOneAndUpdate(
    { _id: ticket._id, status: "issued" },
    {
      $set: {
        assignedToUserId: recipientId,
        assignedToName: recipient.username || "",
        assignedToPhone: "",
        assignedAt: new Date(),
        // Sin enlace: si había uno (asignación por enlace), deja de valer
        claimToken: null,
        claimedAt: null,
        claimedByUserId: null,
      },
    },
    { new: true }
  )
    .select("_id eventId assignedToUserId assignedToName")
    .lean();

  if (!updated) return assignmentConflict(res, ticket._id);

  // Solo se avisa si cambia el destinatario (no en cada reintento)
  if (String(ticket.assignedToUserId || "") !== recipientId) {
    await notifyTicketAssigned({ req, ticket: updated, recipient });
  }

  return res.json({
    ok: true,
    assignedToUserId: updated.assignedToUserId,
    assignedToName: updated.assignedToName,
  });
}

/* ------------------------------------------------------------------
   ASIGNAR UNA ENTRADA (solo su COMPRADOR: isTicketOwner)
   POST /api/events/my-tickets/:ticketId/assign
     { userId }      -> a un usuario de la app: { ok, assignedToUserId, assignedToName }
     { name, phone } -> por enlace: { ok, claimToken, claimUrl, assignedToName }
   ANTES de "/:id". Por enlace: si ya había claimToken se CONSERVA (el enlace ya
   compartido sigue valiendo tras cambiar el nombre).
------------------------------------------------------------------- */
// 20 asignaciones por hora y usuario (va DESPUÉS de ensureUserId: cuenta por req.user.id)
const assignLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `u:${req.user.id}`,
  handler: (_req, res) =>
    res.status(429).json({ error: "rate_limited", message: "Demasiadas asignaciones, inténtalo más tarde" }),
});

router.post("/my-tickets/:ticketId/assign", anyAuth, ensureUserId, assignLimiter, async (req, res) => {
  try {
    const loaded = await loadOwnTicketForAssignment(req, "POST /events/my-tickets/:ticketId/assign");
    if (!loaded.ticket) return res.status(loaded.status).json(loaded.body);
    const { ticket } = loaded;

    if (ticket.status === "refunded") {
      return res.status(409).json({ error: "refunded", message: "Esta entrada está reembolsada" });
    }

    const body = req.body || {};
    if (body.userId !== undefined && body.userId !== null) {
      return await assignToAppUser(req, res, ticket);
    }

    const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
    if (!name) {
      return res.status(400).json({ error: "missing_name", message: "Falta el nombre" });
    }
    if (name.length > 80) {
      return res.status(400).json({ error: "name_too_long", message: "El nombre es demasiado largo" });
    }
    const phone = typeof body.phone === "string" ? normalizePhoneLoose(body.phone) : "";

    const claimToken = ticket.claimToken || newClaimToken();

    // Atómico: solo si sigue sin usar y nadie ha cambiado el claimToken entretanto
    // (dos asignaciones a la vez no deben generar dos enlaces distintos).
    const updated = await Ticket.findOneAndUpdate(
      { _id: ticket._id, status: "issued", claimToken: ticket.claimToken || null },
      {
        $set: {
          assignedToName: name,
          assignedToPhone: phone,
          assignedAt: new Date(),
          claimToken,
          // Por enlace sustituye a una asignación previa a un usuario de la app
          assignedToUserId: null,
        },
      },
      { new: true }
    )
      .select("claimToken assignedToName")
      .lean();

    if (!updated) return assignmentConflict(res, ticket._id);

    return res.json({
      ok: true,
      claimToken: updated.claimToken,
      claimUrl: claimUrlFor(updated.claimToken),
      assignedToName: updated.assignedToName,
    });
  } catch (err) {
    console.error("[POST /events/my-tickets/:ticketId/assign] error:", err);
    return res.status(500).json({ message: "Error asignando la entrada" });
  }
});

/* ------------------------------------------------------------------
   QUITAR LA ASIGNACIÓN (solo su dueño)
   DELETE /api/events/my-tickets/:ticketId/assign -> { ok }
   Borra el claimToken: el enlace antiguo deja de valer.
------------------------------------------------------------------- */
router.delete("/my-tickets/:ticketId/assign", anyAuth, ensureUserId, async (req, res) => {
  try {
    const loaded = await loadOwnTicketForAssignment(req, "DELETE /events/my-tickets/:ticketId/assign");
    if (!loaded.ticket) return res.status(loaded.status).json(loaded.body);

    // Atómico: no se toca una entrada que se haya usado entretanto.
    const result = await Ticket.updateOne(
      { _id: loaded.ticket._id, status: { $ne: "checked_in" } },
      {
        $set: {
          assignedToName: "",
          assignedToPhone: "",
          assignedToUserId: null,
          assignedAt: null,
          claimToken: null,
          // El enlace nuevo (si se reasigna) aún no lo ha abierto nadie
          claimedAt: null,
          claimedByUserId: null,
        },
      }
    );

    if (!(result.n ?? result.matchedCount)) {
      return res.status(409).json({ error: "already_used", message: "Esta entrada ya se ha usado" });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /events/my-tickets/:ticketId/assign] error:", err);
    return res.status(500).json({ message: "Error quitando la asignación" });
  }
});

/* ------------------------------------------------------------------
   ENLACE DEL ACOMPAÑANTE (PÚBLICO, sin autenticación)
   GET /api/tickets/claim/:claimToken  — montado en index.js como
   app.use("/api/tickets", eventRoutes.ticketClaimRouter).
   ⚠️ Solo lo imprescindible para enseñar la entrada: nada del comprador,
   de la orden ni ids internos.
------------------------------------------------------------------- */
const ticketClaimRouter = express.Router();

const claimLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 60,             // 60 peticiones por IP/min
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ ok: false, reason: "rate_limited" }),
});

ticketClaimRouter.get("/claim/:claimToken", claimLimiter, async (req, res) => {
  // El QR da acceso al evento: que nadie lo guarde en caché.
  res.set("Cache-Control", "no-store");
  const notFound = () => res.status(404).json({ ok: false, reason: "not_found" });

  try {
    const claimToken = String(req.params.claimToken || "");
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(claimToken)) return notFound();

    const ticket = await Ticket.findOne({ claimToken })
      .select("_id serial status eventId orderId ticketTypeId assignedToName claimedAt")
      .lean();
    // Reembolsada: mismo 404, sin dar detalles
    if (!ticket || ticket.status === "refunded" || !ticket.serial) return notFound();

    const ev = mongoose.isValidObjectId(String(ticket.eventId))
      ? await Event.findById(ticket.eventId)
          .select("title image startAt date city street ticketTiers.tierId ticketTiers.name club createdBy")
          .lean()
      : null;

    // tierName: tier del evento; si no, el de la orden (sin devolver nada más de ella)
    const tier = ticket.ticketTypeId
      ? (ev?.ticketTiers || []).find((x) => x.tierId === ticket.ticketTypeId)
      : null;
    let tierName = tier?.name || "";
    if (!tierName && ticket.orderId) {
      const ord = await Order.findById(ticket.orderId).select("tierName").lean();
      tierName = ord?.tierName || "";
    }

    // Nombre del club: mismo criterio que /my-tickets/full (Club por event.club; si no, el User creador)
    let clubName = "";
    if (ev?.club) {
      const c = await Club.findById(ev.club).select("name").lean();
      clubName = c?.name || "";
    }
    if (!clubName && ev?.createdBy) {
      const u = await User.findById(ev.createdBy).select("entityName entName displayName username").lean();
      clubName = u?.entityName || u?.entName || u?.displayName || u?.username || "";
    }

    // Primera apertura del enlace
    if (!ticket.claimedAt) {
      await Ticket.updateOne({ _id: ticket._id, claimedAt: null }, { $set: { claimedAt: new Date() } });
    }

    const serial = ticket.serial;
    return res.json({
      ok: true,
      serial,
      qrPayload: JSON.stringify({ serial, token: makeToken(serial) }),
      status: ticket.status, // 'issued' | 'checked_in'
      assignedToName: ticket.assignedToName || "",
      tierName,
      event: {
        title: ev?.title || "",
        startAt: ev?.startAt || ev?.date || null,
        city: ev?.city || "",
        street: ev?.street || "",
        imageUrl: ev ? absUrlFromUpload(req, ev.image) : null,
      },
      club: { name: clubName },
    });
  } catch (err) {
    console.error("[GET /tickets/claim/:claimToken] error:", err?.message || err);
    return res.status(500).json({ ok: false, reason: "server_error" });
  }
});

// GET /api/events/:id/has-ticket -> { hasTicket: bool }
// Lo usa el Detalle al cargar y al volver de Stripe.
router.get("/:id/has-ticket", optionalUserId, async (req, res) => {
  try {
    const eventId = String(req.params.id || "").trim();
    if (!eventId) return res.status(400).json({ hasTicket: false });

    const buyerIds = [req.firebaseUser?.uid, req.user?.id].filter(Boolean);
    if (buyerIds.length === 0) return res.json({ hasTicket: false });

    // Tiene entrada si la compró (Order pagada) O si se la han asignado (Ticket)
    const [order, assigned] = await Promise.all([
      Order.findOne({ eventId, userId: { $in: buyerIds }, status: "paid" }).select("_id").lean(),
      Ticket.findOne({ eventId, assignedToUserId: { $in: buyerIds }, status: { $ne: "refunded" } })
        .select("_id")
        .lean(),
    ]);

    return res.json({ hasTicket: !!(order || assigned) });
  } catch (err) {
    console.error("[GET /events/:id/has-ticket] error:", err);
    return res.status(500).json({ hasTicket: false });
  }
});

/* ------------------------------------------------------------------
   TIERS — pop-up de selección de entrada
   Siempre devuelve la misma forma de datos, aunque el evento sea legacy.
------------------------------------------------------------------- */
router.get("/:id/tiers", optionalUserId, async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }

    const event = await Event.findById(id)
      .select(
        "_id price capacity ticketsSold ticketsReserved ticketTiers currency platformFeeEUR"
      )
      .lean();

    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    // El mismo cálculo de comisión que payments.js
    const platformFeeEUR =
      event.platformFeeEUR != null && event.platformFeeEUR !== ""
        ? Number(event.platformFeeEUR)
        : 1.5;

    const activeTiers = (event.ticketTiers || []).filter((t) => t.active !== false);
    const hasTiers = activeTiers.length > 0;

    let tiers;

    if (hasTiers) {
      const sorted = [...event.ticketTiers].sort(
        (a, b) => (a.order ?? 0) - (b.order ?? 0)
      );
      const seenNames = new Set();

      tiers = sorted.map((tier) => {
        const rem =
          !tier.quantity || tier.quantity <= 0
            ? Infinity
            : Math.max(0, tier.quantity - (tier.sold || 0) - (tier.reserved || 0));

        const remaining = rem === Infinity ? null : rem;
        const soldOut = remaining !== null && remaining <= 0;

        // isNext: primer tier comprable de cada nombre distinto
        let isNext = false;
        if (!soldOut && !seenNames.has(tier.name)) {
          isNext = true;
          seenNames.add(tier.name);
        }

        return {
          tierId:      tier.tierId,
          name:        tier.name,
          description: tier.description || "",
          priceEUR:    tier.priceEUR,
          remaining,
          soldOut,
          isNext,
          order: tier.order ?? 0,
        };
      });
    } else {
      // Tier sintético a partir de price/capacity legacy
      const committed = (event.ticketsSold || 0) + (event.ticketsReserved || 0);
      const rem =
        event.capacity > 0
          ? Math.max(0, event.capacity - committed)
          : Infinity;
      const remaining = rem === Infinity ? null : rem;
      const soldOut = remaining !== null && remaining <= 0;

      tiers = [
        {
          tierId:      "legacy",
          name:        "Entrada",
          description: "",
          priceEUR:    event.price || 0,
          remaining,
          soldOut,
          isNext:      !soldOut,
          order:       0,
        },
      ];
    }

    return res.json({
      eventId:       String(event._id),
      hasTiers,
      tiers,
      currency:      event.currency || "eur",
      platformFeeEUR,
    });
  } catch (err) {
    console.error("[GET /events/:id/tiers] error:", err);
    return res
      .status(500)
      .json({ message: "Error obteniendo tiers del evento", error: err.message });
  }
});

/* ------------------------------------------------------------------
   TIERS (portal del club) — incluye sold y reserved.
   Solo el propietario del evento (mismo criterio que updateEventHandler).
------------------------------------------------------------------- */
router.get("/:id/tiers/admin", anyAuth, ensureUserId, async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }

    const event = await Event.findById(id)
      .select("_id createdBy price capacity ticketsSold ticketsReserved ticketTiers currency platformFeeEUR")
      .lean();
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    if (!event.createdBy || event.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: "No tienes permiso para ver este evento" });
    }

    const tiers = [...(event.ticketTiers || [])]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((t) => {
        const unlimited = !t.quantity || t.quantity <= 0;
        const sold = t.sold || 0;
        const reserved = t.reserved || 0;
        return {
          tierId:      t.tierId,
          name:        t.name,
          description: t.description || "",
          priceEUR:    t.priceEUR,
          quantity:    t.quantity,
          sold,
          reserved,
          remaining:   unlimited ? null : Math.max(0, t.quantity - sold - reserved),
          order:       t.order ?? 0,
          active:      t.active !== false,
          salesStart:  t.salesStart || null,
          salesEnd:    t.salesEnd || null,
        };
      });

    return res.json({
      eventId:         String(event._id),
      hasTiers:        tiers.some((t) => t.active),
      tiers,
      price:           event.price,
      capacity:        event.capacity || 0,
      ticketsSold:     event.ticketsSold || 0,
      ticketsReserved: event.ticketsReserved || 0,
      currency:        event.currency || "eur",
      platformFeeEUR:
        event.platformFeeEUR != null && event.platformFeeEUR !== ""
          ? Number(event.platformFeeEUR)
          : 1.5,
    });
  } catch (err) {
    console.error("[GET /events/:id/tiers/admin] error:", err);
    return res
      .status(500)
      .json({ message: "Error obteniendo tiers del evento", error: err.message });
  }
});

router.get("/:id/attendees", (req, res) => attendeesHandler(req, res, false));
router.get("/:id/attendees/populated", (req, res) => attendeesHandler(req, res, true));

/* ------------------------------------------------------------------
   DETALLE DE EVENTO (público; calcula isOwner si hay usuario)
------------------------------------------------------------------- */
/* ------------------------------------------------------------------
   QR DEL LOCAL (solo quien gestiona el evento)
   GET /api/events/:id/qr -> { eventId, qrToken, qrPayload }
   El qrToken es la prueba de presencia de las misiones: NO sale en ninguna
   ruta pública (Event.qrToken es select:false). El portal lo pide aquí para
   pintar el QR del evento.
------------------------------------------------------------------- */
router.get("/:id/qr", anyAuth, ensureUserId, async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }

    const event = await Event.findById(id).select("+qrToken createdBy club clubId");
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    if (!(await canManageEvent(req, event))) {
      return res.status(403).json({ message: "No tienes permiso para ver el QR de este evento" });
    }

    // Backfill para eventos antiguos sin qrToken (aquí sí está cargado: no regenera uno existente)
    if (!event.qrToken) {
      event.qrToken = new mongoose.Types.ObjectId().toString();
      await event.save();
    }

    return res.json({
      eventId: String(event._id),
      qrToken: event.qrToken,
      qrPayload: `NV_EVENT:${event._id}:${event.qrToken}`,
    });
  } catch (e) {
    console.error("[GET /events/:id/qr] error:", e);
    return res.status(500).json({ message: "Error obteniendo el QR del evento" });
  }
});

/* ------------------------------------------------------------------
   ROTAR EL QR DEL LOCAL (solo quien gestiona el evento)
   POST /api/events/:id/qr/rotate -> { eventId, qrToken, qrPayload }
   Genera un qrToken nuevo: el QR anterior (impreso o filtrado) deja de valer
   al instante. Hay que volver a imprimir el QR. Los escaneos ya registrados
   (QrScan) siguen contando durante su ventana de 4 h.
------------------------------------------------------------------- */
router.post("/:id/qr/rotate", anyAuth, ensureUserId, async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }

    const event = await Event.findById(id).select("+qrToken createdBy club clubId");
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    if (!(await canManageEvent(req, event))) {
      return res.status(403).json({ message: "No tienes permiso para cambiar el QR de este evento" });
    }

    event.qrToken = crypto.randomBytes(16).toString("hex");
    await event.save();

    console.log("[qr] qrToken rotado", { eventId: String(event._id), by: req.user?.id || null });

    return res.json({
      eventId: String(event._id),
      qrToken: event.qrToken,
      qrPayload: `NV_EVENT:${event._id}:${event.qrToken}`,
    });
  } catch (e) {
    console.error("[POST /events/:id/qr/rotate] error:", e);
    return res.status(500).json({ message: "Error cambiando el QR del evento" });
  }
});

router.get("/:id", optionalUserId, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id).populate(
      "createdBy",
      "username email profilePicture displayName"
    );
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    // ⚠️ Ruta PÚBLICA: sin qrToken ni qrPayload (secreto del QR del local).
    // El portal lo obtiene en GET /api/events/:id/qr (solo quien gestiona el evento).
    const obj = event.toObject();
    delete obj.qrToken;

    const formattedEvent = {
      ...obj,
      imageUrl: absUrlFromUpload(req, obj.image),
      photos: approvedOnly(obj.photos).map((p) => toPhotoTileAbs(req, p, req.user?.id || null)).filter(Boolean),
      createdBy: obj.createdBy
        ? {
            ...obj.createdBy,
            profilePictureUrl: absUrlFromUpload(req, obj.createdBy.profilePicture),
          }
        : null,
      categories: Array.isArray(obj.categories)
        ? obj.categories
        : parseCategoriesMaybe(obj.categories),
    };

    const userId = req.user ? req.user.id : null; // si algún middleware previo lo puso
    const isOwner = userId && obj.createdBy?._id?.toString() === userId;

    res.json({ ...formattedEvent, isOwner });
  } catch (error) {
    console.error("Error al obtener el evento:", error);
    res.status(500).json({ message: "Error al obtener el evento", error });
  }
});

/* ------------------------------------------------------------------
   ELIMINAR EVENTO (requiere usuario y ser owner)
------------------------------------------------------------------- */
router.delete("/:id", anyAuth, ensureUserId, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    if (event.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: "No tienes permiso para eliminar este evento" });
    }

    await Event.findByIdAndDelete(req.params.id);
    res.json({ message: "Evento eliminado correctamente" });
  } catch (error) {
    console.error("Error al eliminar el evento:", error);
    res.status(500).json({ message: "Error interno del servidor" });
  }
});

/* ------------------------------------------------------------------
   GALERÍA: GET fotos (y alias)
------------------------------------------------------------------- */
async function getPhotosHandler(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }
    const event = await Event.findById(id).lean();
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    const photos = approvedOnly(event.photos)
      .map((p) => toPhotoTileAbs(req, p, req.user?.id || null))
      .filter(Boolean);

    return res.json({ photos });
  } catch (e) {
    console.error("[GET photos] error:", e);
    return res.status(500).json({ message: "Error obteniendo fotos" });
  }
}

router.get("/:id/photos", optionalUserId, getPhotosHandler);
router.get("/:id/gallery", optionalUserId, getPhotosHandler);
router.get("/:id/images", optionalUserId, getPhotosHandler);
router.get("/:id/media", optionalUserId, getPhotosHandler);

router.post(
  "/:id/photos/:photoId/react",
  anyAuth,
  ensureUserId,
  async (req, res) => {
    try {
      const { id, photoId } = req.params;
      const reactionType = (req.body?.type || "").toString().trim();

      if (!mongoose.isValidObjectId(id)) {
        return res.status(400).json({ message: "ID de evento inválido" });
      }

      const allowed = ["hype", "love", "party", "energy"];

      if (!allowed.includes(reactionType)) {
        return res.status(400).json({ message: "Reacción inválida" });
      }

      const event = await Event.findById(id);
      if (!event) {
        return res.status(404).json({ message: "Evento no encontrado" });
      }

      const idx = (event.photos || []).findIndex(
        (p) =>
          p &&
          typeof p === "object" &&
          String(p.photoId || "") === String(photoId)
      );

      if (idx === -1) {
        return res.status(404).json({ message: "Foto no encontrada" });
      }

      const photo = event.photos[idx];

      photo.reactions = Array.isArray(photo.reactions)
        ? photo.reactions
        : [];

      const existingIndex = photo.reactions.findIndex(
        (r) => String(r.userId || "") === String(req.user.id)
      );

      let userReaction = reactionType;

      // toggle same reaction
      if (
        existingIndex !== -1 &&
        String(photo.reactions[existingIndex].type) === reactionType
      ) {
        photo.reactions.splice(existingIndex, 1);
        userReaction = null;
      } else {
        if (existingIndex !== -1) {
          photo.reactions.splice(existingIndex, 1);
        }

        photo.reactions.push({
          userId: req.user.id,
          type: reactionType,
          createdAt: new Date(),
        });
      }

      await event.save();

      // --- Notification for reaction on photo ---
      await createPhotoReactionNotification({
        req,
        event,
        photo,
        reactionType,
        userReaction,
      });

      const summary = summarizePhotoReactions(photo.reactions || []);

      return res.json({
        ok: true,
        photoId,
        reactions: summary.counts,
        reactionsTotal: summary.total,
        myReaction: userReaction,
      });
    } catch (e) {
      console.error("[POST /events/:id/photos/:photoId/react] error:", e);
      return res.status(500).json({
        message: "Error reaccionando a la foto",
      });
    }
  }
);

/* ------------------------------------------------------------------
   FIRMAS DE FOTOS (firmar / quitar firma)
------------------------------------------------------------------- */

// Firmar una foto: deja tu firma en un punto (x,y relativos 0..1)
router.post(
  "/:id/photos/:photoId/sign",
  anyAuth,
  ensureUserId,
  async (req, res) => {
    try {
      const { id, photoId } = req.params;

      if (!mongoose.isValidObjectId(id)) {
        return res.status(400).json({ message: "ID de evento inválido" });
      }

      let x = Number(req.body?.x);
      let y = Number(req.body?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return res.status(400).json({ message: "Coordenadas inválidas" });
      }
      x = Math.min(1, Math.max(0, x));
      y = Math.min(1, Math.max(0, y));

      const event = await Event.findById(id);
      if (!event) {
        return res.status(404).json({ message: "Evento no encontrado" });
      }

      const idx = (event.photos || []).findIndex(
        (p) =>
          p &&
          typeof p === "object" &&
          String(p.photoId || "") === String(photoId)
      );
      if (idx === -1) {
        return res.status(404).json({ message: "Foto no encontrada" });
      }

      const photo = event.photos[idx];
      photo.signatures = Array.isArray(photo.signatures)
        ? photo.signatures
        : [];

      // snapshot del usuario para pintar la firma sin populate
      const user = await User.findById(req.user.id).select(
        "username phoneNumber profilePicture"
      );
      const username = usernameFromUserDoc(user) || "";
      const profilePicture = user?.profilePicture || "";

      const existingIndex = photo.signatures.findIndex(
        (s) => String(s.userId || "") === String(req.user.id)
      );

      if (existingIndex !== -1) {
        // ya firmó: actualiza posición y refresca snapshot
        photo.signatures[existingIndex].x = x;
        photo.signatures[existingIndex].y = y;
        photo.signatures[existingIndex].username = username;
        photo.signatures[existingIndex].profilePicture = profilePicture;
      } else {
        photo.signatures.push({
          userId: req.user.id,
          username,
          profilePicture,
          x,
          y,
          createdAt: new Date(),
        });
      }

      await event.save();

      const shaped = shapePhotoSignatures(req, photo.signatures, req.user.id);
      return res.json({
        ok: true,
        photoId,
        signatures: shaped.signatures,
        signatureCount: shaped.signatureCount,
        mySignature: shaped.mySignature,
      });
    } catch (e) {
      console.error("[POST /events/:id/photos/:photoId/sign] error:", e);
      return res.status(500).json({ message: "Error firmando la foto" });
    }
  }
);

// Quitar tu firma de una foto
router.delete(
  "/:id/photos/:photoId/sign",
  anyAuth,
  ensureUserId,
  async (req, res) => {
    try {
      const { id, photoId } = req.params;

      if (!mongoose.isValidObjectId(id)) {
        return res.status(400).json({ message: "ID de evento inválido" });
      }

      const event = await Event.findById(id);
      if (!event) {
        return res.status(404).json({ message: "Evento no encontrado" });
      }

      const idx = (event.photos || []).findIndex(
        (p) =>
          p &&
          typeof p === "object" &&
          String(p.photoId || "") === String(photoId)
      );
      if (idx === -1) {
        return res.status(404).json({ message: "Foto no encontrada" });
      }

      const photo = event.photos[idx];
      photo.signatures = Array.isArray(photo.signatures)
        ? photo.signatures
        : [];

      const existingIndex = photo.signatures.findIndex(
        (s) => String(s.userId || "") === String(req.user.id)
      );
      if (existingIndex !== -1) {
        photo.signatures.splice(existingIndex, 1);
        await event.save();
      }

      const shaped = shapePhotoSignatures(req, photo.signatures, req.user.id);
      return res.json({
        ok: true,
        photoId,
        signatures: shaped.signatures,
        signatureCount: shaped.signatureCount,
        mySignature: null,
      });
    } catch (e) {
      console.error("[DELETE /events/:id/photos/:photoId/sign] error:", e);
      return res.status(500).json({ message: "Error quitando la firma" });
    }
  }
);

/* ------------------------------------------------------------------
   MODERACIÓN DE FOTOS (solo propietario/club)
------------------------------------------------------------------- */

// Listar fotos por estado (default: pending)
router.get("/:id/photos/moderation", anyAuth, ensureUserId, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }

    const event = await Event.findById(id).lean();
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    // Solo propietario puede moderar
    if (event.createdBy?.toString?.() !== req.user.id) {
      return res.status(403).json({ message: "No tienes permiso para moderar fotos de este evento" });
    }

    const status = (req.query.status || "pending").toString();
    const all = Array.isArray(event.photos) ? event.photos : [];

    const filtered = all.filter((p) => {
      if (!p || typeof p !== "object") return false;
      const st = String(p.status || "approved");
      return st === status;
    });

    const out = filtered.map((p) => ({
      photoId: p.photoId || "",
      url: buildEventPhotoAccessUrl(req, id, p.photoId || ""),
      rawUrl: rawPhotoValue(p),
      by: p.by || null,
      byUsername: p.byUsername || null,
      uploadedAt: p.uploadedAt || null,
      status: p.status || "approved",
      reviewedBy: p.reviewedBy || null,
      reviewedAt: p.reviewedAt || null,
      reviewNote: p.reviewNote || "",
      missionType: p.missionType || null,
      missionId: p.missionId || null,
      missionTitle: p.missionTitle || null,
      missionDescription: p.missionDescription || null,
      missionCurrent: p.missionCurrent ?? null,
      missionTarget: p.missionTarget ?? null,
      levelNumber: p.levelNumber ?? null,
      viaQrScan: !!p.viaQrScan,
      validatedForMissionType: p.validatedForMissionType || null,
      validatedForMissionId: p.validatedForMissionId || null,
      validatedForMissionTitle: p.validatedForMissionTitle || null,
      validatedForLevelNumber: p.validatedForLevelNumber ?? null,
      validationResult: p.validationResult || null,
    }));

    return res.json({ eventId: id, status, photos: out, count: out.length });
  } catch (e) {
    console.error("[GET /events/:id/photos/moderation] error:", e);
    return res.status(500).json({ message: "Error obteniendo fotos para moderación" });
  }
});

// Aprobar foto (cuenta para subir de nivel)
router.post("/:id/photos/:photoId/approve", anyAuth, ensureUserId, async (req, res) => {
  try {
    const { id, photoId } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }

    const event = await Event.findById(id);
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    if (event.createdBy?.toString?.() !== req.user.id) {
      return res.status(403).json({ message: "No tienes permiso para moderar fotos de este evento" });
    }

    const idx = (event.photos || []).findIndex((p) => p && typeof p === "object" && String(p.photoId || "") === String(photoId));
    if (idx === -1) return res.status(404).json({ message: "Foto no encontrada" });

    const note = (req.body?.reviewNote || "").toString();
    const validationMeta = extractPhotoValidationMeta(req.body || {});
    // Re-aprobar una foto ya aprobada no debe volver a sumar a la misión
    const wasApproved = event.photos[idx].status === "approved";

    event.photos[idx].status = "approved";
    event.photos[idx].reviewedBy = req.user.id;
    event.photos[idx].reviewedAt = new Date();
    event.photos[idx].reviewNote = note;
    event.photos[idx].validatedForMissionType = validationMeta.validatedForMissionType;
    event.photos[idx].validatedForMissionId = validationMeta.validatedForMissionId;
    event.photos[idx].validatedForMissionTitle = validationMeta.validatedForMissionTitle;
    event.photos[idx].validatedForLevelNumber = validationMeta.validatedForLevelNumber;
    event.photos[idx].validationResult = validationMeta.validationResult || "matched";

    await event.save();

    const approvedPhoto = event.photos[idx];

    // Notifications: avisar a asistentes cuando una foto pasa a estar visible.
    await createNewEventPhotoNotifications({
      req,
      event,
      photo: approvedPhoto,
    });

    // Promotions: solo cuenta cuando está aprobada, una sola vez, y SOLO para la
    // misión que lleva la foto (sin missionId = foto del muro: no avanza nada).
    const clubId = event.createdBy ? event.createdBy.toString() : null;
    const uploaderId = approvedPhoto.by ? approvedPhoto.by.toString() : null;
    if (clubId && uploaderId && !wasApproved) {
      await syncPromotionAfterPhotoApproved({
        userId: uploaderId,
        clubId,
        eventId: id,
        missionType:
          approvedPhoto.validatedForMissionType ||
          approvedPhoto.missionType ||
          null,
        missionKey:
          approvedPhoto.validatedForMissionId ||
          approvedPhoto.missionId ||
          null,
        missionTitle:
          approvedPhoto.validatedForMissionTitle ||
          approvedPhoto.missionTitle ||
          null,
        levelNumber:
          approvedPhoto.validatedForLevelNumber ??
          approvedPhoto.levelNumber ??
          null,
      });
    }

    return res.json({
      ok: true,
      photo: {
        photoId: event.photos[idx].photoId,
        url: buildEventPhotoAccessUrl(req, id, event.photos[idx].photoId),
        rawUrl: rawPhotoValue(event.photos[idx]),
        status: event.photos[idx].status,
        reviewedBy: event.photos[idx].reviewedBy,
        reviewedAt: event.photos[idx].reviewedAt,
        reviewNote: event.photos[idx].reviewNote,
        missionType: event.photos[idx].missionType || null,
        missionId: event.photos[idx].missionId || null,
        missionTitle: event.photos[idx].missionTitle || null,
        levelNumber: event.photos[idx].levelNumber ?? null,
        validatedForMissionType: event.photos[idx].validatedForMissionType || null,
        validatedForMissionId: event.photos[idx].validatedForMissionId || null,
        validatedForMissionTitle: event.photos[idx].validatedForMissionTitle || null,
        validatedForLevelNumber: event.photos[idx].validatedForLevelNumber ?? null,
        validationResult: event.photos[idx].validationResult || null,
      },
    });
  } catch (e) {
    console.error("[POST /events/:id/photos/:photoId/approve] error:", e);
    return res.status(500).json({ message: "Error aprobando foto" });
  }
});

// Rechazar foto (NO cuenta para subir de nivel)
router.post("/:id/photos/:photoId/reject", anyAuth, ensureUserId, async (req, res) => {
  try {
    const { id, photoId } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }

    const event = await Event.findById(id);
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    if (event.createdBy?.toString?.() !== req.user.id) {
      return res.status(403).json({ message: "No tienes permiso para moderar fotos de este evento" });
    }

    const idx = (event.photos || []).findIndex((p) => p && typeof p === "object" && String(p.photoId || "") === String(photoId));
    if (idx === -1) return res.status(404).json({ message: "Foto no encontrada" });

    const note = (req.body?.reviewNote || "").toString();
    const validationMeta = extractPhotoValidationMeta(req.body || {});

    event.photos[idx].status = "rejected";
    event.photos[idx].reviewedBy = req.user.id;
    event.photos[idx].reviewedAt = new Date();
    event.photos[idx].reviewNote = note;
    event.photos[idx].validatedForMissionType = validationMeta.validatedForMissionType;
    event.photos[idx].validatedForMissionId = validationMeta.validatedForMissionId;
    event.photos[idx].validatedForMissionTitle = validationMeta.validatedForMissionTitle;
    event.photos[idx].validatedForLevelNumber = validationMeta.validatedForLevelNumber;
    event.photos[idx].validationResult = validationMeta.validationResult || "not_matched";

    await event.save();

    return res.json({
      ok: true,
      photo: {
        photoId: event.photos[idx].photoId,
        url: buildEventPhotoAccessUrl(req, id, event.photos[idx].photoId),
        rawUrl: rawPhotoValue(event.photos[idx]),
        status: event.photos[idx].status,
        reviewedBy: event.photos[idx].reviewedBy,
        reviewedAt: event.photos[idx].reviewedAt,
        reviewNote: event.photos[idx].reviewNote,
        missionType: event.photos[idx].missionType || null,
        missionId: event.photos[idx].missionId || null,
        missionTitle: event.photos[idx].missionTitle || null,
        levelNumber: event.photos[idx].levelNumber ?? null,
        validatedForMissionType: event.photos[idx].validatedForMissionType || null,
        validatedForMissionId: event.photos[idx].validatedForMissionId || null,
        validatedForMissionTitle: event.photos[idx].validatedForMissionTitle || null,
        validatedForLevelNumber: event.photos[idx].validatedForLevelNumber ?? null,
        validationResult: event.photos[idx].validationResult || null,
      },
    });
  } catch (e) {
    console.error("[POST /events/:id/photos/:photoId/reject] error:", e);
    return res.status(500).json({ message: "Error rechazando foto" });
  }
});

// Acceso/proxy a una foto concreta del evento para evitar problemas de CORS
router.get("/:id/photos/:photoId/file", anyAuth, ensureUserId, async (req, res) => {
  try {
    const { id, photoId } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }

    const event = await Event.findById(id).lean();
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    if (event.createdBy?.toString?.() !== req.user.id) {
      return res.status(403).json({ message: "No tienes permiso para ver fotos de este evento" });
    }

    const photo = (event.photos || []).find(
      (p) => p && typeof p === "object" && String(p.photoId || "") === String(photoId)
    );
    if (!photo) {
      return res.status(404).json({ message: "Foto no encontrada" });
    }

    let raw = rawPhotoValue(photo);
    if (!raw) {
      return res.status(404).json({ message: "Ruta de foto no disponible" });
    }

    if (typeof raw !== "string") raw = String(raw);
    raw = raw.trim();

    // Si es una URL del propio backend que apunta a /uploads, la convertimos a path local.
    if (raw.startsWith("http")) {
      const idx = raw.indexOf("/uploads/");
      if (idx !== -1) {
        raw = raw.substring(idx + 1); // -> uploads/...
      }
    }

    // Caso 1: archivo local dentro de /uploads
    if (!raw.startsWith("http")) {
      const rel = raw.replace(/^\/+/, "");
      const abs = path.join(__dirname, "..", rel);
      const uploadsRoot = path.join(__dirname, "..", "uploads");

      if (!abs.startsWith(uploadsRoot)) {
        return res.status(400).json({ message: "Ruta de foto inválida" });
      }
      if (!fs.existsSync(abs)) {
        return res.status(404).json({ message: "Archivo no encontrado" });
      }

      return res.sendFile(abs);
    }

    // Caso 2: URL externa -> proxy server-side para evitar CORS en el frontend
    const upstream = await fetch(raw);
    if (!upstream.ok) {
      return res.status(404).json({ message: "No se pudo obtener la foto remota" });
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const arrayBuffer = await upstream.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.send(buffer);
  } catch (e) {
    console.error("[GET /events/:id/photos/:photoId/file] error:", e);
    return res.status(500).json({ message: "Error obteniendo la foto" });
  }
});

/* ------------------------------------------------------------------
   GALERÍA: POST subir fotos (y alias)
   - Acepta múltiples campos: file/files/files[]/photo/photos/photos[]/image/images/images[]
   - Requiere usuario
------------------------------------------------------------------- */
async function postPhotosHandler(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }
    const event = await Event.findById(id);
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    // Recoge archivos subidos, sin importar el nombre del campo
    const files = (req.files && Array.isArray(req.files) ? req.files : [])
      .concat(req.file ? [req.file] : []);

    if (!files.length) {
      return res.status(400).json({ message: "No se recibieron archivos" });
    }

    // ---- Misión: la decide el SERVIDOR, no el cliente ----
    // Del cuerpo solo se toma el missionId (= missionKey). Tipo, título, objetivo
    // y nivel salen del progreso real. Sin missionId: foto del muro, sin misión.
    const requestedMissionId = extractPhotoMissionMeta(req.body || {}).missionId;
    let missionMeta = {
      missionType: null,
      missionId: null,
      missionTitle: null,
      missionDescription: null,
      missionCurrent: null,
      missionTarget: null,
      levelNumber: null,
    };

    if (requestedMissionId) {
      const resolved = await resolvePhotoMissionForUpload({
        userId: req.user.id,
        event,
        missionKey: requestedMissionId,
      });
      if (!resolved) {
        cleanupUploadedFiles(files);
        return res.status(400).json({
          error: "invalid_mission",
          message: "Esa misión no existe, no es de tu nivel actual, no es de foto o ya está completada",
        });
      }

      // Presencia: escaneo del QR de ESTE evento en las últimas 4 h
      if (!(await hasRecentQrScan(req.user.id, event._id))) {
        cleanupUploadedFiles(files);
        return res.status(403).json({
          error: "scan_required",
          message: "Escanea el QR del local para subir fotos de misión",
        });
      }

      missionMeta = { ...missionMeta, ...resolved };
    }

    // Datos del usuario que sube
    let byUsername = "usuario";
    try {
      const userDoc = await User.findById(req.user.id).lean();
      const u = usernameFromUserDoc(userDoc);
      if (u) byUsername = u;
    } catch (_) {}

    // Carpeta para fotos de evento
    const eventPhotosDir = path.join(ROOT_UPLOADS_DIR, "event-photos");
    ensureDir(eventPhotosDir);

    const savedMeta = [];
    for (const f of files) {
      const base = `event-${id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const processed = await processImageToJpg(f.path, eventPhotosDir, base);
      const rel = path
        .relative(path.join(__dirname, ".."), processed)
        .replace(/\\/g, "/"); // ej: "uploads/event-photos/event-xxx.jpg"

      const meta = {
        photoId: `evtphoto_${new mongoose.Types.ObjectId().toString()}`,
        url: rel,
        by: req.user.id,
        byUsername,
        uploadedAt: new Date(),

        status: "pending",
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: "",

        missionType: missionMeta.missionType,
        missionId: missionMeta.missionId,
        missionTitle: missionMeta.missionTitle,
        levelNumber: missionMeta.levelNumber,
        missionDescription: missionMeta.missionDescription,
        missionCurrent: missionMeta.missionCurrent,
        missionTarget: missionMeta.missionTarget,
        viaQrScan: req.viaQrScan === true,
        validatedForMissionType: null,
        validatedForMissionId: null,
        validatedForMissionTitle: null,
        validatedForLevelNumber: null,
        validationResult: null,
        reactions: [],
      };

      event.photos = Array.isArray(event.photos) ? event.photos : [];
      event.photos.push(meta);
      savedMeta.push(meta);
    }

    await event.save();
    // NO promociones aquí; solo al aprobar

    // Respuesta: objetos con url absoluta + byUsername
    const uploaded = savedMeta.map((m) => ({
      photoId: m.photoId,
      url: absUrlFromUpload(req, m.url),
      byUsername: m.byUsername,
      uploadedAt: m.uploadedAt,
      status: m.status,
      missionType: m.missionType || null,
      missionId: m.missionId || null,
      missionTitle: m.missionTitle || null,
      levelNumber: m.levelNumber ?? null,
      viaQrScan: !!m.viaQrScan,
      validatedForMissionType: m.validatedForMissionType || null,
      validatedForMissionId: m.validatedForMissionId || null,
      validatedForMissionTitle: m.validatedForMissionTitle || null,
      validatedForLevelNumber: m.validatedForLevelNumber ?? null,
      validationResult: m.validationResult || null,
    }));

    const allPhotos = approvedOnly(event.photos)
      .map((p) => toPhotoTileAbs(req, p, req.user?.id || null))
      .filter(Boolean);

    return res.status(201).json({
      uploaded,        // recién subidas (con autor)
      photos: allPhotos, // estado completo de galería (con autor cuando exista)
      count: uploaded.length,
    });
  } catch (e) {
    console.error("[POST photos] error:", e);
    return res.status(500).json({ message: "Error subiendo fotos", error: e.message });
  }
}

// Acepta cualquier campo / array (evita que Flutter tenga que adivinar)
router.post("/:id/photos", anyAuth, ensureUserId, uploadAny.any(), postPhotosHandler);
router.post("/:id/photos/upload", anyAuth, ensureUserId, uploadAny.any(), postPhotosHandler);
router.post("/:id/upload-photo", anyAuth, ensureUserId, uploadAny.any(), postPhotosHandler);

/* ------------------------------------------------------------------
   GALERÍA: DELETE foto(s) (solo propietario)
------------------------------------------------------------------- */
router.delete("/:id/photos/:pid?", anyAuth, ensureUserId, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }

    const event = await Event.findById(id);
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    // Solo el propietario puede borrar fotos
    if (event.createdBy?.toString() !== req.user.id) {
      return res.status(403).json({ message: "No tienes permiso para borrar fotos de este evento" });
    }

    // Normalizar parámetros
    const q = { ...req.query, ...req.body };
    const pid = req.params.pid; // opcional
    let idx = q.idx ?? undefined;
    let url = q.url ?? undefined;
    if (typeof idx === "string" && idx.trim() !== "") idx = Number(idx);

    const photos = Array.isArray(event.photos) ? event.photos : [];

    // Resolver índice a borrar
    let targetIndex = -1;

    if (Number.isInteger(idx) && idx >= 0 && idx < photos.length) {
      targetIndex = idx;
    } else {
      // Por URL o photoId (soportar absoluta o relativa)
      const search = (pid && pid !== "undefined") ? pid : url;
      if (!search) {
        return res.status(400).json({ message: "Debes proporcionar idx o url" });
      }
      const toRel = (v) => {
        if (!v) return "";
        if (typeof v !== "string") v = String(v);
        if (v.startsWith("http")) {
          const i = v.indexOf("/uploads/");
          return i !== -1 ? v.substring(i + 1) : v; // quitar leading slash luego
        }
        return v.replace(/^\/+/, "");
      };
      const needle = toRel(search);
      targetIndex = photos.findIndex((p) => {
        // Match by photoId (new schema)
        if (pid && typeof p === "object" && String(p.photoId || "") === String(needle)) {
          return true;
        }
        const cand = typeof p === "string"
          ? toRel(p)
          : toRel(p?.url || p?.path || p?.image || p?.photo);
        return cand === needle;
      });
      if (targetIndex === -1) {
        return res.status(404).json({ message: "Foto no encontrada" });
      }
    }

    // Extraer info de la foto a borrar
    const removedEntry = photos[targetIndex];
    const relPath = (typeof removedEntry === "string")
      ? removedEntry
      : (removedEntry?.url || removedEntry?.path || removedEntry?.image || removedEntry?.photo || "");

    // Borrar archivo físico si está dentro de /uploads
    try {
      const ROOT = path.join(__dirname, "..");
      const abs = path.join(ROOT, relPath.replace(/^\/+/, ""));
      const uploadsRoot = path.join(ROOT, "uploads");
      if (abs.startsWith(uploadsRoot) && fs.existsSync(abs)) {
        fs.unlinkSync(abs);
      }
    } catch (e) {
      console.warn("[DELETE photo] no se pudo eliminar archivo físico:", e?.message || e);
    }

    // Quitar del array y guardar
    event.photos.splice(targetIndex, 1);
    await event.save();

    // Devolver listado normalizado
    const outPhotos = (event.photos || [])
      .map((p) => toPhotoTileAbs(req, p, req.user?.id || null))
      .filter(Boolean);

    return res.json({
      removed: (typeof removedEntry === "string")
        ? { url: absUrlFromUpload(req, removedEntry) }
        : {
            url: absUrlFromUpload(req, removedEntry?.url || removedEntry?.path || removedEntry?.image || removedEntry?.photo),
            byUsername: removedEntry?.byUsername || null,
            uploadedAt: removedEntry?.uploadedAt || null,
          },
      photos: outPhotos,
    });
  } catch (e) {
    console.error("[DELETE /events/:id/photos] error:", e);
    return res.status(500).json({ message: "Error borrando foto", error: e.message });
  }
});

/* ------------------------------------------------------------------
   ALTERNAR ASISTENCIA (requiere usuario)
   - Alterna en Mongo (campo attendees)
   - Escribe/borra doc en Firestore: attendances/{uid}_{eventId}
------------------------------------------------------------------- */
router.post("/:id/attend", anyAuth, ensureUserId, async (req, res) => {
  const eventId = req.params.id;

  try {
    // 1) Recuperar evento
    if (!mongoose.isValidObjectId(eventId)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }
    const event = await Event.findById(eventId);
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    event.attendees = Array.isArray(event.attendees) ? event.attendees : [];

    // 2) Usuario (Mongo id ya garantizado)
    const userId = req.user.id;

    // 3) Alternar asistencia en Mongo (comparando como string)
    const idx = event.attendees.findIndex((a) => a?.toString?.() === userId);
    let attendedNow = false;

    if (idx !== -1) {
      event.attendees.splice(idx, 1); // quitar
      attendedNow = false;
    } else {
      event.attendees.push(userId); // añadir
      attendedNow = true;
    }

    await event.save();

    // 4) Si viene además como Firebase (teléfono), refleja en Firestore
    const firebaseToken = extractIdToken(req);
    if (firebaseToken) {
      try {
        const decoded = await admin.auth().verifyIdToken(firebaseToken);
        const uid = decoded.uid;
        const phone = decoded.phone_number || decoded.phoneNumber || null;

        const db = admin.firestore();
        const docId = `${uid}_${eventId}`;
        const docRef = db.collection("attendances").doc(docId);

        if (attendedNow) {
          await docRef.set(
            {
              userId: uid,
              userPhone: phone || null,
              eventId,
              eventTitle: event.title || "",
              eventDate: event.date ? new Date(event.date) : null,
              eventImageUrl: absUrlFromUpload(req, event.image),
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        } else {
          await docRef.delete().catch(() => {});
        }
      } catch (e) {
        console.warn("[attend] No se pudo reflejar en Firestore:", e?.message || e);
      }
    }

    // 4.5) Promotions: actualizar progreso por asistencia
    const clubId = event.createdBy ? event.createdBy.toString() : null;
    if (clubId) {
      await syncPromotionAfterAttend({ userId, clubId, eventId, attendedNow });
    }

    // 5) Responder
    return res.json({
      _id: event._id,
      attendees: event.attendees,
    });
  } catch (error) {
    console.error("Error al alternar asistencia:", error);
    res.status(500).json({ message: "Error interno del servidor", error: error.message });
  }
});

/* ==================================================================
   🚀 UPDATE + IMAGEN PRINCIPAL
================================================================== */

// Helpers para update
function sanitizeUpdate(payload) {
  const clean = { ...payload };
  [
    "_id",
    "id",
    "createdAt",
    "updatedAt",
    "__v",
    "createdBy",
    "attendees",
    "photos",
    // Contadores de venta: solo los mueve el sistema (stock.js / webhook)
    "ticketsSold",
    "ticketsReserved",
    // Identidad del QR del evento
    "qrToken",
    // Resultado de la geocodificación: se recalcula más abajo con applyGeo
    "location",
    "geoStatus",
    "geoProvider",
    "geoFormatted",
    "geoUpdatedAt",
    "geoSourceAddress",
  ].forEach((k) => delete clean[k]);
  return clean;
}

async function updateEventHandler(req, res) {
  try {
    const id = req.params.id;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }

    // 1) Buscar evento y verificar ownership
    const event = await Event.findById(id);
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    if (event.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: "No tienes permiso para editar este evento" });
    }

    // 2) Construir update
    const update = sanitizeUpdate(req.body);

    // Normalizar fechas
    const startAt = parseDateMaybe(req.body.startAt || req.body.date);
    const endAt   = parseDateMaybe(req.body.endAt);
    if (startAt) {
      update.startAt = startAt;
      // por compat, si alguien en front aún mira "date"
      update.date = startAt;
    }
    if (endAt) update.endAt = endAt;

    // Normalizar categorías
    if (typeof req.body.categories !== "undefined") {
      update.categories = parseCategoriesMaybe(req.body.categories);
    }

    // age/price a número si aplica
    if (typeof req.body.age !== "undefined") {
      const ageNum = parseNumberMaybe(req.body.age);
      update.age = typeof ageNum === "number" ? ageNum : req.body.age;
    }
    if (typeof req.body.price !== "undefined") {
      const priceNum = parseNumberMaybe(req.body.price);
      update.price = typeof priceNum === "number" ? priceNum : req.body.price;
    }
    // Mantener asociacion owner/club si por algun motivo faltaba en eventos antiguos
    if (!event.clubId) update.clubId = event.createdBy;
    if (!event.club) update.club = event.createdBy;

    // 3) Imagen (si viene multipart)
    if (req.file) {
      const processedDir = ROOT_UPLOADS_DIR;
      const processedImagePath = await processImageToJpg(
        req.file.path,
        processedDir,
        `resized-${Date.now()}-${path.parse(req.file.originalname).name}`
      );
      update.image = path
        .relative(path.join(__dirname, ".."), processedImagePath)
        .replace(/\\/g, "/");
    }

    // Regeocodificar SOLO si la dirección ha cambiado, para no gastar
    // llamadas de más en cada edición.
    const newStreet = update.street !== undefined ? update.street : event.street;
    const newCity   = update.city   !== undefined ? update.city   : event.city;
    const newPostal = update.postalCode !== undefined ? update.postalCode : event.postalCode;
    const newAddress = buildAddress({ street: newStreet, postalCode: newPostal, city: newCity });

    if (newAddress && newAddress !== event.geoSourceAddress) {
      const geo2 = await geocodeAddress({ street: newStreet, postalCode: newPostal, city: newCity });
      applyGeo(update, geo2, newAddress);
    }

    // Tandas: nunca se escribe lo que manda el cliente tal cual (podría
    // traer sold/reserved). Solo la versión saneada y validada.
    const updateFilter = { _id: id };
    const tiersInput = parseTiersInput(req.body.ticketTiers);
    delete update.ticketTiers;
    if (tiersInput.error) {
      return res.status(400).json({ message: tiersInput.error });
    }
    if (tiersInput.value !== undefined) {
      const existingTiers = (event.ticketTiers || []).map((t) =>
        typeof t.toObject === "function" ? t.toObject() : t
      );

      const { tiers, error } = sanitizeTiers(tiersInput.value, existingTiers);
      if (error) return res.status(400).json({ message: error });

      const check = validateTierChanges(tiers, existingTiers);
      if (!check.ok) return res.status(400).json({ message: check.error });

      update.ticketTiers = tiers;
      syncEventPrice(update);

      // Bloqueo optimista: los tiers se reescriben enteros con los sold/reserved
      // leídos arriba. Si una compra los ha movido desde entonces, no escribimos
      // (si no, perderíamos esa venta o reserva en los contadores).
      if (existingTiers.length > 0) {
        updateFilter.$and = existingTiers.map((t) => ({
          ticketTiers: {
            $elemMatch: { tierId: t.tierId, sold: t.sold || 0, reserved: t.reserved || 0 },
          },
        }));
      }
    }

    // 4) Actualizar y devolver formateado
    const updated = await Event.findOneAndUpdate(updateFilter, update, { new: true })
      .populate("createdBy", "username email profilePicture displayName")
      .lean();

    if (!updated) {
      return res.status(409).json({
        message: "Las ventas de este evento han cambiado mientras editabas. Recarga y vuelve a guardar.",
      });
    }

    const formatted = {
      ...updated,
      imageUrl: absUrlFromUpload(req, updated.image),
      photos: approvedOnly(updated.photos).map((p) => toPhotoTileAbs(req, p, req.user?.id || null)).filter(Boolean),
      createdBy: updated.createdBy
        ? {
            ...updated.createdBy,
            profilePictureUrl: absUrlFromUpload(req, updated.createdBy.profilePicture),
          }
        : null,
      categories: Array.isArray(updated.categories)
        ? updated.categories
        : parseCategoriesMaybe(updated.categories),
    };

    return res.json(formatted);
  } catch (err) {
    console.error("[UPDATE /events/:id] error:", err);
    return res
      .status(500)
      .json({ message: "Error actualizando el evento", error: err.message });
  }
}

// PATCH y PUT -> mismo handler
router.patch("/:id", anyAuth, ensureUserId, upload.single("image"), updateEventHandler);
router.put("/:id",   anyAuth, ensureUserId, upload.single("image"), updateEventHandler);

// Subir/cambiar imagen principal
router.post("/:id/image", anyAuth, ensureUserId, upload.single("image"), async (req, res) => {
  try {
    const id = req.params.id;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }

    const event = await Event.findById(id);
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    if (event.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: "No tienes permiso para cambiar la imagen" });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'Falta el archivo "image"' });
    }

    const processedDir = ROOT_UPLOADS_DIR;
    const processedImagePath = await processImageToJpg(
      req.file.path,
      processedDir,
      `resized-${Date.now()}-${path.parse(req.file.originalname).name}`
    );

    const rel = path
      .relative(path.join(__dirname, ".."), processedImagePath)
      .replace(/\\/g, "/");

    event.image = rel;
    await event.save();

    return res.json({
      _id: event._id,
      image: rel,
      imageUrl: absUrlFromUpload(req, rel),
    });
  } catch (err) {
    console.error("[POST /events/:id/image] error:", err);
    return res
      .status(500)
      .json({ message: "Error subiendo imagen", error: err.message });
  }
});

module.exports = router;
// Enlace público del acompañante: index.js lo monta en /api/tickets
module.exports.ticketClaimRouter = ticketClaimRouter;
