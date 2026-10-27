// utils/publicName.js
// Nombre PÚBLICO de un usuario: nunca puede salir nada derivado de su teléfono.
//
// Antes, a quien se registraba por teléfono se le GUARDABA como username
// "user_" + los 6 últimos dígitos del teléfono, y en algunas respuestas, si no
// había username, se mostraban los dígitos del teléfono. Aquí se decide qué se
// muestra; la base de datos NO se toca (los usernames guardados siguen igual).
//
// Regla: si el username (o el nombre visible) falta o parece derivado del
// teléfono, se muestra un alias neutro y estable sacado del _id:
// "user_" + 6 caracteres de un hash del _id (no revela nada y es siempre igual).
const crypto = require('crypto');

/** Alias neutro y estable de un usuario: "user_" + 6 hex de sha256(_id). */
function neutralAlias(userId) {
  const id = String(userId || '');
  if (!id) return 'user';
  return `user_${crypto.createHash('sha256').update(id).digest('hex').slice(0, 6)}`;
}

function digitsOf(s) {
  return String(s || '').replace(/\D/g, '');
}

/**
 * ¿Este nombre está sacado del teléfono?
 *  - con el teléfono: contiene una racha de 6+ dígitos que está en el teléfono
 *  - sin el teléfono (no siempre se carga): parece un username generado a
 *    partir de él ("user_" + 6 dígitos) o es un número de teléfono
 */
function looksPhoneDerived(name, phoneNumber = null) {
  const n = String(name || '').trim();
  if (!n) return false;
  const phone = digitsOf(phoneNumber);
  const gen = /^user_(\d{6})$/i.exec(n); // username generado antiguo
  if (gen) {
    // Con el teléfono: solo si son SUS 6 últimos dígitos (mismo criterio que
    // scripts/migratePhoneUsernames.js); sin él, por precaución, sí.
    return phone.length >= 6 ? phone.slice(-6) === gen[1] : true;
  }
  if (/^\+?[\d\s().-]{7,}$/.test(n) && digitsOf(n).length >= 7) return true; // un teléfono
  if (phone.length >= 6) {
    const runs = n.match(/\d{6,}/g) || [];
    if (runs.some((r) => phone.includes(r))) return true;
  }
  return false;
}

/** Nombre utilizable o null si falta o sale del teléfono. */
function safeName(name, phoneNumber = null) {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n || looksPhoneDerived(n, phoneNumber)) return null;
  return n;
}

/**
 * @usuario público. `u`: { _id, username, phoneNumber? } (el teléfono solo se
 * usa para detectar, nunca se devuelve).
 */
function publicUsername(u) {
  if (!u) return 'user';
  return safeName(u.username, u.phoneNumber) || neutralAlias(u._id || u.id);
}

/** Nombre visible público: nombre de entidad (clubs) o, si no, el @usuario público. */
function publicDisplayName(u) {
  if (!u) return 'user';
  return (
    safeName(u.entityName, u.phoneNumber) ||
    safeName(u.entName, u.phoneNumber) ||
    safeName(u.displayName, u.phoneNumber) ||
    publicUsername(u)
  );
}

/**
 * Un nombre YA GUARDADO en otro documento (autor de una foto, firma,
 * notificación...) de un usuario cuyo teléfono no tenemos a mano: si parece
 * del teléfono, se sustituye por el alias de ese usuario.
 */
function publicStoredName(name, userId) {
  return safeName(name) || (userId ? neutralAlias(userId) : null);
}

/**
 * Para objetos de usuario populados que se devuelven tal cual (createdBy,
 * actor...): copia con username / displayName públicos y SIN datos privados:
 * teléfono, email, firebaseUid, listas de seguidores/seguidos ni solicitudes.
 */
function sanitizePublicUser(u) {
  if (!u || typeof u !== 'object') return u;
  const out = { ...u };
  out.username = publicUsername(u);
  if ('displayName' in out) out.displayName = safeName(u.displayName, u.phoneNumber) || '';
  if ('entName' in out) out.entName = safeName(u.entName, u.phoneNumber) || '';
  if ('entityName' in out) out.entityName = safeName(u.entityName, u.phoneNumber) || '';
  for (const k of [
    'phoneNumber', 'phone', 'email', 'firebaseUid', 'password',
    'followers', 'following', 'followRequestsReceived', 'followRequestsSent',
  ]) delete out[k];
  return out;
}

/** Filtro Mongo: excluir de una búsqueda por username los derivados del teléfono. */
const NOT_PHONE_DERIVED_USERNAME = { username: { $not: /^user_\d{6}$/i } };

module.exports = {
  neutralAlias,
  looksPhoneDerived,
  publicUsername,
  publicDisplayName,
  publicStoredName,
  sanitizePublicUser,
  NOT_PHONE_DERIVED_USERNAME,
};
