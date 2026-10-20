// utils/accessType.js
// Tipo de acceso de un evento (Event.accessType):
//   free_open     entrada libre: no hace falta entrada, basta marcar asistencia
//   free_limited  gratis con aforo: hace falta entrada (gratuita) para reservar plaza
//   paid          de pago
//
// "Gratis" ya no se deduce del precio: lo decide el club. El precio y las
// tandas solo se usan para comprobar que el tipo es coherente y, en eventos
// sin tipo (anteriores al campo), para deducirlo.

const ACCESS_TYPES = ['free_open', 'free_limited', 'paid'];

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** ¿Tiene precio de pago? Con tandas manda el precio de las tandas; sin tandas, event.price. */
function hasPaidPrice({ price, ticketTiers } = {}) {
  const tiers = Array.isArray(ticketTiers) ? ticketTiers : [];
  if (tiers.length) return tiers.some((t) => (num(t && t.priceEUR) || 0) > 0);
  return (num(price) || 0) > 0;
}

/** Tipo deducido de precio y tandas (migración y eventos sin tipo): paid o free_open. */
function deriveAccessType(event) {
  return hasPaidPrice(event || {}) ? 'paid' : 'free_open';
}

/**
 * ¿Es coherente este tipo con el precio y las tandas? null si sí; si no,
 * { error, message }.
 *  - paid: necesita precio > 0 (o tandas de pago)
 *  - free_open / free_limited: sin precio ni tandas de pago
 * (free_open con tandas a 0 € es válido: las tandas no se usan, no hay entradas)
 */
function validateAccessType(accessType, { price, ticketTiers } = {}) {
  if (!ACCESS_TYPES.includes(accessType)) {
    return {
      error: 'invalid_access_type',
      allowed: ACCESS_TYPES,
      message: `Tipo de acceso no válido: "${accessType}"`,
    };
  }
  const paid = hasPaidPrice({ price, ticketTiers });
  if (accessType === 'paid' && !paid) {
    return { error: 'paid_requires_price', message: 'Un evento de pago necesita un precio mayor que 0' };
  }
  if (accessType !== 'paid' && paid) {
    return { error: 'free_event_with_price', message: 'Un evento gratuito no puede tener precio ni tandas de pago' };
  }
  return null;
}

/**
 * Tipo efectivo de un evento para responder a la app y para comprar: el
 * guardado si es coherente; si falta o no cuadra con el precio (evento
 * antiguo sin migrar: Mongoose le aplica el defecto free_open), el deducido.
 */
function accessTypeOf(event) {
  const stored = event && event.accessType;
  if (stored && !validateAccessType(stored, event)) return stored;
  return deriveAccessType(event);
}

/** Campos para las respuestas: { accessType, requiresTicket }. */
function accessInfo(event) {
  const accessType = accessTypeOf(event);
  return { accessType, requiresTicket: accessType !== 'free_open' };
}

module.exports = {
  ACCESS_TYPES,
  hasPaidPrice,
  deriveAccessType,
  validateAccessType,
  accessTypeOf,
  accessInfo,
};
