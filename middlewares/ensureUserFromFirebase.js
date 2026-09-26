// middlewares/ensureUserFromFirebase.js
const User = require('../models/User');

async function ensureUserFromFirebase(req, res, next) {
  try {
    const f = req.firebaseUser;
    if (!f || !f.uid) {
      return res.status(401).json({ message: 'No hay usuario Firebase verificado' });
    }

    const user = await User.findOrCreateFromFirebase({
      uid: f.uid,
      phoneNumber: f.phone,
      displayName: f.name,
      photoURL: f.picture,
    });

    req.user = user; // usuario de Mongo
    return next();
  } catch (err) {
    console.error('[ensureUserFromFirebase] error:', err);
    return res.status(500).json({ message: 'No se pudo resolver el usuario' });
  }
}

module.exports = { ensureUserFromFirebase };