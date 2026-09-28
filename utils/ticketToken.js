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

module.exports = { genSerial, makeToken };
