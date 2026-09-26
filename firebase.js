const admin = require('firebase-admin');
const path = require('path');

let app;
if (!admin.apps.length) {
  // Ruta ABSOLUTA al JSON que subiste
  const serviceAccountPath = path.resolve(
    __dirname,
    'firebase-service-account.json'
  );

  const serviceAccount = require(serviceAccountPath);

  app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
} else {
  app = admin.app();
}

module.exports = { admin: app };
