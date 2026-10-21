// routes/stripeWebhooks.js
const express2 = require('express');
const Stripe2 = require('stripe');
const crypto = require('crypto');
const QRCode = require('qrcode');
const Order2 = require('../models/Order');
const UnmatchedPayment = require('../models/UnmatchedPayment');
let ShareLink;
try {
  ShareLink = require('../models/ShareLink');
} catch (_) {
  ShareLink = null;
}
const Event2 = require('../models/Event');
const Ticket = require('../models/Ticket');
const sendTicketEmail = require('../utils/sendTicketEmail');

const router2 = express2.Router();
const stripe2 = new Stripe2(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

// Serial y token del QR: compartidos con /api/events/my-tickets/:ticketId/qr
const { genSerial, makeToken } = require('../utils/ticketToken');

/**
 * Recalcula la misión referred_purchases de quien compartió el enlace de esta
 * orden. En segundo plano y sin lanzar nunca: un fallo aquí no debe afectar al
 * pago, a la emisión de tickets ni a la respuesta a Stripe.
 * (Carga perezosa de eventRoutes para no depender del orden de carga.)
 */
function syncReferralForOrder(order, motivo) {
  setImmediate(() => {
    Promise.resolve()
      .then(() =>
        require('./eventRoutes').syncReferralForEvent({
          userKey: order.refUserId,
          eventId: String(order.eventId),
        })
      )
      .catch((e) =>
        console.warn(`[stripe webhook] referral sync (${motivo}) falló:`, e?.message || e)
      );
  });
}

async function sendTicketEmailWithRetry(payload, { attempts = 3, baseDelayMs = 800 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await sendTicketEmail(payload);
    } catch (err) {
      lastErr = err;
      const status = err?.code || err?.response?.statusCode;
      console.warn(`[stripe webhook] intento email ${i}/${attempts} falló (status=${status}):`, err?.message || err);
      if (/Email destinatario inválido/i.test(String(err?.message || ''))) break;
      if (i < attempts) {
        await new Promise((r) => setTimeout(r, baseDelayMs * i));
      }
    }
  }
  throw lastErr;
}

router2.post('/', express2.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe2.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (e) {
    console.error('Webhook signature failed:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  try {
    console.log('[stripe webhook] type =', event.type);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const meta = session.metadata || {};

      // === Share attribution (optional) ===
      const refCodeFromMetaRaw = typeof meta.refCode === 'string' ? meta.refCode : '';
      const shareChannelFromMetaRaw = typeof meta.shareChannel === 'string' ? meta.shareChannel : '';
      const refCode = refCodeFromMetaRaw.trim().slice(0, 64);
      const shareChannel = shareChannelFromMetaRaw.trim().slice(0, 64);

      // Resolve refUserId from refCode (if ShareLink model is available)
      let refUserId = null;
      if (ShareLink && refCode) {
        try {
          const sl = await ShareLink.findOne({ refCode }).lean();
          if (sl && sl.createdByUserId) refUserId = String(sl.createdByUserId);
        } catch (e) {
          console.warn('[stripe webhook] ShareLink lookup failed:', e?.message || e);
        }
      }

      // Tema/plantilla para Email + PDF (idealmente viene desde Checkout metadata)
      const ticketThemeFromMeta = typeof meta.ticketTheme === 'string' ? meta.ticketTheme.trim() : '';

      console.log('[stripe webhook] metadata =', meta);

      const sessionId = session.id;
      const eventId = meta.eventId || null;
      const userId = meta.userId || null;
      const qtyMeta = meta.qty ? Number(meta.qty) : 1;

      // Email fiable desde Stripe
      const stripeEmail =
        session.customer_details?.email ||
        session.customer_email ||
        null;

      let order = null;
      if (meta.orderId) {
        order = await Order2.findById(meta.orderId);
        if (!order) {
          console.warn(
            '[stripe webhook] orderId en metadata pero no existe en Mongo:',
            meta.orderId
          );
        }
      }

      if (!order) {
        order = await Order2.findOne({ stripeSessionId: sessionId });
      }

      if (!order) {
        // Pago que no sale de /checkout ni de /direct (esas crean la orden antes
        // y mandan su orderId): enlace de pago del panel, otra integración, o el
        // antiguo POST /api/orders. El importe no está verificado contra ningún
        // precio, así que NO se emiten entradas: se registra para revisión manual
        // y se responde 200 para que Stripe no reintente.
        const reason = meta.orderId ? 'order_id_not_found' : 'no_order_id';
        const amountTotal = typeof session.amount_total === 'number' ? session.amount_total : null;
        console.error('[stripe webhook] ⚠️ PAGO SIN ORDEN: NO se emiten entradas, revisar a mano', {
          reason,
          sessionId,
          paymentIntentId: session.payment_intent || null,
          amountTotalCents: amountTotal,
          currency: session.currency || null,
          email: stripeEmail,
          livemode: session.livemode,
          stripeEventId: event.id,
          metadata: meta,
        });
        try {
          await UnmatchedPayment.updateOne(
            { stripeSessionId: sessionId },
            {
              $setOnInsert: {
                stripeSessionId: sessionId,
                paymentIntentId: session.payment_intent || null,
                amountTotalCents: amountTotal,
                currency: session.currency || null,
                email: stripeEmail,
                livemode: typeof session.livemode === 'boolean' ? session.livemode : null,
                stripeEventId: event.id || null,
                metadata: meta,
                reason,
              },
            },
            { upsert: true }
          );
        } catch (e) {
          // Reintento simultáneo de Stripe (E11000): ya está registrado
          if (!(e && e.code === 11000)) {
            console.error('[stripe webhook] no se pudo registrar el pago sin orden:', sessionId, e?.message || e);
          }
        }
        return res.json({ ok: true, unmatched: true, ticketsIssued: false });
      } else {
        // Order existente: idempotencia
        if (order.status === 'paid' && order.ticketsIssuedAt) {
          console.log('[stripe webhook] order already paid and issued:', order._id);
          return res.json({ ok: true });
        }
        if (order.status === 'paid' && !order.ticketsIssuedAt) {
          console.warn('[stripe webhook] orden pagada SIN tickets emitidos, reintentando emisión:', String(order._id));
          // seguimos adelante: la idempotencia de tickets nos protege
        }
        order.status = 'paid';
        order.paymentIntentId = session.payment_intent || order.paymentIntentId;
        order.email = order.email || stripeEmail || order.email;

        // Persist latest Stripe metadata (including optional share attribution)
        order.sessionMetadata = {
          ...(order.sessionMetadata || {}),
          ...(meta || {}),
          ...(refCode ? { refCode } : {}),
          ...(shareChannel ? { shareChannel } : {}),
        };

        // Persist attribution fields (non-breaking)
        order.refCode = refCode || order.refCode || null;
        order.shareChannel = shareChannel || order.shareChannel || null;
        order.refUserId = refUserId || order.refUserId || null;

        await order.save();
      }

      // Misión referred_purchases de quien compartió el enlace (recalcula desde
      // los datos: idempotente si Stripe reintenta). No bloquea la emisión de tickets.
      if (order.refUserId) {
        syncReferralForOrder(order, 'pago');
      }

      const usedQty = order.qty || qtyMeta || 1;

      // --- Actualizar contador ticketsSold ---
      const evt = await Event2.findById(eventId).lean();

      // Fallback: si Stripe metadata no trae ticketTheme, lo leemos del evento
      const ticketThemeFromEvent = typeof evt?.ticketTheme === 'string' ? evt.ticketTheme.trim() : '';
      const ticketThemeResolved = ticketThemeFromMeta || ticketThemeFromEvent || 'default';
      console.log('[stripe webhook] ticketTheme resolved =', {
        fromMeta: ticketThemeFromMeta,
        fromEvent: ticketThemeFromEvent,
        final: ticketThemeResolved,
      });

      // --- Idempotencia: salir antes de emitir si ya están todos los tickets ---
      const yaEmitidos = await Ticket.countDocuments({ orderId: order._id });
      if (yaEmitidos >= usedQty) {
        console.log('[stripe webhook] tickets ya emitidos para la orden', String(order._id));
        return res.json({ ok: true, alreadyIssued: true });
      }

      // --- Actualizar contador ticketsSold ---
      const {
        commitStock,
        commitTierStock,
        addTierSoldWithoutReservation,
        orderReservationCounted,
      } = require('../utils/stock');
      if (order.reservationActive) {
        if (order.tierId) {
          await commitTierStock(eventId, order.tierId, usedQty);   // tier: sold+, reserved-
        } else {
          // suma venta y libera reserva (solo si la reserva sumó: aforo ilimitado no suma)
          await commitStock(eventId, usedQty, { counted: orderReservationCounted(order) });
        }
        order.reservationActive = false;
        // Persistimos ya: si la emisión falla y Stripe reintenta, no volvemos a sumar.
        await order.save();
      } else if (order.tierId) {
        // Orden de tanda cuya reserva ya se liberó (caducó justo antes del pago):
        // la venta cuenta igualmente en la tanda.
        await addTierSoldWithoutReservation(eventId, order.tierId, usedQty);
      } else {
        // Orden sin reserva (compras antiguas o creadas al vuelo)
        await Event2.updateOne({ _id: eventId }, { $inc: { ticketsSold: usedQty } });
      }

      const created = [];
      for (let i = 0; i < usedQty; i++) {
        const serial = genSerial();
        const token = makeToken(serial);
        const tokenHash = crypto
          .createHash('sha256')
          .update(token)
          .digest('hex');
        const qrPayload = JSON.stringify({ serial, token });
        const qrPngBuffer = await QRCode.toBuffer(qrPayload, {
          type: 'png',
          scale: 6,
          margin: 1,
        });

        const t = await Ticket.create({
          eventId,
          orderId: order._id,
          ownerUserId: userId,
          email: order.email || stripeEmail,
          ticketTypeId: order.tierId || null,
          serial,
          tokenHash,
          status: 'issued',
        });

        created.push({ doc: t, qrPngBuffer });
      }

      order.ticketsIssuedAt = new Date();
      await order.save();

      // --- Enviar email (1 SOLO correo con N entradas) ---
      try {
        const freshEvt = evt || (await Event2.findById(eventId).lean());
        const clubName =
          freshEvt?.clubName || freshEvt?.club?.entityName || '';
        const venue = freshEvt?.locationName || freshEvt?.venue || '';
        const eventDate = freshEvt?.startAt
          ? new Date(freshEvt.startAt).toLocaleString('es-ES', {
              dateStyle: 'medium',
              timeStyle: 'short',
            })
          : '';

        const toEmail = order.email || stripeEmail;
        if (!toEmail) {
          console.warn('[stripe webhook] No email found in order/session; skipping email send.', {
            orderId: String(order._id),
            sessionId,
          });
        } else {
          // Nuevo payload: lista de tickets para PDF multipase (1 email, 1 PDF con N entradas)
          const tickets = created.map((x) => ({
            serial: x.doc.serial,
            qrPngBuffer: x.qrPngBuffer,
          }));

          console.log(
            '[stripe webhook] sending ticket email to',
            toEmail,
            'qty=',
            tickets.length
          );

          await sendTicketEmailWithRetry({
            to: toEmail,
            eventTitle: freshEvt?.title || 'Entrada NightVibe',
            clubName,
            eventDate,
            venue,

            // ✅ NUEVO: todos los tickets
            tickets,

            // ✅ Retrocompatibilidad (por si sendTicketEmail aún espera 1)
            serial: tickets[0]?.serial,
            qrPngBuffer: tickets[0]?.qrPngBuffer,

            ticketTheme: ticketThemeResolved,
            buyerName: '',
          });

          try {
            order.emailSentAt = new Date();
            order.emailLastTo = toEmail;
            order.emailError = null;
            order.emailAttempts = (order.emailAttempts || 0) + 1;
            await order.save();
          } catch (persistErr) {
            console.error('[stripe webhook] no se pudo guardar emailSentAt:', persistErr?.message || persistErr);
          }
        }
      } catch (e) {
        console.error('Email ticket error:', e);
        try {
          order.emailError = String(e?.message || e).slice(0, 500);
          order.emailAttempts = (order.emailAttempts || 0) + 1;
          await order.save();
        } catch (persistErr) {
          console.error('[stripe webhook] no se pudo guardar emailError:', persistErr?.message || persistErr);
        }
      }
    }

    if (event.type === 'checkout.session.expired') {
      const session = event.data.object;
      // Reclamación atómica: si el sweep ya la liberó, no liberamos dos veces.
      const order = await Order2.findOneAndUpdate(
        { stripeSessionId: session.id, reservationActive: true },
        { $set: { reservationActive: false, status: 'expired' } }
      );
      if (order) {
        // Tanda o evento, y solo si la reserva sumó de verdad (Order.reservationCounted)
        const { releaseOrderStock } = require('../utils/stock');
        await releaseOrderStock(order);
        console.log('[stripe webhook] reserva liberada por expiración:', String(order._id));
      }
    }

    // ---- Refunds / cancelaciones ----
    if (
      event.type === 'charge.refunded' ||
      event.type === 'payment_intent.canceled'
    ) {
      // charge.refunded trae un Charge (su id es ch_…, el pago está en
      // charge.payment_intent); payment_intent.canceled trae el PaymentIntent.
      // Antes se buscaba siempre por obj.id, y en los reembolsos nunca casaba.
      const obj = event.data.object || {};
      const paymentIntentId =
        event.type === 'charge.refunded'
          ? (typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id) || null
          : obj.id || null;

      if (paymentIntentId) {
        const refundedOrder = await Order2.findOneAndUpdate(
          { paymentIntentId },
          { $set: { status: 'refunded' } },
          { new: true }
        ).lean();

        // referred_purchases se recalcula: la compra reembolsada deja de contar
        if (refundedOrder?.refUserId) {
          syncReferralForOrder(refundedOrder, 'reembolso');
        }
      } else {
        console.warn('[stripe webhook] reembolso/cancelación sin payment_intent:', event.type, obj.id);
      }
      // TODO: invalidar tickets si hace falta
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).send('Webhook handler failed');
  }
});

module.exports = router2;
