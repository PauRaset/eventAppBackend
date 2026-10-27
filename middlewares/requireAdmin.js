// middlewares/requireAdmin.js
// Acceso de ADMINISTRADOR (aprobar/rechazar clubs...). Vale CUALQUIERA de:
//   1) sesión (JWT o Firebase) de un usuario cuyo _id está en ADMIN_USER_IDS
//      (lista separada por comas en el .env);
//   2) cabecera X-Admin-Key igual a ADMIN_API_KEY (comparada en tiempo constante).
// Si NINGUNA de las dos variables está definida, responde 503: cerrado, nunca abierto.
// La clave es para uso desde servidor o terminal (curl): NUNCA en el código del portal.
const crypto = require('crypto');
const mongoose = require('mongoose');
const { optionalAnyAuth } = require('./authMiddleware');

let User = null;
try {
  User = require('../models/User');
} catch (_) {}

function adminUserIds() {
  return String(process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => mongoose.isValidObjectId(s));
}

/** Comparación en tiempo constante (hash de longitud fija: no depende de la longitud). */
function sameSecret(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

async function sessionMongoId(req) {
  const keys = [req.user?.id, req.userId, req.firebaseUser?.uid].filter(Boolean).map(String);
  if (!keys.length || !User) return null;
  const mongoKeys = keys.filter((k) => mongoose.isValidObjectId(k));
  const or = [{ firebaseUid: { $in: keys } }];
  if (mongoKeys.length) or.push({ _id: { $in: mongoKeys } });
  const u = await User.findOne({ $or: or }).select('_id').lean();
  return u ? String(u._id) : null;
}

async function checkAdmin(req, res, next) {
  try {
    const ids = adminUserIds();
    const key = String(process.env.ADMIN_API_KEY || '');
    if (!ids.length && !key) {
      console.error('🚨 [admin] ADMIN_USER_IDS y ADMIN_API_KEY sin definir: rutas de administración CERRADAS');
      return res.status(503).json({ error: 'admin_disabled', message: 'Administración no configurada' });
    }

    // 1) Clave de administración
    const givenKey = req.get('x-admin-key');
    if (key && givenKey && sameSecret(givenKey, key)) {
      req.admin = { via: 'key' };
      return next();
    }

    // 2) Sesión de un administrador
    const userId = ids.length ? await sessionMongoId(req) : null;
    if (userId && ids.includes(userId)) {
      req.admin = { via: 'session', userId };
      return next();
    }

    const tried = givenKey || userId || req.user?.id;
    console.warn('[admin] acceso DENEGADO', {
      path: req.originalUrl,
      method: req.method,
      ip: req.ip,
      by: userId || req.user?.id || null,
      withKey: !!givenKey,
    });
    if (!tried) {
      return res.status(401).json({ error: 'admin_auth_required', message: 'Se requiere acceso de administrador' });
    }
    return res.status(403).json({ error: 'forbidden', message: 'No tienes permisos de administrador' });
  } catch (err) {
    console.error('[admin] error comprobando acceso:', err?.message || err);
    return res.status(500).json({ error: 'server_error' });
  }
}

// Sesión opcional (para reconocer al admin) + comprobación
module.exports = [optionalAnyAuth, checkAdmin];
module.exports.checkAdmin = checkAdmin;
