// utils/ticketIssuing.js
// Emisión de entradas, común al pago con Stripe (routes/stripeWebhooks.js) y a
// la reserva gratuita (POST /api/events/:id/reserve). Sacado del webhook SIN
// cambiar su comportamiento, salvo dos arreglos de reintento:
//  - la venta se cuenta UNA sola vez (Order.stockCommittedAt, reclamado de
//    forma atómica); antes, si la emisión fallaba y Stripe reintentaba, las
//    órdenes ya confirmadas sumaban ticketsSold otra vez;
//  - solo se emiten las entradas que FALTAN; antes un fallo en la 2 de 3
//    acababa en 1 + 3 = 4 entradas.
const crypto = require('crypto');
const QRCode = require('qrcode');
const Order = require('../models/Order');
const Event = require('../models/Event');
const Ticket = require('../models/Ticket');
// sendTicketEmail se carga al enviar (no al cargar el módulo): exige
// SENDGRID_API_KEY al cargarse, y este módulo lo cargan también scripts que
// nunca envían emails (p. ej. backfillAccumulatedMissions.js vía eventRoutes).
let sendTicketEmailFn = null;
function sendTicketEmail(payload) {
  if (!sendTicketEmailFn) sendTicketEmailFn = require('./sendTicketEmail');
  return sendTicketEmailFn(payload);
}
const { genSerial, makeToken } = require('./ticketToken');
const {
  commitStock,
  commitTierStock,
  addTierSoldWithoutReservation,
  orderReservationCounted,
} = require('./stock');

async function sendTicketEmailWithRetry(payload, { attempts = 3, baseDelayMs = 800, logTag = 'stripe webhook' } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await sendTicketEmail(payload);
    } catch (err) {
      lastErr = err;
      const status = err?.code || err?.response?.statusCode;
      console.warn(`[${logTag}] intento email ${i}/${attempts} falló (status=${status}):`, err?.message || err);
      if (/Email destinatario inválido/i.test(String(err?.message || ''))) break;
      if (i < attempts) {
        await new Promise((r) => setTimeout(r, baseDelayMs * i));
      }
    }
  }
  throw lastErr;
}

/** QR de una entrada a partir de su serial (token nuevo, firmado: vale en la puerta). */
async function qrPngForSerial(serial) {
  const token = makeToken(serial);
  const qrPayload = JSON.stringify({ serial, token });
  const qrPngBuffer = await QRCode.toBuffer(qrPayload, { type: 'png', scale: 6, margin: 1 });
  return { token, qrPngBuffer };
}

/**
 * (a) Convierte la reserva de la orden en venta, UNA sola vez.
 * Mismas ramas que tenía el webhook:
 *  - reserva activa de tanda   -> commitTierStock (sold+, reserved-)
 *  - reserva activa sin tanda  -> commitStock (resta reserva solo si sumó)
 *  - tanda con reserva liberada (pagó justo al caducar) -> addTierSoldWithoutReservation
 *  - sin reserva (compras antiguas o creadas al vuelo)  -> ticketsSold += qty
 * La orden se reclama de forma atómica (stockCommittedAt) y a la vez se marca
 * reservationActive: false, así que ni un reintento ni el barrido de reservas
 * pueden contarla o liberarla dos veces.
 * Devuelve { committed } (false si ya se contó en un intento anterior).
 */
async function commitOrderStock(order, { eventId, qty }) {
  const now = new Date();
  const claimed = await Order.findOneAndUpdate(
    { _id: order._id, stockCommittedAt: null },
    { $set: { stockCommittedAt: now, reservationActive: false } }
  ); // devuelve la orden ANTES del cambio
  if (!claimed) return { committed: false };

  // El documento en memoria refleja lo guardado (los order.save() posteriores no lo deshacen)
  order.stockCommittedAt = now;
  order.reservationActive = false;

  if (claimed.reservationActive) {
    if (claimed.tierId) {
      await commitTierStock(eventId, claimed.tierId, qty); // tier: sold+, reserved-
    } else {
      // suma venta y libera reserva (solo si la reserva sumó: aforo ilimitado no suma)
      await commitStock(eventId, qty, { counted: orderReservationCounted(claimed) });
    }
  } else if (claimed.tierId) {
    // Orden de tanda cuya reserva ya se liberó (caducó justo antes del pago):
    // la venta cuenta igualmente en la tanda.
    await addTierSoldWithoutReservation(eventId, claimed.tierId, qty);
  } else {
    // Orden sin reserva (compras antiguas o creadas al vuelo)
    await Event.updateOne({ _id: eventId }, { $inc: { ticketsSold: qty } });
  }
  return { committed: true };
}

/**
 * (b) Emite las entradas de la orden con su QR hasta llegar a `qty`: SOLO las
 * que faltan (si un intento anterior se quedó a medias, no se duplican).
 * Marca order.ticketsIssuedAt. Devuelve { created, tickets }:
 *  - created: las emitidas ahora
 *  - tickets: TODAS las válidas de la orden, cada una con su QR, para el email
 *    (las de un intento anterior nunca se llegaron a enviar: QR con token nuevo)
 */
async function issueTicketsForOrder({ order, eventId, qty, ownerUserId, email }) {
  const previous = await Ticket.find({ orderId: order._id }).select('_id serial status').lean();
  const missing = Math.max(0, qty - previous.length);

  const created = [];
  for (let i = 0; i < missing; i++) {
    const serial = genSerial();
    const { token, qrPngBuffer } = await qrPngForSerial(serial);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const t = await Ticket.create({
      eventId,
      orderId: order._id,
      ownerUserId,
      email,
      ticketTypeId: order.tierId || null,
      serial,
      tokenHash,
      status: 'issued',
    });

    created.push({ doc: t, serial, qrPngBuffer });
  }

  order.ticketsIssuedAt = new Date();
  await order.save();

  const fromBefore = [];
  for (const t of previous) {
    if (t.status !== 'issued' && t.status !== 'checked_in') continue;
    const { qrPngBuffer } = await qrPngForSerial(t.serial);
    fromBefore.push({ doc: t, serial: t.serial, qrPngBuffer });
  }
  if (previous.length) {
    console.warn('[tickets] orden con entradas de un intento anterior: emitidas solo las que faltaban', {
      orderId: String(order._id),
      before: previous.length,
      created: created.length,
      qty,
    });
  }

  return { created, tickets: [...fromBefore, ...created] };
}

/**
 * (c) Envía UN email con todas las entradas (PDF adjunto) y guarda
 * emailSentAt / emailLastTo / emailError / emailAttempts en la orden.
 * Nunca lanza: un fallo de email no deshace la emisión.
 * `seatLabel` (opcional) sale como "Entrada: ..." en el email y en el PDF.
 * Devuelve { sent, error? }.
 */
async function sendOrderTicketsEmail({
  order,
  event = null,
  eventId,
  toEmail,
  ticketTheme = 'default',
  tickets,
  seatLabel = '',
  logTag = 'stripe webhook',
  logContext = {},
}) {
  try {
    const freshEvt = event || (await Event.findById(eventId).lean());
    const clubName = freshEvt?.clubName || freshEvt?.club?.entityName || '';
    const venue = freshEvt?.locationName || freshEvt?.venue || '';
    const eventDate = freshEvt?.startAt
      ? new Date(freshEvt.startAt).toLocaleString('es-ES', {
          dateStyle: 'medium',
          timeStyle: 'short',
        })
      : '';

    if (!toEmail) {
      console.warn(`[${logTag}] No email found in order/session; skipping email send.`, {
        orderId: String(order._id),
        ...logContext,
      });
      return { sent: false, error: 'no_email' };
    }

    // Lista de tickets para PDF multipase (1 email, 1 PDF con N entradas)
    const list = tickets.map((x) => ({
      serial: x.serial,
      qrPngBuffer: x.qrPngBuffer,
      ...(seatLabel ? { seatLabel } : {}),
    }));

    console.log(`[${logTag}] sending ticket email to`, toEmail, 'qty=', list.length);

    await sendTicketEmailWithRetry(
      {
        to: toEmail,
        eventTitle: freshEvt?.title || 'Entrada NightVibe',
        clubName,
        eventDate,
        venue,

        // ✅ NUEVO: todos los tickets
        tickets: list,

        // ✅ Retrocompatibilidad (por si sendTicketEmail aún espera 1)
        serial: list[0]?.serial,
        qrPngBuffer: list[0]?.qrPngBuffer,

        ticketTheme,
        buyerName: '',
      },
      { logTag }
    );

    try {
      order.emailSentAt = new Date();
      order.emailLastTo = toEmail;
      order.emailError = null;
      order.emailAttempts = (order.emailAttempts || 0) + 1;
      await order.save();
    } catch (persistErr) {
      console.error(`[${logTag}] no se pudo guardar emailSentAt:`, persistErr?.message || persistErr);
    }
    return { sent: true };
  } catch (e) {
    console.error('Email ticket error:', e);
    try {
      order.emailError = String(e?.message || e).slice(0, 500);
      order.emailAttempts = (order.emailAttempts || 0) + 1;
      await order.save();
    } catch (persistErr) {
      console.error(`[${logTag}] no se pudo guardar emailError:`, persistErr?.message || persistErr);
    }
    return { sent: false, error: String(e?.message || e) };
  }
}

module.exports = {
  commitOrderStock,
  issueTicketsForOrder,
  sendOrderTicketsEmail,
  sendTicketEmailWithRetry,
  qrPngForSerial,
};
