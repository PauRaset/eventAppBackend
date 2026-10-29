// utils/onboarding.js
// Alta del espectador tras el SMS: reglas del username, disponibilidad y
// sugerencias, y qué le falta a una cuenta para tener el alta completa.
//
// Variables de entorno (se leen en cada llamada, sin reiniciar caché):
//   MIN_AGE              edad mínima (utils/age.js)
//   TERMS_VERSION        versión vigente de los términos; si cambia, todos
//                        vuelven a tener 'terms' pendiente
//   ONBOARDING_ENFORCED  "true" para que requireOnboarding bloquee acciones
//
// Las cuentas de club nunca tienen alta pendiente y no siguen el formato de
// username de los espectadores (los clubs aprobados usan su nombre comercial).
const crypto = require("crypto");
const User = require("../models/User");
const { looksPhoneDerived } = require("./publicName");
const { meetsMinAge, formatBirthDate } = require("./age");

const DEFAULT_TERMS_VERSION = "2026-10";

function currentTermsVersion() {
  return String(process.env.TERMS_VERSION || "").trim() || DEFAULT_TERMS_VERSION;
}

function isOnboardingEnforced() {
  return ["true", "1", "yes"].includes(String(process.env.ONBOARDING_ENFORCED || "").trim().toLowerCase());
}

/* ------------------------------- Username ------------------------------- */

const USERNAME_RULES = { min: 3, max: 30, chars: "a-z 0-9 . _" };

// Comparación sin distinguir mayúsculas (y con índice: ver models/User.js)
const USERNAME_COLLATION = { locale: "en", strength: 2 };

// Alias automáticos: "user_" + 6 hex (neutro, del _id) o 6 dígitos (antiguo, del teléfono)
const AUTO_ALIAS_RE = /^user_[0-9a-f]{6}$/i;

const RESERVED_USERNAMES = new Set([
  "admin", "administrator", "administrador", "root", "superuser", "system", "sistema",
  "support", "soporte", "help", "ayuda", "staff", "team", "equipo", "moderator", "moderador",
  "security", "seguridad", "official", "oficial", "info", "contact", "contacto",
  "api", "www", "app", "web", "mail", "email", "null", "undefined", "me", "user", "users",
  "club", "clubs", "nv", "nvclubs",
]);

/** Forma en que se guarda: sin espacios alrededor, sin "@" inicial y en minúsculas. */
function normalizeUsername(raw) {
  return String(raw ?? "").trim().replace(/^@+/, "").toLowerCase();
}

/** null si vale; 'invalid_format' o 'reserved' si no. Espera el valor ya normalizado. */
function usernameProblem(u) {
  if (
    typeof u !== "string" ||
    u.length < USERNAME_RULES.min ||
    u.length > USERNAME_RULES.max ||
    !/^[a-z0-9._]+$/.test(u) ||
    u.startsWith(".") ||
    u.endsWith(".") ||
    u.includes("..")
  ) {
    return "invalid_format";
  }
  if (AUTO_ALIAS_RE.test(u) || RESERVED_USERNAMES.has(u) || u.includes("nightvibe")) return "reserved";
  return null;
}

/** ¿Lo tiene OTRO usuario? (sin distinguir mayúsculas; el propio no cuenta) */
async function isUsernameTaken(username, exceptUserId = null) {
  const filter = { username };
  if (exceptUserId) filter._id = { $ne: exceptUserId };
  const hit = await User.findOne(filter).collation(USERNAME_COLLATION).select("_id").lean();
  return !!hit;
}

/** Hasta `max` usernames libres y válidos parecidos a `raw`. Nunca dice nada de quien tiene el original. */
async function suggestUsernames(raw, exceptUserId = null, max = 3) {
  let base = normalizeUsername(raw)
    .replace(/[^a-z0-9._]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+|\.+$/g, "");
  if (AUTO_ALIAS_RE.test(base)) base = "";
  if (base.length < 2) base = "vibe";
  base = base.slice(0, USERNAME_RULES.max - 5).replace(/\.+$/, "");

  const rnd = (digits) => String(crypto.randomInt(10 ** (digits - 1), 10 ** digits));
  const yy = String(new Date().getFullYear()).slice(-2);
  const raws = [
    `${base}${rnd(2)}`,
    `${base}_${yy}`,
    `${base}.nv`,
    `${base}_${rnd(2)}`,
    `${base}${rnd(3)}`,
    `${base}.${rnd(3)}`,
    `${base}_${rnd(3)}`,
    `${base}${rnd(4)}`,
    `${base}.${rnd(4)}`,
    `${base}_${rnd(4)}`,
  ];
  const candidates = [...new Set(raws)].filter((c) => !usernameProblem(c));
  if (!candidates.length) return [];

  const filter = { username: { $in: candidates } };
  if (exceptUserId) filter._id = { $ne: exceptUserId };
  const taken = await User.find(filter).collation(USERNAME_COLLATION).select("username").lean();
  const takenSet = new Set(taken.map((t) => String(t.username).toLowerCase()));
  return candidates.filter((c) => !takenSet.has(c)).slice(0, max);
}

function invalidUsernameBody(reason) {
  return {
    error: "invalid_username",
    reason,
    rules: USERNAME_RULES,
    message:
      reason === "reserved"
        ? "Ese nombre de usuario no está disponible"
        : "El nombre de usuario debe tener entre 3 y 30 caracteres: letras minúsculas, números, punto o guion bajo",
  };
}

async function takenBody(username, exceptUserId) {
  return {
    error: "username_taken",
    suggestions: await suggestUsernames(username, exceptUserId),
    message: "Ese nombre de usuario ya está en uso",
  };
}

/**
 * Cambio de username desde las rutas de edición de perfil (PATCH/PUT
 * /api/users/me, PUT /api/auth/update). `user`: { _id, role, username }.
 *  - vacío o igual al guardado -> { unchanged: true } (no se toca)
 *  - espectador: formato (se guarda en minúsculas); club: solo sin espacios alrededor
 *  - unicidad sin distinguir mayúsculas
 * -> { ok: true, value } | { unchanged: true } | { ok: false, status, body }
 */
async function checkUsernameChange(user, raw) {
  if (typeof raw !== "string" || !raw.trim()) return { unchanged: true };
  if (raw.trim() === user.username) return { unchanged: true };

  const isClub = user.role === "club";
  const value = isClub ? raw.trim() : normalizeUsername(raw);
  if (value === user.username) return { unchanged: true };

  if (!isClub) {
    const problem = usernameProblem(value);
    if (problem) return { ok: false, status: 400, body: invalidUsernameBody(problem) };
  }
  if (await isUsernameTaken(value, user._id)) {
    return { ok: false, status: 409, body: await takenBody(value, user._id) };
  }
  return { ok: true, value };
}

/* ------------------------------ Otros campos ----------------------------- */

const DISPLAY_NAME_MAX = 50;

/** Nombre visible limpio (1..50, sin caracteres de control ni teléfonos) o null. */
function cleanDisplayName(raw, phoneNumber = null) {
  if (typeof raw !== "string") return null;
  const v = raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (!v || v.length > DISPLAY_NAME_MAX) return null;
  if (looksPhoneDerived(v, phoneNumber)) return null;
  return v;
}

/**
 * Instagram: "@usuario", "usuario" o una URL de instagram.com.
 * -> { value: "https://instagram.com/usuario" } | { skip: true } (vacío) | null (no válido)
 */
function normalizeInstagram(raw) {
  if (raw === undefined || raw === null) return { skip: true };
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return { skip: true };
  const url = /^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:[?#].*)?$/i.exec(s);
  const handle = url ? url[1] : /^@?([A-Za-z0-9._]{1,30})$/.exec(s)?.[1];
  if (!handle) return null;
  return { value: `https://instagram.com/${handle}` };
}

/* ------------------------------ Estado del alta ----------------------------- */

/** ¿El username lo eligió el usuario? (no un alias automático ni algo sacado del teléfono) */
function hasChosenUsername(u) {
  const name = String(u?.username || "").trim();
  if (!name) return false;
  if (AUTO_ALIAS_RE.test(name)) return false;
  if (looksPhoneDerived(name, u.phoneNumber)) return false;
  return true;
}

function hasDisplayName(u) {
  return !!(cleanDisplayName(u?.entityName, u?.phoneNumber) || cleanDisplayName(u?.entName, u?.phoneNumber));
}

function termsAccepted(u) {
  return !!u?.termsAcceptedAt && String(u.termsVersion || "") === currentTermsVersion();
}

/** Qué falta, en este orden: 'username', 'displayName', 'birthDate', 'terms'. Clubs: nunca nada. */
function missingOnboarding(u) {
  if (!u || u.role === "club") return [];
  const missing = [];
  if (!hasChosenUsername(u)) missing.push("username");
  if (!hasDisplayName(u)) missing.push("displayName");
  if (!u.birthDate) missing.push("birthDate");
  if (!termsAccepted(u)) missing.push("terms");
  return missing;
}

/** Bloqueado por edad: intento de menor registrado, o su fecha no llega al MIN_AGE ACTUAL. */
function isUnderage(u) {
  if (!u || u.role === "club") return false;
  if (u.ageGateFailedAt) return true;
  return !!u.birthDate && !meetsMinAge(u.birthDate);
}

/** Campos que se añaden a las respuestas del PROPIO usuario (/me, /ensure...). Nunca a las de otros. */
function onboardingFields(u) {
  const missing = missingOnboarding(u);
  return {
    needsOnboarding: missing.length > 0,
    missingOnboarding: missing,
    underage: isUnderage(u),
    birthDate: formatBirthDate(u?.birthDate),
    termsAcceptedAt: u?.termsAcceptedAt || null,
    termsVersion: u?.termsVersion || null,
    onboardingCompletedAt: u?.onboardingCompletedAt || null,
  };
}

module.exports = {
  currentTermsVersion,
  isOnboardingEnforced,
  USERNAME_RULES,
  USERNAME_COLLATION,
  DISPLAY_NAME_MAX,
  normalizeUsername,
  usernameProblem,
  isUsernameTaken,
  suggestUsernames,
  invalidUsernameBody,
  takenBody,
  checkUsernameChange,
  cleanDisplayName,
  normalizeInstagram,
  missingOnboarding,
  isUnderage,
  onboardingFields,
};
