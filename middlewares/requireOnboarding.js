// middlewares/requireOnboarding.js
// Exige el alta completa (y la edad mínima) a un ESPECTADOR antes de ciertas
// acciones de la app: comprar (/checkout), reservar, marcar asistencia, subir
// fotos y canjear premios. Va DESPUÉS del middleware de sesión de cada ruta.
//
// Solo actúa con ONBOARDING_ENFORCED=true (se lee en cada petición). Con
// cualquier otro valor deja pasar todo.
//   403 { error: 'underage', minAge }                 su birthDate no llega al MIN_AGE ACTUAL
//                                                     (o tiene un intento de menor registrado)
//   403 { error: 'onboarding_required', missingOnboarding }   le falta algo del alta
// Las cuentas de club nunca se bloquean.
const User = require("../models/User");
const { getMinAge } = require("../utils/age");
const { isOnboardingEnforced, missingOnboarding, isUnderage } = require("../utils/onboarding");

const FIELDS = "role username phoneNumber entityName entName birthDate termsAcceptedAt termsVersion onboardingCompletedAt ageGateFailedAt";
const isObjectIdString = (v) => typeof v === "string" && /^[a-fA-F0-9]{24}$/.test(v);

/** Usuario de Mongo de la sesión, sea cual sea el middleware de la ruta. */
async function sessionUser(req) {
  const u = req.user || {};
  const mongoId = u._id ? String(u._id) : u.id ? String(u.id) : "";
  if (isObjectIdString(mongoId)) {
    const found = await User.findById(mongoId).select(FIELDS).lean();
    if (found) return found;
  }
  const uid = req.firebaseUser?.uid || (!isObjectIdString(mongoId) && mongoId) || null;
  if (uid) return User.findOne({ firebaseUid: String(uid) }).select(FIELDS).lean();
  return null;
}

async function requireOnboarding(req, res, next) {
  if (!isOnboardingEnforced()) return next();
  try {
    const user = await sessionUser(req);
    // Sin usuario la propia ruta responde (401/404) como siempre
    if (!user || user.role === "club") return next();

    if (isUnderage(user)) {
      return res.status(403).json({ error: "underage", minAge: getMinAge() });
    }
    const missing = missingOnboarding(user);
    if (missing.length) {
      return res.status(403).json({ error: "onboarding_required", missingOnboarding: missing });
    }
    return next();
  } catch (err) {
    console.error("[requireOnboarding] error:", err?.message || err);
    // Con el control activado, ante la duda no se deja pasar
    return res.status(500).json({ error: "server_error" });
  }
}

module.exports = requireOnboarding;
module.exports.sessionUser = sessionUser;
