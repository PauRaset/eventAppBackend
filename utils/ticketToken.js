// utils/ticketToken.js
// Serial y token de las entradas. Compartido por el webhook de Stripe
// (emisión) y por /api/events/my-tickets/:ticketId/qr (QR en la app).
// ⚠️ El formato del token debe mantenerse idéntico: el QR es
// JSON.stringify({ serial, token }) y el token es "serial.timestamp.random.firma".
const crypto = require('crypto');

function genSerial() {
  const a = crypto.randomBytes(2).toString('hex').toUpperCase();
  const b = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `NV-${a}-${b}`;
}

function makeToken(serial) {
  const raw = `${serial}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const sig = crypto
    .createHmac('sha256', process.env.QR_HMAC_KEY || 'nv_dev')
    .update(raw)
    .digest('hex')
    .slice(0, 16);
  return `${raw}.${sig}`;
}

// "serial.timestamp.random.firma" — el random es base36 de hasta 6 caracteres
// (Math.random().toString(36).slice(2, 8) puede salir más corto).
const TOKEN_RE = /^(.+)\.(\d+)\.([0-9a-z]{0,6})\.([0-9a-f]{16})$/;

/**
 * Verifica un token de entrada sin tocar la base de datos: forma correcta,
 * que empiece por `serial` y que la firma HMAC cuadre con QR_HMAC_KEY.
 * Usado por el check-in (POST /api/checkin).
 *
 * ⚠️ Si QR_HMAC_KEY no está definida NO se valida la firma (devuelve true) y
 * se registra un error grave: es preferible dejar entrar a dejar fuera a todo
 * el mundo por una variable mal configurada.
 */
function verifyToken(token, serial) {
  if (typeof token !== 'string' || typeof serial !== 'string' || !serial) return false;

  const m = TOKEN_RE.exec(token);
  if (!m || m[1] !== serial) return false;

  const key = process.env.QR_HMAC_KEY;
  if (!key) {
    console.error(
      '🚨 [ticketToken.verifyToken] QR_HMAC_KEY NO DEFINIDA: el check-in NO está verificando la firma de las entradas.'
    );
    return true;
  }

  const raw = `${m[1]}.${m[2]}.${m[3]}`;
  const expected = crypto
    .createHmac('sha256', key)
    .update(raw)
    .digest('hex')
    .slice(0, 16);

  // Misma longitud garantizada por la regex (16 hex) -> timingSafeEqual no lanza
  return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(m[4], 'utf8'));
}

module.exports = { genSerial, makeToken, verifyToken };
