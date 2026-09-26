// middlewares/requireFirebase.js
const { admin } = require('../firebase');
const User = require('../models/User');

/**
 * Extrae el ID token de:
 *  - Authorization: Bearer <token>  (o "Firebase <token>")
 *  - x-firebase-id-token: <token>
 *  - body.firebaseIdToken
 */
function extractToken(req) {
  const auth = req.headers.authorization || '';
  if (auth) {
    const [scheme, value] = auth.split(' ');
    if (/^Bearer$/i.test(scheme) || /^Firebase$/i.test(scheme)) return value;
  }
  if (req.headers['x-firebase-id-token']) return req.headers['x-firebase-id-token'];
  if (req.body && req.body.firebaseIdToken) return req.body.firebaseIdToken;
  return null;
}

module.exports = async function requireFirebase(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ message: 'Falta ID token' });

    const decoded = await admin.auth().verifyIdToken(token);

    // 1) Mantén compatibilidad con tu código actual
    req.auth = {
      uid: decoded.uid,
      phone: decoded.phone_number || null,
      email: decoded.email || null,
    };

    // 2) Añade firebaseUser (lo que espera ensureUserFromFirebase)
    req.firebaseUser = {
      uid: decoded.uid,
      phone: decoded.phone_number || null,
      email: decoded.email || null,
      name: decoded.name || decoded.displayName || null,
      picture: decoded.picture || decoded.photoURL || null,
    };

    // 3) Resuelve/crea usuario en Mongo (clave para promos/progreso)
    const user = await User.findOrCreateFromFirebase({
      uid: req.firebaseUser.uid,
      phoneNumber: req.firebaseUser.phone,
      displayName: req.firebaseUser.name,
      photoURL: req.firebaseUser.picture,
    });

    req.user = user; // usuario Mongo listo (req.user.id / req.user._id)

    return next();
  } catch (err) {
    console.error('Firebase verifyIdToken error:', err && err.message);

    // Si el token es inválido, 401. Si es DB, suele ser 500.
    // Pero en la práctica, aquí devolvemos 401 solo para token inválido
    // y 500 si el error parece de Mongo.
    const msg = (err && err.message) ? String(err.message) : '';
    if (msg.toLowerCase().includes('id token') || msg.toLowerCase().includes('token')) {
      return res.status(401).json({ message: 'Token inválido' });
    }
    return res.status(500).json({ message: 'No se pudo resolver el usuario' });
  }
};


/*const { admin } = require('../firebase');


function extractToken(req) {
  const auth = req.headers.authorization || '';
  if (auth) {
    const [scheme, value] = auth.split(' ');
    if (/^Bearer$/i.test(scheme) || /^Firebase$/i.test(scheme)) return value;
  }
  if (req.headers['x-firebase-id-token']) return req.headers['x-firebase-id-token'];
  if (req.body && req.body.firebaseIdToken) return req.body.firebaseIdToken;
  return null;
}

module.exports = async function requireFirebase(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ message: 'Falta ID token' });

    const decoded = await admin.auth().verifyIdToken(token);

    // Disponibiliza datos útiles para el controlador
    req.auth = {
      uid: decoded.uid,
      phone: decoded.phone_number || null,
      email: decoded.email || null,
    };

    return next();
  } catch (err) {
    console.error('Firebase verifyIdToken error:', err && err.message);
    return res.status(401).json({ message: 'Token inválido' });
  }
};*/
