// middlewares/firebaseAdmin.js
// Inicializa Firebase Admin como singleton con detección flexible de credenciales
// y projectId explícito para evitar "Unable to detect a Project Id...".

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

/* ───────────────────────── helpers ───────────────────────── */

function normalizePrivateKey(key) {
  if (!key) return key;
  // Soporta claves con \n literales y comillas envolventes accidentales
  let k = key;
  if (k.startsWith('"') && k.endsWith('"')) k = k.slice(1, -1);
  if (k.startsWith("'") && k.endsWith("'")) k = k.slice(1, -1);
  return k.replace(/\\n/g, '\n');
}

function readJson(absPath) {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch (e) {
    console.error('[firebaseAdmin] No se pudo leer JSON en', absPath, e.message);
    return null;
  }
}

function loadFromEnvTrio(env) {
  if (env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) {
    return {
      credential: admin.credential.cert({
        project_id: env.FIREBASE_PROJECT_ID,
        client_email: env.FIREBASE_CLIENT_EMAIL,
        private_key: normalizePrivateKey(env.FIREBASE_PRIVATE_KEY),
      }),
      projectId: env.FIREBASE_PROJECT_ID,
    };
  }
  return null;
}

function loadFromJsonString(env) {
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const json = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
      if (json.private_key) json.private_key = normalizePrivateKey(json.private_key);
      return { credential: admin.credential.cert(json), projectId: json.project_id };
    } catch (e) {
      console.error('[firebaseAdmin] FIREBASE_SERVICE_ACCOUNT_JSON inválido:', e.message);
    }
  }
  // Variante base64
  if (env.FIREBASE_SERVICE_ACCOUNT_B64) {
    try {
      const decoded = Buffer.from(env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8');
      const json = JSON.parse(decoded);
      if (json.private_key) json.private_key = normalizePrivateKey(json.private_key);
      return { credential: admin.credential.cert(json), projectId: json.project_id };
    } catch (e) {
      console.error('[firebaseAdmin] FIREBASE_SERVICE_ACCOUNT_B64 inválido:', e.message);
    }
  }
  return null;
}

function loadFromJsonPath(env) {
  const p =
    env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    env.FIREBASE_SERVICE_ACCOUNTS_PATH ||
    env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!p) return null;
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) {
    console.error('[firebaseAdmin] Ruta de credenciales no existe:', abs);
    return null;
  }
  const json = readJson(abs);
  if (!json) return null;
  return { credential: admin.credential.cert(json), projectId: json.project_id };
}

function loadCredentialAndProject() {
  const env = process.env;

  // 1) Ruta a JSON
  const fromPath = loadFromJsonPath(env);
  if (fromPath) return fromPath;

  // 2) JSON string / base64
  const fromJson = loadFromJsonString(env);
  if (fromJson) return fromJson;

  // 3) Trío de variables sueltas
  const fromTrio = loadFromEnvTrio(env);
  if (fromTrio) return fromTrio;

  // 4) Fallback ADC (GCE/Cloud Run, local gcloud auth application-default)
  try {
    const cred = admin.credential.applicationDefault();
    const projectId =
      env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || env.FIREBASE_PROJECT_ID || null;
    return { credential: cred, projectId };
  } catch (e) {
    console.error('[firebaseAdmin] Sin credenciales:', e.message);
    return { credential: null, projectId: null };
  }
}

/* ───────────────────────── init ───────────────────────── */

let cachedProjectId = null;

if (!admin.apps.length) {
  const { credential, projectId } = loadCredentialAndProject();
  if (!credential) {
    throw new Error('[firebaseAdmin] Falta configurar credenciales de Firebase Admin');
  }

  // En emulador, allow una inicialización simple; verifyIdToken funcionará sin validar firmas.
  const isEmulator =
    !!process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.FIREBASE_EMULATOR === '1';

  // Forzamos projectId explícito si lo tenemos para evitar warnings
  const options = projectId ? { credential, projectId } : { credential };

  admin.initializeApp(options);
  cachedProjectId = projectId || '(desconocido)';

  console.log(
    `✅ firebase-admin inicializado – projectId = ${cachedProjectId}${
      isEmulator ? ' (AUTH EMULATOR)' : ''
    }`
  );
}

/* ───────────────────────── exports ───────────────────────── */

function getProjectId() {
  try {
    // admin.app().options.projectId puede ser undefined si vino por ADC sin project detectado
    return cachedProjectId || admin.app().options.projectId || null;
  } catch {
    return cachedProjectId;
  }
}

module.exports = admin;
module.exports.getProjectId = getProjectId;
