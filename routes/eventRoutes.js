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
const ShareLink = require("../models/ShareLink");
const ShareOpen = require("../models/ShareOpen");
const { isPhotoMission } = require("../utils/photoMissions");
const { getTemplatesForClub } = require("../utils/promotionTemplates");
const { reviewPhoto, enqueuePhotoReview, getAutoApproveMin } = require("../utils/photoReview");
const { makeToken } = require("../utils/ticketToken");
const User = require("../models/User");
const Notification = require("../models/Notification");
const { sendPushNotificationToUser } = require("../utils/sendPushNotification");
const { geocodeAddress, applyGeo, buildAddress } = require("../utils/geocode");
const { sanitizeTiers, validateTierChanges, syncEventPrice } = require("../utils/tiers");
const { accessInfo, accessTypeOf, validateAccessType, deriveAccessType } = require("../utils/accessType");
// Nombres públicos: nunca nada derivado del teléfono (utils/publicName.js)
const {
  publicUsername,
  publicDisplayName,
  publicStoredName,
  sanitizePublicUser,
} = require("../utils/publicName");
const { issueTicketsForOrder, sendOrderTicketsEmail } = require("../utils/ticketIssuing");
const {
  sellStockDirect,
  releaseSoldStock,
  tierRemaining,
  capacityRemaining,
  eventAvailability,
} = require("../utils/stock");

/**
 * accessType a guardar al crear/editar un evento, con precio y tandas FINALES.
 *  - Si el cliente lo manda: tiene que ser válido y coherente (si no, 400).
 *  - Si no lo manda (portal sin el campo todavía): se conserva el actual si
 *    sigue siendo coherente; si no, se deduce del precio (paid / free_open).
 * Devuelve { accessType } o { problem: { error, message } }.
 */
/**
 * Aforo (Event.capacity) que llega del cliente. Entero >= 0; 0 = sin límite.
 * undefined -> no viene; null o "" -> 0 (sin límite).
 * Devuelve { value } o { problem }.
 */
function parseCapacityInput(v) {
  if (v === undefined) return { value: undefined };
  if (v === null || (typeof v === "string" && v.trim() === "")) return { value: 0 };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    return {
      problem: {
        error: "invalid_capacity",
        message: "El aforo debe ser un número entero mayor o igual que 0 (0 = sin límite)",
      },
    };
  }
  return { value: n };
}

function resolveAccessTypeForSave(requested, finalState, currentType = null) {
  if (requested !== undefined && requested !== null && String(requested).trim() !== "") {
    const t = String(requested).trim();
    const problem = validateAccessType(t, finalState);
    return problem ? { problem } : { accessType: t };
  }
  if (currentType) {
    const problem = validateAccessType(currentType, finalState);
    if (!problem) return { accessType: currentType };
    // Un free_limited que se queda sin aforo o con tandas es un error del
    // cliente: no se convierte en silencio a free_open.
    if (problem.error === "free_limited_requires_capacity" || problem.error === "free_limited_no_tiers") {
      return { problem };
    }
  }
  return { accessType: deriveAccessType(finalState) };
}

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
    username: s?.userId ? publicStoredName(s?.username, s.userId) : null,
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

    const actor = await User.findById(actorId).select("username displayName phoneNumber profilePicture").lean();
    const actorName = actor ? publicUsername(actor) : "Alguien";

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

function computeLevelProgress(level) {
  const missions = Array.isArray(level?.missions) ? level.missions : [];
  // Nivel sin misiones (p. ej. el 10 del catálogo): completo en cuanto se llega a él
  if (!missions.length) return level?.status === "locked" ? 0 : 1;
  const ratios = missions.map((m) => {
    const target = Number(m.target || 1);
    const cur = Number(m.current || 0);
    if (!target || target <= 0) return 0;
    return Math.max(0, Math.min(1, cur / target));
  });
  return Math.max(0, Math.min(1, ratios.reduce((a, b) => a + b, 0) / ratios.length));
}

function allMissionsCompleted(level) {
  if (!level || level.status === "locked") return false;
  const missions = Array.isArray(level.missions) ? level.missions : [];
  if (!missions.length) return true; // nivel sin misiones: completo al llegar
  return missions.every((m) => m.status === "completed");
}

function unlockNextLevel(progress, completedLevelNumber) {
  // Igual que promotionsController: el siguiente nivel no se abre hasta canjear
  // el premio de este (lo abre redeemCurrentLevelReward). Antes se abría aquí y
  // el controlador lo volvía a bloquear al leer, mientras tanto currentLevel
  // apuntaba a un nivel no alcanzado.
  const completed = (progress.levels || []).find((l) => Number(l.levelNumber) === Number(completedLevelNumber));
  if (completed && completed.rewardRedeemed !== true) {
    progress.currentLevel = Number(completedLevelNumber);
    progress.currentRewardTitle = completed.reward?.title || "";
    return;
  }

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
    if (!isPhotoMission(m)) continue;
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

  // Mismo criterio que promotionsController: las del club si tiene, si no las
  // globales (antes aquí solo globales). Sin ninguna, getTemplatesForClub lo
  // deja en el log.
  const templates = await getTemplatesForClub(clubId, { source: "eventRoutes" });
  if (!templates.length) {
    console.warn("[promotions] progreso NO creado por falta de plantillas", {
      userId: String(userId || ""),
      clubId: String(clubId || ""),
    });
    return null;
  }

  const built = UserClubPromotionProgress.buildFromTemplates({ templates, startLevel: 1 });
  try {
    progress = await UserClubPromotionProgress.create({
      user: userId,
      club: clubId,
      ...built,
    });
  } catch (e) {
    // Dos sincronizaciones a la vez para un usuario sin progreso: la otra ya lo
    // creó (índice único user+club). Usamos el suyo en vez de fallar.
    if (e?.code !== 11000) throw e;
    progress = await UserClubPromotionProgress.findOne({ user: userId, club: clubId });
  }

  return progress;
}

// Qué es "misión de foto" lo decide utils/photoMissions.js (isPhotoMission),
// por LISTA DE TIPOS. Antes se buscaba 'photo'/'foto'/'selfie' en el tipo o el título.

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
    return isPhotoMission(m) && isActivePhotoMissionStatus(m.status);
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
  if (!isPhotoMission(mission)) return null;
  if (String(mission.status || "") === "completed") return null;

  return {
    missionType: mission.type || null,
    missionId: mission.missionKey,
    missionTitle: mission.title || null,
    missionTarget: Number(mission.target || 1),
    missionCurrent: Number(mission.current || 0),
    levelNumber: Number(level.levelNumber),
    // Para la revisión con IA (no se guardan en la foto)
    photoCriteria: String(mission.photoCriteria || ''),
    photoCriteriaExclude: String(mission.photoCriteriaExclude || ''),
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

/* ------------------------------------------------------------------
   MISIONES ACUMULADAS POR CLUB
     - scan_qr:      eventos DISTINTOS del club cuyo QR ha escaneado (QrScan)
     - attend_event: eventos del club donde está marcado como asistente
     - share_event, link_clicks, referred_purchases (referidos)
   Se RECALCULAN desde los datos (idempotente: llamarla de más no cuenta de
   más, y lo que se deshace —reembolso, desmarcar asistencia— se descuenta
   solo). Conteo ACUMULADO en el club: cuenta todo lo hecho en ese club,
   también antes de llegar al nivel, así que 7 eventos escaneados cumplen a la
   vez los niveles de 2, 4 y 7.
------------------------------------------------------------------- */
const REFERRAL_MISSION_TYPES = new Set(["share_event", "link_clicks", "referred_purchases"]);
const ACCUMULATED_MISSION_TYPES = new Set([...REFERRAL_MISSION_TYPES, "scan_qr", "attend_event"]);

// Acumuladas que pueden BAJAR y deshacer una misión completada (en niveles
// cuyo premio aún no se ha canjeado): desmarcar asistencia y reembolsos.
// scan_qr, share_event y link_clicks nunca bajan (los datos no se borran) y
// mantienen la regla de que una misión completada ya no se toca.
const DECREASABLE_MISSION_TYPES = new Set(["attend_event", "referred_purchases"]);

/** uid de Firebase o _id de Mongo -> _id de Mongo (string), o null. */
async function resolveMongoUserId(key) {
  const k = String(key || "").trim();
  if (!k) return null;
  if (/^[a-fA-F0-9]{24}$/.test(k)) {
    const u = await User.findById(k).select("_id").lean();
    if (u) return String(u._id);
  }
  const byUid = await User.findOne({ firebaseUid: k }).select("_id").lean();
  return byUid ? String(byUid._id) : null;
}

/** Eventos del club, con la MISMA clave que el resto del progreso (no los clubId guardados). */
async function eventIdsForClubKey(clubKey) {
  const key = String(clubKey || "");
  if (!key) return [];
  const or = [{ clubId: key }];
  if (/^[a-fA-F0-9]{24}$/.test(key)) or.push({ createdBy: key }, { club: key });
  const events = await Event.find({ $or: or }).select("_id createdBy clubId club").lean();
  return events.filter((e) => promotionClubKeyForEvent(e) === key).map((e) => String(e._id));
}

/** Recuentos acumulados del usuario en el club (todas las misiones acumuladas). */
async function computeAccumulatedCounts({ userId, clubKey }) {
  const me = await User.findById(userId).select("_id firebaseUid email").lean();
  if (!me) return null;
  const myId = String(me._id);
  const keys = [myId, me.firebaseUid].filter(Boolean).map(String); // ShareLink/Order guardan uno u otro
  const myEmail = String(me.email || "").trim().toLowerCase();

  const eventIds = await eventIdsForClubKey(clubKey);
  if (!eventIds.length) {
    return { share_event: 0, link_clicks: 0, referred_purchases: 0, scan_qr: 0, attend_event: 0 };
  }

  const [scannedEvents, attendedEvents, sharedEvents, openers, orders] = await Promise.all([
    // scan_qr: eventos DISTINTOS del club escaneados alguna vez (no escaneos)
    QrScan.distinct("event", { user: me._id, event: { $in: eventIds } }),
    // attend_event: eventos del club donde sigue marcado como asistente
    Event.countDocuments({ _id: { $in: eventIds }, attendees: me._id }),
    // share_event: eventos DISTINTOS del club que ha compartido
    ShareLink.distinct("eventId", { createdByUserId: { $in: keys }, eventId: { $in: eventIds } }),
    // link_clicks: personas DISTINTAS (autenticadas, no él) que abrieron sus enlaces
    ShareOpen.distinct("openerUserId", { sharerUserId: myId, eventId: { $in: eventIds } }),
    // referred_purchases: órdenes PAGADAS (no reembolsadas) con su enlace
    Order.find({ refUserId: { $in: keys }, status: "paid", eventId: { $in: eventIds } })
      .select("userId email")
      .lean(),
  ]);

  // Compradores DISTINTOS: por _id de Mongo (traduciendo uid) o, sin cuenta, por email.
  const uidsToMap = [...new Set(orders.map((o) => String(o.userId || "")).filter((v) => v && !/^[a-fA-F0-9]{24}$/.test(v)))];
  const uidMap = new Map();
  if (uidsToMap.length) {
    const users = await User.find({ firebaseUid: { $in: uidsToMap } }).select("_id firebaseUid").lean();
    for (const u of users) uidMap.set(String(u.firebaseUid), String(u._id));
  }
  const buyers = new Set();
  for (const o of orders) {
    const uid = String(o.userId || "");
    const buyerId = /^[a-fA-F0-9]{24}$/.test(uid) ? uid : uidMap.get(uid) || null;
    const email = String(o.email || "").trim().toLowerCase();
    if (buyerId && (buyerId === myId || keys.includes(uid))) continue; // autorreferencia
    if (!buyerId && email && myEmail && email === myEmail) continue;   // autorreferencia (sin cuenta)
    const buyerKey = buyerId ? `u:${buyerId}` : email ? `e:${email}` : null;
    if (buyerKey) buyers.add(buyerKey);
  }

  return {
    share_event: sharedEvents.length,
    link_clicks: openers.filter((o) => String(o) !== myId).length,
    referred_purchases: buyers.size,
    scan_qr: scannedEvents.length,
    attend_event: attendedEvents,
  };
}

/**
 * Aplica los recuentos a las misiones acumuladas de un nivel.
 *  - Nivel con el premio CANJEADO: congelado, no se toca nada.
 *  - attend_event y referred_purchases (DECREASABLE_MISSION_TYPES): se
 *    recalculan en los dos sentidos; si el recuento baja del objetivo, la
 *    misión completada vuelve a pendiente.
 *  - El resto: una misión completada ya no se toca (sus datos no bajan).
 * En niveles bloqueados se actualiza current (acumulado) pero no se completa:
 * se completa en cuanto el nivel se desbloquea y se sincroniza.
 */
function applyAccumulatedCountsToLevel(level, counts) {
  if (level.rewardRedeemed === true) return; // premio cobrado: nunca se revierte

  for (const m of level.missions || []) {
    if (!ACCUMULATED_MISSION_TYPES.has(m.type)) continue;
    const decreasable = DECREASABLE_MISSION_TYPES.has(m.type);
    if (m.status === "completed" && !decreasable) continue;

    const target = Number(m.target || 1);
    m.current = Math.min(Number(counts[m.type] || 0), target);
    m.updatedAt = new Date();
    if (level.status === "locked") {
      if (m.status === "completed" && m.current < target) {
        m.status = "locked";
        m.completedAt = null;
      }
      continue;
    }

    if (m.current >= target) {
      m.status = "completed";
      m.completedAt = m.completedAt || new Date();
    } else if (m.status !== "pending") {
      m.status = "in_progress";
      m.completedAt = null;
    }
  }
}

/**
 * Recalcula las misiones acumuladas del usuario en el club y guarda.
 * Opciones para scripts (scripts/backfillAccumulatedMissions.js):
 *  - dryRun:   calcula pero NO guarda.
 *  - backfill: no es actividad del usuario: no toca lastActivityAt y solo
 *              guarda si algo cambia.
 * Devuelve { before, after, changed } (fotos del progreso) o { error }.
 */
async function syncAccumulatedMissions({ userId, clubKey, eventId = null, dryRun = false, backfill = false }) {
  if (!/^[a-fA-F0-9]{24}$/.test(String(userId || "")) || !clubKey) return { error: "invalid_ids" };

  // Si otra sincronización guarda el mismo progreso a la vez, Mongoose rechaza
  // la nuestra (VersionError). Como se RECALCULA desde los datos, reintentar
  // con el documento fresco es seguro: no puede contar de más.
  // Espera aleatoria entre intentos para que varias a la vez (escaneos seguidos)
  // no vuelvan a chocar.
  const MAX_ATTEMPTS = 6;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await syncAccumulatedMissionsOnce({ userId, clubKey, eventId, dryRun, backfill });
    } catch (e) {
      if (e?.name === "VersionError" && attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 80 * attempt)));
        continue;
      }
      console.warn("[promotions] syncAccumulatedMissions failed:", e?.message || e);
      return { error: e?.message || String(e) };
    }
  }
}

/** Foto comparable del progreso: nivel actual, contadores y estado de cada misión. */
function snapshotProgress(progress) {
  return {
    currentLevel: Number(progress.currentLevel || 0),
    qrScansInClub: Number(progress.counters?.qrScansInClub || 0),
    attendancesInClub: Number(progress.counters?.attendancesInClub || 0),
    levels: (progress.levels || []).map((l) => ({
      levelNumber: Number(l.levelNumber),
      status: l.status,
      missions: (l.missions || []).map((m) => ({
        missionKey: m.missionKey,
        type: m.type,
        current: Number(m.current || 0),
        target: Number(m.target || 1),
        status: m.status,
      })),
    })),
  };
}

async function syncAccumulatedMissionsOnce({ userId, clubKey, eventId, dryRun = false, backfill = false }) {
  const counts = await computeAccumulatedCounts({ userId, clubKey });
  if (!counts) return { error: "user_not_found" };

  // En scripts no se crea progreso nuevo: solo se repasan los que ya existen.
  const progress = backfill || dryRun
    ? await UserClubPromotionProgress.findOne({ user: userId, club: clubKey })
    : await ensurePromotionProgressDoc({ userId, clubId: clubKey });
  if (!progress) return { error: "progress_not_found" };

  const before = snapshotProgress(progress);

  // Contadores informativos, ahora sacados de los datos (antes se sumaban +1/-1)
  progress.counters = progress.counters || {};
  progress.counters.qrScansInClub = counts.scan_qr;
  progress.counters.attendancesInClub = counts.attend_event;

  for (const lvl of progress.levels || []) {
    applyAccumulatedCountsToLevel(lvl, counts);
    lvl.progress = computeLevelProgress(lvl);
  }

  // Vuelta atrás: un nivel completado SIN canjear cuyas misiones ya no se
  // cumplen (asistencia desmarcada, reembolso) vuelve a en curso y su premio
  // deja de estar disponible. Un nivel canjeado nunca se toca.
  for (const lvl of progress.levels || []) {
    if (lvl.rewardRedeemed === true) continue;
    if (lvl.status === "completed" && !allMissionsCompleted(lvl)) {
      lvl.status = "in_progress";
      lvl.completedAt = null;
      lvl.progress = computeLevelProgress(lvl);
      // El nivel actual no puede quedar por encima de uno que vuelve a estar en curso
      if (Number(lvl.levelNumber) < Number(progress.currentLevel)) {
        progress.currentLevel = Number(lvl.levelNumber);
      }
    }
  }

  // Completar niveles y, al desbloquear uno, aplicarle también el acumulado.
  let guard = 0;
  while (guard++ < 15) {
    const cur = (progress.levels || []).find((l) => Number(l.levelNumber) === Number(progress.currentLevel));
    if (!cur) break;

    applyAccumulatedCountsToLevel(cur, counts);
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
  const after = snapshotProgress(progress);
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (dryRun || (backfill && !changed)) return { before, after, changed };

  if (eventId) progress.lastEventId = eventId;
  if (!backfill) progress.lastActivityAt = new Date();
  progress.markModified("levels");
  await progress.save(); // VersionError -> lo reintenta syncAccumulatedMissions
  return { before, after, changed };
}

// Nombre anterior: lo usan share.js, el webhook de Stripe y promotionsController.
const syncReferralMissions = syncAccumulatedMissions;

/**
 * Atajo para share.js, el webhook de Stripe y promociones: recibe la identidad
 * como venga guardada (uid o _id) y el evento, y resuelve usuario y club.
 */
async function syncReferralForEvent({ userKey, eventId }) {
  try {
    const userId = await resolveMongoUserId(userKey);
    if (!userId || !mongoose.isValidObjectId(String(eventId || ""))) return;
    const event = await Event.findById(eventId).select("_id createdBy clubId club").lean();
    const clubKey = promotionClubKeyForEvent(event);
    if (clubKey) await syncAccumulatedMissions({ userId, clubKey });
  } catch (e) {
    console.warn("[promotions] syncReferralForEvent failed:", e?.message || e);
  }
}

/** Si otra sincronización ha cambiado de nivel, el nivel nuevo recibe todo el acumulado. */
async function syncAccumulatedIfLevelChanged({ userId, clubId, previousLevel, progress }) {
  if (progress && Number(progress.currentLevel) !== Number(previousLevel)) {
    await syncAccumulatedMissions({ userId: String(userId), clubKey: String(clubId) });
  }
}

/** QR escaneado: recalcula scan_qr (eventos distintos) y el resto del acumulado. */
async function syncPromotionAfterQrScan({ userId, clubId, eventId }) {
  await syncAccumulatedMissions({ userId: String(userId), clubKey: String(clubId), eventId });
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

/**
 * Asistencia marcada o desmarcada: recalcula attend_event (eventos del club con
 * el usuario en attendees) y el resto del acumulado. attendedNow ya no hace
 * falta: se cuenta desde los datos, no sumando +1/-1.
 */
async function syncPromotionAfterAttend({ userId, clubId, eventId }) {
  await syncAccumulatedMissions({ userId: String(userId), clubKey: String(clubId), eventId });
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
  // Devuelve true solo si de verdad avanzó una misión (y se guardó).
  try {
    if (!missionKey) return false;

    const progress = await ensurePromotionProgressDoc({ userId, clubId });
    if (!progress) {
      console.warn("[promotions] syncPromotionAfterPhotoApproved: sin progreso (¿no hay plantillas globales?)", {
        userId: String(userId || ""),
        clubId: String(clubId || ""),
        missionKey,
      });
      return false;
    }

    const previousLevel = progress.currentLevel; // para el acumulado del club
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
    await syncAccumulatedIfLevelChanged({ userId, clubId, previousLevel, progress });
    return matchedMission;
  } catch (e) {
    console.warn("[promotions] syncPromotionAfterPhotoApproved failed:", e?.message || e);
    return false;
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

/**
 * Efectos de APROBAR una foto, iguales la apruebe el club o la IA:
 *  - avisar a los asistentes de que hay foto nueva,
 *  - avanzar la misión de la foto UNA SOLA VEZ en toda su vida (photo.missionCounted).
 * `req` solo se usa para construir URLs absolutas (en segundo plano: pseudo-req).
 */
async function applyPhotoApprovalEffects({ req, event, photo }) {
  await createNewEventPhotoNotifications({ req, event, photo });

  // Promotions: SOLO para la misión que lleva la foto (sin missionId = foto del
  // muro: no avanza nada).
  const clubId = event.createdBy ? String(event.createdBy._id || event.createdBy) : null;
  const uploaderId = photo.by ? String(photo.by) : null;
  const missionKey = photo.validatedForMissionId || photo.missionId || null;
  if (!clubId || !uploaderId || !missionKey || !photo.photoId) return;

  // Contar UNA vez por foto: comprobar y marcar en una sola escritura atómica.
  // Si dos aprobaciones llegan a la vez, solo una gana la marca y suma.
  // Rechazar después NO desmarca: aprobar, rechazar y aprobar no vuelve a sumar.
  const claim = await Event.updateOne(
    { _id: event._id, photos: { $elemMatch: { photoId: photo.photoId, missionCounted: { $ne: true } } } },
    { $set: { "photos.$.missionCounted": true } }
  );
  if ((claim.n ?? claim.matchedCount) !== 1) return; // ya contó antes

  const counted = await syncPromotionAfterPhotoApproved({
    userId: uploaderId,
    clubId,
    eventId: String(event._id),
    missionType: photo.validatedForMissionType || photo.missionType || null,
    missionKey,
    missionTitle: photo.validatedForMissionTitle || photo.missionTitle || null,
    levelNumber: photo.validatedForLevelNumber ?? photo.levelNumber ?? null,
  });

  if (!counted) {
    // No llegó a sumar (sin progreso, misión no encontrada o error): se quita la
    // marca para que una aprobación posterior pueda contarla cuando sí sea posible.
    await Event.updateOne(
      { _id: event._id, "photos.photoId": photo.photoId },
      { $set: { "photos.$.missionCounted": false } }
    );
  }
}

/** req mínimo para absUrlFromUpload cuando no hay petición (tareas en segundo plano). */
function pseudoReqFromBase(base) {
  try {
    const u = new URL(base);
    return { protocol: u.protocol.replace(":", ""), get: (h) => (String(h).toLowerCase() === "host" ? u.host : undefined) };
  } catch {
    return { protocol: "https", get: () => "api.nightvibe.life" };
  }
}

/**
 * Revisión con IA de una foto ya guardada (se ejecuta en segundo plano).
 *  - Moderación bloquea      -> status 'rejected' y se BORRA el archivo, con CUALQUIER confianza.
 *  - Misión no cumplida      -> status 'rejected' (archivo conservado), solo si seguía 'pending'.
 *  - IA aprueba una MISIÓN con confianza >= PHOTO_REVIEW_AUTO_APPROVE_MIN (0.90)
 *                            -> status 'approved' automáticamente, mismo camino que el club
 *                               (notificaciones + avance de la misión), reviewSource 'ai'.
 *  - IA aprueba con menos confianza, o foto del MURO -> sigue 'pending' para el club
 *    (en el muro la IA solo hace moderación: su 'approved' = "nada prohibido").
 *  - needs_review / fallo    -> sigue 'pending'.
 * Las decisiones de la IA solo se aplican si la foto sigue 'pending': nunca pisan
 * una decisión del club (salvo el bloqueo por moderación, que siempre actúa).
 * Nunca lanza: un fallo de la IA no bloquea a nadie ni pierde la foto.
 */
async function runPhotoReview({ eventId, photoId, imagePath, isMissionPhoto, photoCriteria, photoCriteriaExclude, publicBase }) {
  let result = await reviewPhoto({
    imagePath,
    photoCriteria,
    photoCriteriaExclude,
    logContext: { eventId: String(eventId), photoId },
  });

  // Foto de misión sin criterio definido (misión aún no migrada): la IA no puede
  // validar la misión, así que lo que no sea un bloqueo de moderación lo revisa el club.
  if (isMissionPhoto && !String(photoCriteria || "").trim() && result.moderation !== "blocked") {
    result = {
      ...result,
      status: "needs_review",
      reason: "La misión no tiene criterio de foto definido; la revisa el club.",
    };
  }

  const ai = {
    "photos.$.aiStatus": result.status,
    "photos.$.aiReason": String(result.reason || "").slice(0, 500),
    "photos.$.aiConfidence": result.confidence ?? null,
    "photos.$.aiCheckedAt": new Date(),
  };

  // Decisión tomada por la IA (sin persona detrás)
  const aiDecision = {
    "photos.$.reviewSource": "ai",
    "photos.$.reviewedBy": null,
    "photos.$.reviewedAt": new Date(),
  };

  try {
    if (result.moderation === "blocked") {
      // Rechazo directo, aunque el club ya la hubiera tocado: contenido explícito fuera.
      // El umbral de confianza NO aplica a la moderación.
      await Event.updateOne(
        { _id: eventId, "photos.photoId": photoId },
        {
          $set: {
            ...ai,
            ...aiDecision,
            "photos.$.status": "rejected",
            "photos.$.validationResult": "ai_blocked",
          },
        }
      );
      try {
        fs.unlinkSync(imagePath);
      } catch (e) {
        console.warn("[photoReview] no se pudo borrar el archivo bloqueado:", imagePath, e?.message || e);
      }
      console.warn("[photoReview] foto BLOQUEADA por moderación y archivo borrado", { eventId: String(eventId), photoId });
      return;
    }

    if (result.status === "rejected") {
      // Misión no cumplida: rechazo, pero sin pisar una decisión del club ya tomada.
      const r = await Event.updateOne(
        { _id: eventId, photos: { $elemMatch: { photoId, status: "pending" } } },
        {
          $set: {
            ...ai,
            ...aiDecision,
            "photos.$.status": "rejected",
            "photos.$.validationResult": "ai_not_matched",
          },
        }
      );
      if ((r.n ?? r.matchedCount) === 1) return;
    }

    // Aprobación AUTOMÁTICA: solo fotos de MISIÓN, solo con confianza alta.
    const minConfidence = getAutoApproveMin();
    if (
      result.status === "approved" &&
      isMissionPhoto &&
      typeof result.confidence === "number" &&
      result.confidence >= minConfidence
    ) {
      // Atómica y condicionada: solo si sigue 'pending' (el club no ha decidido
      // mientras tanto) y no está bloqueada. Así nunca cuenta dos veces.
      const r = await Event.updateOne(
        {
          _id: eventId,
          photos: { $elemMatch: { photoId, status: "pending", validationResult: { $ne: "ai_blocked" } } },
        },
        {
          $set: {
            ...ai,
            ...aiDecision,
            "photos.$.status": "approved",
            "photos.$.validationResult": "ai_matched",
          },
        }
      );

      if ((r.n ?? r.matchedCount) === 1) {
        const event = await Event.findById(eventId).select("_id title createdBy attendees photos").lean();
        const photo = (event?.photos || []).find((p) => p && p.photoId === photoId);
        if (event && photo) {
          await applyPhotoApprovalEffects({
            req: pseudoReqFromBase(publicBase),
            event,
            photo,
          });
        }
        console.log("[photoReview] foto de misión APROBADA automáticamente", {
          eventId: String(eventId),
          photoId,
          confidence: result.confidence,
          minConfidence,
        });
        return;
      }
    }

    // approved sin aprobación automática (muro, poca confianza o el club ya
    // decidió), needs_review, o rechazo cuando el club ya decidió: solo datos de la IA.
    await Event.updateOne({ _id: eventId, "photos.photoId": photoId }, { $set: ai });
  } catch (e) {
    console.warn("[photoReview] no se pudo guardar el resultado:", e?.message || e, { eventId: String(eventId), photoId });
  }
}

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
// Se guarda en fotos (byUsername) y firmas: nombre público, nunca del teléfono.
// (Antes, sin username, guardaba los dígitos del teléfono.)
function usernameFromUserDoc(u) {
  if (!u) return null;
  return publicUsername(u);
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
    const storedBy =
      entry.byUsername ||
      (entry.byUser && entry.byUser.username) ||
      (entry.user && entry.user.username) ||
      entry.username ||
      null;
    // Guardado al subir: los antiguos pueden ser dígitos del teléfono
    const byUsername = storedBy && entry.by ? publicStoredName(storedBy, entry.by) : storedBy && publicStoredName(storedBy, null);

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

  // Nunca del teléfono: sin username (o derivado de él) -> alias neutro del _id
  const username = publicUsername(u);
  const displayName = publicDisplayName({ ...u, entityName: u.entityName || u.name });
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
      const { tiers, error, errorCode } = sanitizeTiers(tiersInput.value);
      if (error) return res.status(400).json({ ...(errorCode ? { error: errorCode } : {}), message: error });
      newEvent.ticketTiers = tiers;
      syncEventPrice(newEvent);
    }

    // Aforo (0 = sin límite). Antes esta ruta no lo leía: todo evento nacía ilimitado.
    const cap = parseCapacityInput(req.body.capacity);
    if (cap.problem) return res.status(400).json(cap.problem);
    newEvent.capacity = cap.value ?? 0;

    // Tipo de acceso (gratis libre / gratis con aforo / de pago)
    const access = resolveAccessTypeForSave(req.body.accessType, {
      price: newEvent.price,
      ticketTiers: newEvent.ticketTiers,
      capacity: newEvent.capacity,
    });
    if (access.problem) return res.status(400).json(access.problem);
    newEvent.accessType = access.accessType;

    const savedEvent = await newEvent.save();
    res.status(201).json({
      ...savedEvent.toObject(),
      ...accessInfo(savedEvent),
      ...eventAvailability(savedEvent), // soldOut + spotsLeft (sin consultas extra)
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
      .populate("createdBy", "username phoneNumber profilePicture displayName");

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
        ...accessInfo(event), // accessType + requiresTicket (la app no interpreta precios)
        ...eventAvailability(event), // soldOut + spotsLeft (sin consultas extra)
        photos,
        createdBy: event.createdBy
          ? {
              ...sanitizePublicUser(event.createdBy), // username público, sin teléfono
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
    const events = await Event.find().populate("createdBy", "username phoneNumber profilePicture displayName").lean();

    const formattedEvents = events.map((event) => {
      // normaliza fotos a objetos con url absoluta (manteniendo compatibilidad)
      const photos = approvedOnly(event.photos)
        .map((p) => toPhotoTileAbs(req, p, req.user?.id || null))
        .filter(Boolean);

      return {
        ...event,
        imageUrl: absUrlFromUpload(req, event.image),
        ...accessInfo(event), // accessType + requiresTicket (la app no interpreta precios)
        ...eventAvailability(event), // soldOut + spotsLeft (sin consultas extra)
        photos,
        createdBy: event.createdBy
          ? {
              ...sanitizePublicUser(event.createdBy), // username público, sin teléfono
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
      .populate("createdBy", "username phoneNumber profilePicture displayName")
      .lean();

    const formattedEvents = events.map((event) => {
      const photos = approvedOnly(event.photos)
        .map((p) => toPhotoTileAbs(req, p, req.user?.id || null))
        .filter(Boolean);

      return {
        ...event,
        imageUrl: absUrlFromUpload(req, event.image),
        ...accessInfo(event), // accessType + requiresTicket (la app no interpreta precios)
        ...eventAvailability(event), // soldOut + spotsLeft (sin consultas extra)
        photos,
        createdBy: event.createdBy
          ? {
              ...sanitizePublicUser(event.createdBy), // username público, sin teléfono
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
      accessType: 1,
      capacity: 1, // free_limited exige aforo: sin él, accessInfo no lo daría por válido
      // Disponibilidad (eventAvailability) y tipo de acceso: todo del propio evento
      ticketsSold: 1,
      ticketsReserved: 1,
      ticketTiers: 1,
      salesStart: 1, // availability: "aún no a la venta" / "venta terminada"
      salesEnd: 1,
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
      ...accessInfo(e),
      ...eventAvailability(e), // soldOut + spotsLeft (sin consultas extra)
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

    await recordQrScan(req, event);
    const clubId = promotionClubKeyForEvent(event);
    if (clubId) {
      // Recalcula desde los QrScan (eventos distintos): reescanear no suma, y si
      // una sincronización anterior falló, este escaneo la repara.
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
      Ticket.distinct("eventId", { assignedToUserId: { $in: buyerIds }, status: { $nin: ["refunded", "cancelled"] } }),
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
    // Asignación a un usuario de la app: su username (guardado al asignar) puede
    // ser uno antiguo sacado del teléfono -> nombre público. Por enlace: el
    // nombre que escribió el propio comprador.
    name: t.assignedToUserId ? publicStoredName(t.assignedToName, t.assignedToUserId) || "" : t.assignedToName || "",
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
  return User.findOne(filter).select("_id username role firebaseUid phoneNumber").lean();
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
      mongoose.isValidObjectId(buyerId) ? User.findById(buyerId).select("username phoneNumber").lean() : null,
      mongoose.isValidObjectId(String(ticket.eventId))
        ? Event.findById(ticket.eventId).select("_id title image").lean()
        : null,
    ]);
    const buyerName = buyer ? publicUsername(buyer) : "Alguien";
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
          meta: { eventTitle, givenByUsername: buyer ? publicUsername(buyer) : "" },
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
    // Las reservas gratuitas canceladas no se listan (la plaza ya se devolvió).
    const tickets = await Ticket.find({ $and: [viewerFilter, { status: { $ne: "cancelled" } }] })
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
          .select("_id firebaseUid username phoneNumber")
          .lean()
      : [];
    const giverNameByKey = new Map();
    for (const g of givers) {
      const name = publicUsername(g);
      giverNameByKey.set(String(g._id), name);
      if (g.firebaseUid) giverNameByKey.set(String(g.firebaseUid), name);
    }

    // --- Carga en bloque: eventos, órdenes y clubs ---
    const eventIds = [...new Set(tickets.map((t) => String(t.eventId)).filter(mongoose.isValidObjectId))];
    const orderIds = [...new Set(tickets.map((t) => t.orderId && String(t.orderId)).filter(Boolean))];

    const [events, orders] = await Promise.all([
      Event.find({ _id: { $in: eventIds } })
        // accessType/price/capacity: para accessInfo (tipo de acceso del evento)
        .select("_id title image startAt endAt date city street ticketTiers.tierId ticketTiers.name ticketTiers.priceEUR club createdBy accessType price capacity")
        .lean(),
      Order.find({ _id: { $in: orderIds } })
        .select("_id amountEUR currency qty tierName items.ticketTypeId items.unitAmount freeReservation status")
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
        ? User.find({ _id: { $in: ownerRefIds } }).select("_id entityName entName displayName username phoneNumber").lean()
        : [],
    ]);
    const clubNameById = new Map(clubs.map((c) => [String(c._id), c.name]));
    const ownerNameById = new Map(
      owners.map((u) => [String(u._id), publicDisplayName(u)])
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
              ...accessInfo(ev), // accessType + requiresTicket
            }
          : null,
        // Reserva gratuita (POST /:id/reserve). Mejor señal que event.accessType
        // para el botón: el tipo del evento podría cambiar después de reservar.
        freeReservation: !!ord?.freeReservation,
        // "Cancelar reserva": solo quien reservó, mientras la reserva siga activa
        // y la entrada no se haya usado en la puerta (DELETE /:id/reserve).
        canCancelReservation:
          isOwnerRole && !!ord?.freeReservation && ord.status === "paid" && t.status === "issued",
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
    if (ticket.status === "cancelled") {
      return res.status(403).json({ reason: "cancelled", message: "Esta reserva está cancelada" });
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
  if (fresh?.status === "cancelled") {
    return res.status(409).json({ error: "cancelled", message: "Esta reserva está cancelada" });
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
        assignedToName: publicUsername(recipient),
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
    if (ticket.status === "cancelled") {
      return res.status(409).json({ error: "cancelled", message: "Esta reserva está cancelada" });
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
    if (!ticket || ticket.status === "refunded" || ticket.status === "cancelled" || !ticket.serial) return notFound();

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
      const u = await User.findById(ev.createdBy).select("entityName entName displayName username phoneNumber").lean();
      clubName = u ? publicDisplayName(u) : "";
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
      Ticket.findOne({ eventId, assignedToUserId: { $in: buyerIds }, status: { $nin: ["refunded", "cancelled"] } })
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
        "_id price capacity ticketsSold ticketsReserved ticketTiers currency platformFeeEUR accessType salesStart salesEnd"
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
        const rem = tierRemaining(tier); // Infinity = ilimitada (utils/stock.js)

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
      const rem = capacityRemaining(event); // Infinity = sin aforo (utils/stock.js)
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
      ...accessInfo(event),
      ...eventAvailability(event), // soldOut + spotsLeft del evento entero
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
      "username phoneNumber profilePicture displayName"
    );
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    // ⚠️ Ruta PÚBLICA: sin qrToken ni qrPayload (secreto del QR del local).
    // El portal lo obtiene en GET /api/events/:id/qr (solo quien gestiona el evento).
    const obj = event.toObject();
    delete obj.qrToken;

    const formattedEvent = {
      ...obj,
      imageUrl: absUrlFromUpload(req, obj.image),
      ...accessInfo(obj), // accessType + requiresTicket (la app no interpreta precios)
      ...eventAvailability(obj), // soldOut + spotsLeft (sin consultas extra)
      photos: approvedOnly(obj.photos).map((p) => toPhotoTileAbs(req, p, req.user?.id || null)).filter(Boolean),
      createdBy: obj.createdBy
        ? {
            ...sanitizePublicUser(obj.createdBy), // username público, sin teléfono
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
      byUsername: publicStoredName(p.byUsername, p.by), // los antiguos pueden ser del teléfono
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
      // Qué opinó la IA (orientativo: la decisión es `status`, que toma el club)
      aiStatus: p.aiStatus || "not_run",
      aiReason: p.aiReason || "",
      aiConfidence: p.aiConfidence ?? null,
      aiCheckedAt: p.aiCheckedAt || null,
      // Quién decidió el status: 'club' | 'ai' | null (pendiente / antiguo)
      reviewSource: p.reviewSource || null,
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

    // Bloqueada por la moderación de la IA: el archivo ya se borró y la decisión
    // no se revierte. Rechazar o eliminar sí se puede; aprobar, no.
    if (event.photos[idx].validationResult === "ai_blocked") {
      return res.status(409).json({
        error: "blocked_by_moderation",
        message: "Esta foto fue bloqueada por contenido no permitido y no se puede aprobar.",
      });
    }

    const note = (req.body?.reviewNote || "").toString();
    const validationMeta = extractPhotoValidationMeta(req.body || {});

    event.photos[idx].status = "approved";
    event.photos[idx].reviewedBy = req.user.id;
    event.photos[idx].reviewedAt = new Date();
    event.photos[idx].reviewSource = "club";
    event.photos[idx].reviewNote = note;
    event.photos[idx].validatedForMissionType = validationMeta.validatedForMissionType;
    event.photos[idx].validatedForMissionId = validationMeta.validatedForMissionId;
    event.photos[idx].validatedForMissionTitle = validationMeta.validatedForMissionTitle;
    event.photos[idx].validatedForLevelNumber = validationMeta.validatedForLevelNumber;
    event.photos[idx].validationResult = validationMeta.validationResult || "matched";

    await event.save();

    // Mismo camino que la aprobación automática de la IA (runPhotoReview).
    // El avance de la misión se cuenta una sola vez por foto (photo.missionCounted).
    await applyPhotoApprovalEffects({
      req,
      event,
      photo: event.photos[idx],
    });

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
    event.photos[idx].reviewSource = "club";
    event.photos[idx].reviewNote = note;
    event.photos[idx].validatedForMissionType = validationMeta.validatedForMissionType;
    event.photos[idx].validatedForMissionId = validationMeta.validatedForMissionId;
    event.photos[idx].validatedForMissionTitle = validationMeta.validatedForMissionTitle;
    event.photos[idx].validatedForLevelNumber = validationMeta.validatedForLevelNumber;
    // Una foto bloqueada por moderación conserva la marca: si se perdiera al
    // rechazarla, después se podría aprobar (ver el 409 de /approve).
    if (event.photos[idx].validationResult !== "ai_blocked") {
      event.photos[idx].validationResult = validationMeta.validationResult || "not_matched";
    }

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
    const reviewJobs = []; // revisión con IA en segundo plano, tras responder
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
        aiStatus: "not_run",
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
      reviewJobs.push({
        eventId: event._id,
        photoId: meta.photoId,
        imagePath: processed,
        isMissionPhoto: !!missionMeta.missionId,
        photoCriteria: missionMeta.photoCriteria || "",
        photoCriteriaExclude: missionMeta.photoCriteriaExclude || "",
        publicBase: backendBase(req), // para URLs absolutas en las notificaciones
      });
    }

    await event.save();
    // NO promociones aquí; solo al aprobar

    // Respuesta: objetos con url absoluta + byUsername
    const uploaded = savedMeta.map((m) => ({
      photoId: m.photoId,
      url: absUrlFromUpload(req, m.url),
      byUsername: publicStoredName(m.byUsername, m.by),
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

    // Revisión con IA en SEGUNDO PLANO: el usuario no espera a la IA en la puerta.
    for (const job of reviewJobs) {
      enqueuePhotoReview(() => runPhotoReview(job));
    }

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
            byUsername: publicStoredName(removedEntry?.byUsername, removedEntry?.by),
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
   RESERVA GRATUITA (eventos accessType 'free_limited')
   POST   /api/events/:id/reserve  -> plaza + entrada con QR + email, sin Stripe
   DELETE /api/events/:id/reserve  -> anula la reserva y devuelve la plaza
   Una plaza por persona y evento. El aforo se comprueba de forma atómica
   (sellStockDirect) y se confirma en el acto: no hay pago que esperar.
------------------------------------------------------------------- */
const FREE_RESERVATION_LABEL = "Gratuita · plaza reservada"; // "Entrada:" en el email y el PDF

// Por usuario (va DESPUÉS de la autenticación): reservar y cancelar en bucle
const reserveLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `reserve:${req.user.id}`,
  handler: (_req, res) =>
    res.status(429).json({ error: "rate_limited", message: "Demasiados intentos seguidos, espera unos minutos" }),
});

/** Email utilizable para enviar la entrada (descarta los `<uid>@firebase.local`). */
function usableEmailForTickets(email) {
  const e = typeof email === "string" ? email.trim() : "";
  if (!e || /@firebase\.local$/i.test(e)) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

router.post("/:id/reserve", anyAuth, ensureUserId, reserveLimiter, async (req, res) => {
  const eventId = String(req.params.id || "");
  try {
    if (!mongoose.isValidObjectId(eventId)) {
      return res.status(400).json({ error: "invalid_event", message: "ID de evento inválido" });
    }
    const event = await Event.findById(eventId).lean();
    if (!event || event.isPublished === false) {
      return res.status(404).json({ error: "event_not_found", message: "Evento no encontrado" });
    }

    const accessType = accessTypeOf(event);
    if (accessType !== "free_limited") {
      return res.status(400).json({
        error: "not_free_limited",
        accessType,
        message:
          accessType === "paid"
            ? "Este evento es de pago: compra la entrada"
            : "Este evento es de entrada libre: no necesitas reservar",
      });
    }

    const now = Date.now();
    if (event.salesStart && now < new Date(event.salesStart).getTime()) {
      return res.status(400).json({ error: "sales_not_started", message: "Las reservas todavía no han empezado" });
    }
    if (event.salesEnd && now > new Date(event.salesEnd).getTime()) {
      return res.status(400).json({ error: "sales_ended", message: "Las reservas ya han terminado" });
    }
    const { endMs } = eventTimes(event);
    if (endMs !== null && endMs < now) {
      return res.status(400).json({ error: "event_ended", message: "Este evento ya ha terminado" });
    }

    const user = await User.findById(req.user.id).select("_id email firebaseUid").lean();
    if (!user) return res.status(401).json({ error: "unauthorized", message: "Usuario no encontrado" });
    const userId = String(user._id);
    const ids = [userId, user.firebaseUid].filter(Boolean).map(String);

    // ¿Ya tiene entrada válida para este evento (suya o asignada)?
    const hasTicket = await Ticket.exists({
      eventId: String(event._id),
      status: { $in: ["issued", "checked_in"] },
      $or: [{ ownerUserId: { $in: ids } }, { assignedToUserId: { $in: ids } }],
    });
    if (hasTicket) {
      return res.status(409).json({ error: "already_reserved", message: "Ya tienes una entrada para este evento" });
    }

    const email = usableEmailForTickets(user.email);

    // 1) Orden de importe 0. El índice único (evento + usuario, reserva activa)
    //    para la segunda de dos peticiones simultáneas.
    let order;
    try {
      order = await Order.create({
        freeReservation: true,
        userId,
        eventId: String(event._id),
        clubId: event.club ? String(event.club) : event.clubId || null,
        qty: 1,
        amountEUR: 0,
        currency: "eur",
        email,
        status: "paid",
        paymentMethod: "free",
        reservedQty: 0,
        reservationActive: false,
      });
    } catch (e) {
      if (e?.code === 11000) {
        return res.status(409).json({ error: "already_reserved", message: "Ya tienes una entrada para este evento" });
      }
      throw e;
    }

    // 2) Plaza: comprobación de aforo y venta en UN paso atómico
    const seat = await sellStockDirect(event._id, 1);
    if (!seat) {
      await Order.updateOne({ _id: order._id }, { $set: { status: "failed" } });
      return res.status(409).json({ error: "sold_out", remaining: 0, message: "No quedan plazas" });
    }
    order.stockCommittedAt = new Date();
    await order.save();

    // 3) Entrada con su QR (misma función que el pago). Si falla, se deshace todo.
    let issued;
    try {
      issued = await issueTicketsForOrder({ order, eventId: String(event._id), qty: 1, ownerUserId: userId, email });
    } catch (issueErr) {
      console.error("[reserve] fallo emitiendo la entrada; se devuelve la plaza", {
        eventId,
        orderId: String(order._id),
        error: issueErr?.message || issueErr,
      });
      await Ticket.deleteMany({ orderId: order._id }).catch(() => {});
      await releaseSoldStock(event._id, 1).catch(() => {});
      await Order.updateOne({ _id: order._id }, { $set: { status: "failed" } }).catch(() => {});
      return res.status(500).json({ error: "reserve_failed", message: "No se pudo emitir la entrada, inténtalo de nuevo" });
    }

    const ticket = issued.tickets[0];
    console.log("[reserve] plaza reservada", { eventId, userId, orderId: String(order._id), serial: ticket?.serial });

    // 4) Email en segundo plano: no hace esperar a la app (la entrada ya está en "Mis entradas")
    if (email) {
      setImmediate(() => {
        sendOrderTicketsEmail({
          order,
          event,
          eventId: String(event._id),
          toEmail: email,
          ticketTheme: (typeof event.ticketTheme === "string" && event.ticketTheme.trim()) || "default",
          tickets: issued.tickets,
          seatLabel: FREE_RESERVATION_LABEL,
          logTag: "reserve",
        }).catch(() => {});
      });
    }

    return res.status(201).json({
      ok: true,
      orderId: String(order._id),
      ticket: { ticketId: String(ticket.doc._id), serial: ticket.serial, status: "issued" },
      emailQueued: !!email,
      ...(email ? {} : { emailNote: "Tu cuenta no tiene email: la entrada está en Mis entradas" }),
    });
  } catch (err) {
    console.error("[POST /events/:id/reserve] error:", err);
    return res.status(500).json({ error: "server_error", message: "Error reservando la plaza" });
  }
});

router.delete("/:id/reserve", anyAuth, ensureUserId, reserveLimiter, async (req, res) => {
  const eventId = String(req.params.id || "");
  try {
    if (!mongoose.isValidObjectId(eventId)) {
      return res.status(400).json({ error: "invalid_event", message: "ID de evento inválido" });
    }

    // Solo el dueño: su propia reserva gratuita activa
    const order = await Order.findOne({
      eventId,
      userId: String(req.user.id),
      freeReservation: true,
      status: "paid",
    }).lean();
    if (!order) {
      return res.status(404).json({ error: "no_reservation", message: "No tienes una reserva para este evento" });
    }

    // Entrada: issued -> cancelled, de forma atómica (si se usó en la puerta, no)
    const now = new Date();
    const cancelled = await Ticket.updateMany(
      { orderId: order._id, status: "issued" },
      { $set: { status: "cancelled", cancelledAt: now } }
    );
    const used = await Ticket.exists({ orderId: order._id, status: "checked_in" });
    if (used) {
      return res.status(409).json({ error: "already_used", message: "Esta entrada ya se ha usado en la puerta" });
    }

    // Orden: paid -> cancelled UNA vez; quien la reclama devuelve la plaza
    const claimed = await Order.findOneAndUpdate(
      { _id: order._id, status: "paid" },
      { $set: { status: "cancelled", cancelledAt: now } }
    );
    if (claimed && claimed.stockCommittedAt) {
      await releaseSoldStock(eventId, claimed.qty || 1);
    }

    console.log("[reserve] reserva cancelada", {
      eventId,
      userId: String(req.user.id),
      orderId: String(order._id),
      tickets: cancelled.modifiedCount ?? cancelled.nModified ?? 0,
      released: !!claimed,
    });
    return res.json({ ok: true, released: claimed ? claimed.qty || 1 : 0 });
  } catch (err) {
    console.error("[DELETE /events/:id/reserve] error:", err);
    return res.status(500).json({ error: "server_error", message: "Error cancelando la reserva" });
  }
});

/* ------------------------------------------------------------------
   ALTERNAR ASISTENCIA (requiere usuario)
   - Alterna en Mongo (campo attendees) con operaciones ATÓMICAS: dos toques
     seguidos o varios usuarios a la vez no chocan ni se pisan. (Antes:
     leer -> splice/push -> save(); desmarcar daba VersionError si otra
     petición tocaba el evento, y dos marcados simultáneos metían al usuario
     dos veces.)
   - Escribe/borra doc en Firestore: attendances/{uid}_{eventId}
------------------------------------------------------------------- */
function updateModified(r) {
  return Number(r?.nModified ?? r?.modifiedCount ?? 0) > 0;
}

router.post("/:id/attend", anyAuth, ensureUserId, async (req, res) => {
  const eventId = req.params.id;

  try {
    // 1) Recuperar evento (solo lo que usan Firestore y la clave del club)
    if (!mongoose.isValidObjectId(eventId)) {
      return res.status(400).json({ message: "ID de evento inválido" });
    }
    const event = await Event.findById(eventId).select("_id title date image createdBy clubId club").lean();
    if (!event) return res.status(404).json({ message: "Evento no encontrado" });

    // 2) Usuario (Mongo id ya garantizado). attendees guarda ObjectId.
    const userId = req.user.id;
    const userObjId = new mongoose.Types.ObjectId(userId);

    // 3) Alternar asistencia, atómico. El resultado sale de QUÉ operación
    //    modificó el documento, no de una lectura previa.
    //    a) Si estaba: desmarcar ($pull quita también duplicados antiguos)
    const pulled = await Event.updateOne(
      { _id: eventId, attendees: userObjId },
      { $pull: { attendees: userObjId } }
    );
    let attendedNow;
    if (updateModified(pulled)) {
      attendedNow = false;
    } else {
      //  b) Si no estaba: marcar ($addToSet: nunca dos veces)
      const added = await Event.updateOne(
        { _id: eventId, attendees: { $ne: userObjId } },
        { $addToSet: { attendees: userObjId } }
      );
      attendedNow = updateModified(added) ? true : null; // null: otra petición cambió el estado entre a) y b)
    }

    // Estado final real (para la respuesta, y para el caso de carrera entre a) y b))
    const after = await Event.findById(eventId).select("_id attendees").lean();
    if (!after) return res.status(404).json({ message: "Evento no encontrado" });
    const attendees = Array.isArray(after.attendees) ? after.attendees : [];
    if (attendedNow === null) attendedNow = attendees.some((a) => String(a) === userId);

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
    const clubId = promotionClubKeyForEvent(event);
    if (clubId) {
      await syncPromotionAfterAttend({ userId, clubId, eventId });
    }

    // 5) Responder (misma forma que antes: _id + lista de asistentes ya actualizada)
    return res.json({
      _id: after._id,
      attendees,
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

      const { tiers, error, errorCode } = sanitizeTiers(tiersInput.value, existingTiers);
      if (error) return res.status(400).json({ ...(errorCode ? { error: errorCode } : {}), message: error });

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

    // Aforo: entero >= 0 y nunca por debajo de lo ya comprometido (vendidas +
    // reservadas), como las tandas. Bloqueo optimista: si una compra entra
    // entre la lectura y la escritura y ya no cabe, no se guarda (409).
    delete update.capacity;
    if (req.body.capacity !== undefined) {
      const cap = parseCapacityInput(req.body.capacity);
      if (cap.problem) return res.status(400).json(cap.problem);
      const committed = (event.ticketsSold || 0) + (event.ticketsReserved || 0);
      if (cap.value > 0 && cap.value < committed) {
        return res.status(400).json({
          error: "capacity_below_committed",
          committed,
          message: `El aforo no puede ser menor que las entradas ya vendidas o reservadas (${committed})`,
        });
      }
      update.capacity = cap.value;
      if (cap.value > 0) {
        updateFilter.$expr = {
          $lte: [
            { $add: [{ $ifNull: ["$ticketsSold", 0] }, { $ifNull: ["$ticketsReserved", 0] }] },
            cap.value,
          ],
        };
      }
    }

    // Tipo de acceso, con el precio, las tandas y el aforo como quedarán tras guardar.
    // (findOneAndUpdate no pasa los validadores del esquema: se valida aquí.)
    delete update.accessType;
    const access = resolveAccessTypeForSave(
      req.body.accessType,
      {
        price: update.price !== undefined ? update.price : event.price,
        ticketTiers: update.ticketTiers !== undefined ? update.ticketTiers : event.ticketTiers,
        capacity: update.capacity !== undefined ? update.capacity : event.capacity,
      },
      event.accessType
    );
    if (access.problem) return res.status(400).json(access.problem);
    update.accessType = access.accessType;

    // 4) Actualizar y devolver formateado
    const updated = await Event.findOneAndUpdate(updateFilter, update, { new: true })
      .populate("createdBy", "username phoneNumber profilePicture displayName")
      .lean();

    if (!updated) {
      return res.status(409).json({
        message: "Las ventas de este evento han cambiado mientras editabas. Recarga y vuelve a guardar.",
      });
    }

    const formatted = {
      ...updated,
      imageUrl: absUrlFromUpload(req, updated.image),
      ...accessInfo(updated), // accessType + requiresTicket (la app no interpreta precios)
      ...eventAvailability(updated), // soldOut + spotsLeft (sin consultas extra)
      photos: approvedOnly(updated.photos).map((p) => toPhotoTileAbs(req, p, req.user?.id || null)).filter(Boolean),
      createdBy: updated.createdBy
        ? {
            ...sanitizePublicUser(updated.createdBy), // username público, sin teléfono
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
// Misiones de referidos: las usan routes/share.js, el webhook de Stripe y promociones
module.exports.syncReferralForEvent = syncReferralForEvent;
module.exports.syncReferralMissions = syncReferralMissions;
module.exports.syncAccumulatedMissions = syncAccumulatedMissions;
module.exports.resolveMongoUserId = resolveMongoUserId;
