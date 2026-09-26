// routes/payments.js
const express = require('express');
const Stripe = require('stripe');
const Order = require('../models/Order');
const Event = require('../models/Event');
const Club = require('../models/Club');
const User = require('../models/User');
const { reserveStock, releaseStock, sweepExpiredReservations } = require('../utils/stock');

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

// Permite precios con coma o punto, y acepta formatos como "12,50", "12.50", "12,50€", " 12.50 € "
const parsePrice = (value) => {
  if (value === null || value === undefined) return null;

  // Si ya es número, lo devolvemos tal cual si es finito
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  let str = String(value).trim();
  if (!str) return null;

  // Quitamos símbolo de euro y espacios
  str = str.replace(/[€\s]/g, '');

  // Normalizamos coma a punto (ej: "12,50" -> "12.50")
  str = str.replace(',', '.');

  const n = Number(str);
  if (!Number.isFinite(n)) return null;
  return n;
};

const toCents = (n) => {
  const parsed = parsePrice(n);
  if (parsed === null) return NaN;
  return Math.round(parsed * 100);
};

// Selección de tema/plantilla para Email + PDF de entradas (se consume en el webhook)
// Nota: esto NO cambia el flujo de pago; solo añade metadata para que el webhook
// pueda decidir qué estética/plantilla aplicar.
const resolveTicketTheme = ({ event, club }) => {
  // 1) Si en el futuro guardas un tema en el evento, lo respetamos
  const eventTheme = event && typeof event.ticketTheme === 'string' ? event.ticketTheme.trim() : '';
  if (eventTheme) return eventTheme;

  // 2) Forzar tema para una cuenta concreta vía ENV (clubId o stripeAccountId)
  // Ejemplos:
  // - TICKET_THEME_CLUB_ID=655e... (Mongo ObjectId)
  // - TICKET_THEME_STRIPE_ACCOUNT_ID=acct_...
  // - TICKET_THEME_NAME=clubX
  const THEME_NAME = (process.env.TICKET_THEME_NAME || 'clubX').trim();
  const THEME_CLUB_ID = (process.env.TICKET_THEME_CLUB_ID || '').trim();
  const THEME_STRIPE_ACCOUNT_ID = (process.env.TICKET_THEME_STRIPE_ACCOUNT_ID || '').trim();

  if (THEME_CLUB_ID && String(club?._id || '') === THEME_CLUB_ID) return THEME_NAME;
  if (THEME_STRIPE_ACCOUNT_ID && String(club?.stripeAccountId || '') === THEME_STRIPE_ACCOUNT_ID) {
    return THEME_NAME;
  }

  // 3) Default
  return 'default';
};

/* ==================================================================
   Tandas (ticketTiers) — lógica compartida por /direct y /checkout.
   Un evento SIN tiers activos no pasa nunca por aquí.
================================================================== */
const {
  availableTiers,
  tierRemaining,
  reserveTierStock,
  releaseTierStock,
} = require('../utils/stock');

function hasActiveTiers(event) {
  return (event.ticketTiers || []).some((t) => t.active !== false);
}

/** Motivo por el que un tier concreto no se puede comprar ahora. */
function tierUnavailableReason(tier, now = new Date()) {
  if (!tier) return 'tier_not_found';
  if (tier.active === false) return 'tier_inactive';
  if (tier.salesStart && now < new Date(tier.salesStart)) return 'not_on_sale_yet';
  if (tier.salesEnd && now > new Date(tier.salesEnd)) return 'sales_ended';
  return 'tier_sold_out';
}

function publicTier(t) {
  if (!t) return null;
  const rem = tierRemaining(t);
  return {
    tierId: t.tierId,
    name: t.name,
    description: t.description || '',
    priceEUR: t.priceEUR,
    remaining: rem === Infinity ? null : rem,
  };
}

/** Siguiente tanda comprable con el mismo nombre (orden posterior), o null. */
function nextTierOf(event, tier) {
  if (!event || !tier) return null;
  const next = availableTiers(event).find(
    (t) => t.tierId !== tier.tierId && t.name === tier.name && (t.order ?? 0) > (tier.order ?? 0)
  );
  return publicTier(next);
}

/** Tanda comprable más barata (a igual precio, la de menor order), o null. */
function cheapestPurchasableTier(event) {
  return availableTiers(event).reduce(
    (best, t) => (!best || t.priceEUR < best.priceEUR ? t : best),
    null
  );
}

/**
 * Paso 1 de 2: elige la tanda a vender. No reserva nada.
 * - requestedTierId comprable -> esa tanda.
 * - requestedTierId no comprable -> fallbackToCheapest ? la más barata : error.
 * - sin requestedTierId -> la más barata.
 * El precio sale SIEMPRE del tier en Mongo.
 * Devuelve { tier, unit } o { error: 'tier_unavailable' | 'sold_out', reason, remaining?, nextTier }.
 */
function resolveTierForSale(event, requestedTierId, { fallbackToCheapest = false } = {}) {
  const purchasable = availableTiers(event);
  let tier = null;

  if (requestedTierId) {
    const requested = (event.ticketTiers || []).find((t) => t.tierId === requestedTierId) || null;
    if (requested && purchasable.some((t) => t.tierId === requested.tierId)) {
      tier = requested;
    } else if (!fallbackToCheapest) {
      return {
        error: 'tier_unavailable',
        reason: tierUnavailableReason(requested),
        nextTier: nextTierOf(event, requested),
      };
    }
  }

  if (!tier) tier = cheapestPurchasableTier(event);
  if (!tier) {
    return { error: 'sold_out', reason: 'event_sold_out', remaining: 0, nextTier: null };
  }
  return { tier, unit: parsePrice(tier.priceEUR) };
}

/**
 * Paso 2 de 2: reserva qty unidades de la tanda elegida (atómico).
 * Va separado del paso 1 para que cada ruta reserve DESPUÉS de sus
 * validaciones (precio, club/Stripe) y ningún return temprano deje una
 * reserva sin orden que la libere.
 * Devuelve { ok: true, release } o { ok: false, reason, remaining, nextTier, event }.
 */
async function reserveResolvedTier(event, tier, qty) {
  const r = await reserveTierStock(event._id, tier.tierId, qty);
  if (!r.ok) {
    const fresh = await Event.findById(event._id).lean();
    return {
      ok: false,
      reason: r.reason,
      remaining: r.remaining,
      nextTier: nextTierOf(fresh || event, tier),
      event: fresh || event,
    };
  }
  return { ok: true, release: () => releaseTierStock(event._id, tier.tierId, qty) };
}

/** Campos de la orden cuando se vende por tanda. */
function tierOrderFields(tier, unitCents, qty, fallbackName) {
  return {
    tierId: tier.tierId,
    tierName: tier.name,
    items: [
      {
        ticketTypeId: tier.tierId,
        name: tier.name || fallbackName || 'Entrada',
        unitAmount: unitCents,
        qty,
        currency: 'eur',
      },
    ],
  };
}

/** tierId/tierName para metadata de Stripe (valores string, cortos). */
function tierStripeMeta(tier) {
  return tier ? { tierId: tier.tierId, tierName: String(tier.name).slice(0, 100) } : {};
}

/** Nombre del producto en Stripe: "<título> · <tanda>", o el título a secas. */
function stripeProductName(event, tier) {
  const baseTitle = event.title || 'Entrada NightVibe';
  return tier ? `${baseTitle} · ${tier.name}` : baseTitle;
}

/* ---------- Página "Entradas agotadas" para /direct (navegador) ---------- */

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatEUR(n) {
  try {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n);
  } catch (_) {
    return `${Number(n).toFixed(2).replace('.', ',')} €`;
  }
}

/**
 * Tanda posterior comprable a la que enlazar desde la página de agotado:
 * primero la siguiente del mismo nombre; si no hay, cualquier tanda
 * comprable con orden posterior.
 */
function laterPurchasableTier(event, tier) {
  if (!event || !tier) return null;
  const sameName = nextTierOf(event, tier);
  if (sameName) return sameName;
  const later = availableTiers(event).find(
    (t) => t.tierId !== tier.tierId && (t.order ?? 0) > (tier.order ?? 0)
  );
  return publicTier(later);
}

function sendSoldOutPage(res, { event, nextTier, query }) {
  let linkHtml = '';
  if (nextTier) {
    // Conservamos qty y la atribución (ref/ch) del enlace original.
    const params = new URLSearchParams();
    params.set('tier', nextTier.tierId);
    ['qty', 'q', 'ref', 'ch'].forEach((k) => {
      if (typeof query[k] === 'string' && query[k]) params.set(k, query[k]);
    });
    const href = `/api/payments/direct/${encodeURIComponent(String(event._id))}?${params.toString()}`;
    linkHtml = `<a href="${escapeHtml(href)}" style="display:inline-block;margin-top:24px;padding:14px 22px;border-radius:12px;background:#a855f7;color:#fff;text-decoration:none;font-weight:600">Quedan entradas a ${escapeHtml(formatEUR(nextTier.priceEUR))}</a>`;
  }

  const title = event && event.title
    ? `<p style="margin:8px 0 0;color:#a1a1aa">${escapeHtml(event.title)}</p>`
    : '';
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Entradas agotadas · NightVibe</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b10;color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center;padding:24px;box-sizing:border-box">
<main style="max-width:420px">
<h1 style="margin:0;font-size:28px">Entradas agotadas</h1>
${title}
${linkHtml}
</main></body></html>`;

  return res.status(409).type('html').send(html);
}


  // GET /api/payments/direct/:eventId
// Enlace estable que puedes compartir (no caduca).
// Crea la sesión de Checkout y hace redirect 303 a Stripe.
router.get('/direct/:eventId', async (req, res) => {
    try {
      const { eventId } = req.params;
      sweepExpiredReservations().catch(() => {});   // no bloqueante

      // === Share tracking (optional, non-breaking) ===
      // You can append these params to the /direct link when sharing:
      //   /api/payments/direct/:eventId?ref=XXXX&ch=ig_story
      // They will be persisted in Stripe session metadata so the webhook can attribute sales.
      const refCodeRaw = typeof req.query.ref === 'string' ? req.query.ref : '';
      const channelRaw = typeof req.query.ch === 'string' ? req.query.ch : '';

      const refCode = refCodeRaw.trim().slice(0, 64); // keep it short & safe
      const shareChannel = channelRaw.trim().slice(0, 64);
  
      const event = await Event.findById(eventId).lean();
      if (!event) {
        return res.status(404).send('Evento no encontrado');
      }
  
      // Misma lógica de validaciones que en create-checkout-session
      const now = new Date();
      if (event.isPublished === false) {
        return res.status(400).send('Evento no publicado');
      }
      if (event.salesStart && now < new Date(event.salesStart)) {
        return res.status(400).send('La venta todavía no ha empezado');
      }
      if (event.salesEnd && now > new Date(event.salesEnd)) {
        return res.status(400).send('La venta ya ha finalizado');
      }
  
      // === Tandas: solo si el evento tiene ticketTiers activos ===
      // (?tier=<tierId>). Enlace viejo o tanda agotada -> la más barata comprable.
      // Sin tiers, tierSale es null y todo lo de abajo funciona como siempre.
      let tierSale = null;
      if (hasActiveTiers(event)) {
        const tierParam = typeof req.query.tier === 'string' ? req.query.tier.trim() : '';
        const sel = resolveTierForSale(event, tierParam, { fallbackToCheapest: true });
        if (sel.error) {
          return sendSoldOutPage(res, { event, nextTier: null, query: req.query });
        }
        tierSale = sel;
      }

      // --- Precio: soporta decimales con punto o coma ("12,50", "12.50", etc.) ---
      const rawPrice =
        event.price !== undefined && event.price !== null && event.price !== ''
          ? event.price
          : event.priceEUR;

      // Con tanda, el precio sale del tier en Mongo (nunca de la query).
      const unit = tierSale ? tierSale.unit : parsePrice(rawPrice);

      if (unit === null || !Number.isFinite(unit) || unit <= 0) {
        console.error('[direct] Precio inválido en /direct:', {
          rawPrice,
          eventPrice: event.price,
          eventPriceEUR: event.priceEUR,
        });
        return res.status(400).send('Precio inválido');
      }

      // Cantidad (opcional por query): /direct/:eventId?qty=3
      const qtyParam = req.query.qty ?? req.query.q;
      let qty = Math.floor(Number(qtyParam || 1));
      if (!Number.isFinite(qty) || qty < 1) qty = 1;
      if (qty > 20) qty = 20;

      // === Stripe Connect (robusto y retrocompatible) ===
      // IMPORTANTE: en algunos eventos `clubId` puede ser el USER (owner) y `club` puede ser el documento Club.
      // Para no romper eventos antiguos que ya funcionan, resolvemos en este orden:
      // 1) event.club (Club._id)
      // 2) event.clubId (si realmente era un Club._id)
      // 3) Club por ownerUserId (createdBy/clubId/organizerId)
      // 4) Fallback legacy: User.stripeAccountId

      let club = null;
      let clubId = null;

      // 1) Preferimos event.club (si existe)
      if (event.club) {
        club = await Club.findById(event.club).lean();
        if (club) clubId = club._id;
      }

      // 2) Si no, probamos event.clubId como Club._id (eventos antiguos)
      if (!club && event.clubId) {
        club = await Club.findById(event.clubId).lean();
        if (club) clubId = club._id;
      }

      // 3) Si sigue sin salir, probamos por ownerUserId (event.clubId/createdBy suelen ser el USER)
      if (!club) {
        const ownerUserId = event.createdBy || event.clubId || event.organizerId || null;
        if (!ownerUserId) {
          return res.status(400).send('El evento no tiene club asociado.');
        }
        club = await Club.findOne({ ownerUserId }).lean();
        if (club) clubId = club._id;
      }

      // 4) Fallback legacy: stripeAccountId guardado en el usuario
      if (!club || !club.stripeAccountId) {
        const ownerUserId = event.createdBy || event.clubId || event.organizerId || null;
        if (ownerUserId) {
          const user = await User.findById(ownerUserId).lean();
          if (user && user.stripeAccountId) {
            club = { _id: user._id, stripeAccountId: user.stripeAccountId };
            clubId = user._id;
          }
        }
      }

      if (!club || !club.stripeAccountId) {
        console.error('[direct] No se pudo resolver stripeAccountId (LIVE):', {
          eventId: String(event._id),
          eventClub: event.club ? String(event.club) : null,
          eventClubId: event.clubId ? String(event.clubId) : null,
          eventCreatedBy: event.createdBy ? String(event.createdBy) : null,
          eventOrganizerId: event.organizerId ? String(event.organizerId) : null,
        });
        return res.status(400).send('El club no tiene cuenta conectada en Stripe (LIVE).');
      }

      // Tema/plantilla para Email + PDF (se aplicará en el webhook)
      const ticketTheme = resolveTicketTheme({ event, club });
  
      // Comisión de plataforma por entrada:
      // - Por defecto: 1,50 €
      // - Si el evento tiene `platformFeeEUR`, se usa ese valor (en euros)
      const platformFeeEUR =
        parsePrice(event.platformFeeEUR) !== null
          ? parsePrice(event.platformFeeEUR)
          : 1.5;

      const PLATFORM_FEE_CENTS = Math.max(0, Math.round(platformFeeEUR * 100));
      const applicationFee = PLATFORM_FEE_CENTS * qty;

      // Opción A: el comprador paga la comisión como línea separada en Checkout
      // (y se retiene como application_fee_amount en Connect para que el club reciba solo el importe de entradas)
      const feeLineItem =
        PLATFORM_FEE_CENTS > 0
          ? {
              price_data: {
                currency: 'eur',
                unit_amount: PLATFORM_FEE_CENTS,
                product_data: {
                  name: 'Gastos de gestión · NightVibe',
                },
              },
              quantity: qty,
            }
          : null;

      console.log('💸 [direct] fee debug:', {
        eventId: String(event._id),
        qty,
        platformFeeEUR,
        PLATFORM_FEE_CENTS,
        applicationFee,
        feeLineAdded: !!feeLineItem,
        refCode,
        shareChannel,
      });
  
      // Order "guest": sin userId ni email (Stripe nos dará el email)
      // Reserva de stock: aquí, ya validados evento, precio, club y Stripe, y
      // justo antes de crear la orden. Ningún return anterior puede dejar una
      // reserva sin orden (que el sweep no sabría encontrar ni liberar).
      let releaseTier = null;
      if (tierSale) {
        const r = await reserveResolvedTier(event, tierSale.tier, qty);
        if (!r.ok) {
          const nextTier =
            r.reason === 'event_sold_out' ? null : laterPurchasableTier(r.event, tierSale.tier);
          return sendSoldOutPage(res, { event, nextTier, query: req.query });
        }
        releaseTier = r.release;
      } else {
        const reserved = await reserveStock(event._id, qty);
        if (!reserved) {
          return sendSoldOutPage(res, { event, nextTier: null, query: req.query });
        }
      }
      const releaseReservation = () => (releaseTier ? releaseTier() : releaseStock(event._id, qty));

      // Si la orden no llega a crearse, la reserva tampoco puede quedarse.
      let order;
      try {
        order = await Order.create({
        userId: null,
        eventId,
        clubId,
        qty,
        amountEUR: unit * qty,
        currency: 'eur',
        email: null,
        status: 'created',
        reservedQty: qty,
        reservationActive: true,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        ...(tierSale ? tierOrderFields(tierSale.tier, toCents(unit), qty, event.title) : {}),
      });
      } catch (orderErr) {
        await releaseReservation();
        throw orderErr;   // lo recoge el catch general (500), como antes
      }
  
      // ==== Cartel / imagen del evento para Stripe Checkout ====
      // ==== Cartel / imagen del evento para Stripe Checkout ====
      let eventImageUrl = null;

      // Función auxiliar para montar una URL absoluta desde una ruta relativa
      const buildAbsoluteImageUrl = (relativePath) => {
        if (!relativePath) return null;

        // si ya es absoluta, la devolvemos tal cual
        if (/^https?:\/\//.test(relativePath)) return relativePath;

        // nos aseguramos de que empieza por '/'
        let cleanPath = relativePath;
        if (!cleanPath.startsWith('/')) {
          cleanPath = '/' + cleanPath;
        }

        // base URL: env o dominio actual del backend
        const base =
          process.env.PUBLIC_UPLOADS_BASE_URL ||
          `${req.protocol}://${req.get('host')}`;

        return `${base}${cleanPath}`;
      };

      // 1) Intentamos con event.image
      if (event.image) {
        eventImageUrl = buildAbsoluteImageUrl(event.image);
      }

      // 2) Si no hay, probamos con la primera foto de event.photos
      if (
        !eventImageUrl &&
        Array.isArray(event.photos) &&
        event.photos.length > 0 &&
        event.photos[0]
      ) {
        eventImageUrl = buildAbsoluteImageUrl(event.photos[0]);
      }
  
      // Descripción opcional para Stripe
      const descriptionParts = [];
      if (event.city) descriptionParts.push(event.city);
      if (event.date) descriptionParts.push(new Date(event.date).toLocaleDateString('es-ES'));
      const productDescription =
        descriptionParts.length > 0
          ? descriptionParts.join(' • ')
          : 'Entrada para evento NightVibe';
  
      let session;
      try {
        session = await stripe.checkout.sessions.create({
          mode: 'payment',
          locale: 'es',
          line_items: [
            {
              price_data: {
                currency: 'eur',
                unit_amount: toCents(unit),
                product_data: {
                  name: tierSale ? stripeProductName(event, tierSale.tier) : event.title || 'Entrada NightVibe',
                  description: productDescription,
                  // 👇 solo añadimos images si tenemos una URL válida
                  ...(eventImageUrl ? { images: [eventImageUrl] } : {}),
                  metadata: {
                    eventId: String(event._id),
                    ticketTheme,
                    ...(refCode ? { refCode } : {}),
                    ...(shareChannel ? { shareChannel } : {}),
                  },
                },
              },
              quantity: qty,
            },
            ...(feeLineItem ? [feeLineItem] : []),
          ],
          // Mismo success/cancel que el flujo normal
          success_url: `${process.env.APP_BASE_URL}/purchase/success?sid={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.APP_BASE_URL}/event/${eventId}?cancelled=1`,
          metadata: {
            eventId: String(event._id),
            orderId: String(order._id),
            userId: '', // invitado
            clubId: String(clubId),
            ticketTheme,
            // Share attribution (optional)
            ...(refCode ? { refCode } : {}),
            ...(shareChannel ? { shareChannel } : {}),
            perTicketFeeCents: String(PLATFORM_FEE_CENTS),
            feeLineAdded: feeLineItem ? '1' : '0',
            ...(tierSale ? tierStripeMeta(tierSale.tier) : {}),
          },
          allow_promotion_codes: true,
          expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
          automatic_tax: { enabled: false },
          payment_intent_data: {
            application_fee_amount: applicationFee,
            transfer_data: { destination: club.stripeAccountId },
            on_behalf_of: club.stripeAccountId,
          },
        });
      } catch (stripeErr) {
        await releaseReservation();   // una sola liberación
        order.reservationActive = false;
        order.status = 'failed';
        await order.save().catch(() => {});
        console.error('[direct-checkout] error:', stripeErr?.raw || stripeErr);
        const msg = stripeErr?.raw?.message || 'No se pudo iniciar el pago';
        return res.status(500).send(msg);
      }
  
      order.stripeSessionId = session.id;
      order.sessionMetadata = {
        ...(session.metadata || {}),
        ...(refCode ? { refCode } : {}),
        ...(shareChannel ? { shareChannel } : {}),
      };
      await order.save();
  
      console.log('◆ [direct] Created Checkout Session:', {
        orderId: String(order._id),
        sessionId: session.id,
      });
  
      // Redirige al Checkout de Stripe
      return res.redirect(303, session.url);
    } catch (err) {
      console.error('[direct-checkout] error:', err?.raw || err);
      const msg = err?.raw?.message || 'No se pudo iniciar el pago';
      return res.status(500).send(msg);
    }
  });

/* ==================================================================
   POST /api/payments/checkout  — compra desde la app (autenticada)
   Soporta tandas (ticketTiers). Responde JSON con la URL de Stripe.
   /direct queda intacto: la lógica de club, comisión y sesión está
   replicada aquí a propósito para no tocar el enlace web.
================================================================== */
const mongoose = require('mongoose');
const { anyAuth: anyAuthMw } = require('../middlewares/authMiddleware');

const MAX_QTY_APP = 10;

// Deja req.user.id con el _id de Mongo, igual que ensureUserId de eventRoutes.js
// (el anyAuth de authMiddleware deja el UID de Firebase en req.user.id).
async function resolveAppUser(req, res, next) {
  try {
    let user = null;
    if (req.firebaseUser && req.firebaseUser.uid) {
      user = await User.findOrCreateFromFirebase({
        uid: req.firebaseUser.uid,
        phoneNumber: req.firebaseUser.phone_number || req.firebaseUser.phone || null,
      });
    } else if (req.user && req.user.id) {
      user = await User.findById(req.user.id).select('_id email').lean();
    }
    if (!user) return res.status(401).json({ error: 'unauthorized', message: 'Usuario no autenticado' });

    req.user = { id: String(user._id) };
    req.appUserEmail = user.email || null;
    return next();
  } catch (err) {
    console.error('[checkout] fallo resolviendo usuario:', err?.message || err);
    return res.status(401).json({ error: 'unauthorized', message: 'No autorizado' });
  }
}

/** Email utilizable para Stripe. Descarta los placeholder `<uid>@firebase.local`. */
function usableEmail(email) {
  if (typeof email !== 'string') return null;
  const e = email.trim();
  if (!e || /@firebase\.local$/i.test(e)) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

/** Mismo orden de resolución que /direct. Devuelve { club, clubId } o { error }. */
async function resolveStripeClub(event) {
  let club = null;
  let clubId = null;

  if (event.club) {
    club = await Club.findById(event.club).lean();
    if (club) clubId = club._id;
  }
  if (!club && event.clubId) {
    club = await Club.findById(event.clubId).lean();
    if (club) clubId = club._id;
  }
  if (!club) {
    const ownerUserId = event.createdBy || event.clubId || event.organizerId || null;
    if (!ownerUserId) return { error: 'El evento no tiene club asociado.' };
    club = await Club.findOne({ ownerUserId }).lean();
    if (club) clubId = club._id;
  }
  if (!club || !club.stripeAccountId) {
    const ownerUserId = event.createdBy || event.clubId || event.organizerId || null;
    if (ownerUserId) {
      const user = await User.findById(ownerUserId).lean();
      if (user && user.stripeAccountId) {
        club = { _id: user._id, stripeAccountId: user.stripeAccountId };
        clubId = user._id;
      }
    }
  }
  if (!club || !club.stripeAccountId) {
    console.error('[checkout] No se pudo resolver stripeAccountId (LIVE):', {
      eventId: String(event._id),
      eventClub: event.club ? String(event.club) : null,
      eventClubId: event.clubId ? String(event.clubId) : null,
      eventCreatedBy: event.createdBy ? String(event.createdBy) : null,
    });
    return { error: 'El club no tiene cuenta conectada en Stripe (LIVE).' };
  }
  return { club, clubId };
}

/** Añade status/sid a una URL (también deep links), respetando ? y #. */
function withParams(url, params) {
  const [base, hash] = url.split('#');
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${params}${hash !== undefined ? `#${hash}` : ''}`;
}

function parseReturnUrl(raw) {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  if (typeof raw !== 'string' || raw.length > 2000) return { error: 'returnUrl inválida' };
  try {
    const u = new URL(raw);
    if (['javascript:', 'data:', 'file:', 'vbscript:'].includes(u.protocol)) {
      return { error: 'returnUrl inválida' };
    }
    return { value: raw };
  } catch (_) {
    return { error: 'returnUrl inválida' };
  }
}

router.post('/checkout', anyAuthMw, resolveAppUser, async (req, res) => {
  // 1) Limpieza perezosa de reservas caducadas (no bloqueante)
  sweepExpiredReservations().catch(() => {});

  try {
    const body = req.body || {};
    const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
    if (!mongoose.isValidObjectId(eventId)) {
      return res.status(400).json({ error: 'invalid_event', message: 'eventId inválido' });
    }

    const qty = body.qty === undefined || body.qty === null || body.qty === '' ? 1 : Number(body.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_APP) {
      return res.status(400).json({
        error: 'invalid_qty',
        message: `La cantidad debe ser un entero entre 1 y ${MAX_QTY_APP}`,
      });
    }

    const returnUrlParsed = parseReturnUrl(body.returnUrl);
    if (returnUrlParsed.error) {
      return res.status(400).json({ error: 'invalid_return_url', message: returnUrlParsed.error });
    }
    const requestedTierId = typeof body.tierId === 'string' ? body.tierId.trim() : '';

    // 2) Evento
    const event = await Event.findById(eventId).lean();
    if (!event) return res.status(404).json({ error: 'event_not_found', message: 'Evento no encontrado' });

    // 3) Publicado y a la venta: mismo criterio que /direct
    const now = new Date();
    if (event.isPublished === false) {
      return res.status(400).json({ error: 'not_published', message: 'Evento no publicado' });
    }
    if (event.salesStart && now < new Date(event.salesStart)) {
      return res.status(400).json({ error: 'sales_not_started', message: 'La venta todavía no ha empezado' });
    }
    if (event.salesEnd && now > new Date(event.salesEnd)) {
      return res.status(400).json({ error: 'sales_ended', message: 'La venta ya ha finalizado' });
    }

    // 4) Club y cuenta de Stripe (igual que /direct)
    const resolved = await resolveStripeClub(event);
    if (resolved.error) {
      return res.status(400).json({ error: 'club_not_ready', message: resolved.error });
    }
    const { club, clubId } = resolved;

    // 5) Precio y tanda. ⚠️ El precio sale SIEMPRE de Mongo, nunca del body.
    let tier = null;
    let unit;

    if (hasActiveTiers(event)) {
      // La app pide una tanda concreta: si no es comprable, se lo decimos (409).
      const sel = resolveTierForSale(event, requestedTierId, { fallbackToCheapest: false });
      if (sel.error) {
        const { error, ...rest } = sel;
        return res.status(409).json({ error, ...rest });
      }
      tier = sel.tier;
      unit = sel.unit;
    } else {
      const rawPrice =
        event.price !== undefined && event.price !== null && event.price !== ''
          ? event.price
          : event.priceEUR;
      unit = parsePrice(rawPrice);
    }

    // Misma regla de precio que /direct
    if (unit === null || !Number.isFinite(unit) || unit <= 0) {
      console.error('[checkout] Precio inválido:', {
        eventId: String(event._id),
        tierId: tier ? tier.tierId : null,
      });
      return res.status(400).json({ error: 'invalid_price', message: 'Precio inválido' });
    }

    const tierId = tier ? tier.tierId : null;
    const tierName = tier ? tier.name : null;

    // 5b/6) Reserva de stock
    let releaseTier = null;
    if (tier) {
      const r = await reserveResolvedTier(event, tier, qty);
      if (!r.ok) {
        return res.status(409).json({
          error: 'sold_out',
          reason: r.reason,
          remaining: r.remaining,
          nextTier: r.nextTier,
        });
      }
      releaseTier = r.release;
    } else {
      const ok = await reserveStock(event._id, qty);
      if (!ok) {
        const fresh = await Event.findById(event._id)
          .select('capacity ticketsSold ticketsReserved')
          .lean();
        const remaining =
          fresh && fresh.capacity > 0
            ? Math.max(0, fresh.capacity - (fresh.ticketsSold || 0) - (fresh.ticketsReserved || 0))
            : 0;
        return res.status(409).json({
          error: 'sold_out',
          reason: 'event_sold_out',
          remaining,
          nextTier: null,
        });
      }
    }

    // A partir de aquí hay una reserva: cualquier fallo debe liberarla UNA vez.
    const release = () => (releaseTier ? releaseTier() : releaseStock(event._id, qty));

    const ticketTheme = resolveTicketTheme({ event, club });

    // Comisión: idéntica a /direct
    const platformFeeEUR =
      parsePrice(event.platformFeeEUR) !== null ? parsePrice(event.platformFeeEUR) : 1.5;
    const PLATFORM_FEE_CENTS = Math.max(0, Math.round(platformFeeEUR * 100));
    const applicationFee = PLATFORM_FEE_CENTS * qty;
    const feeLineItem =
      PLATFORM_FEE_CENTS > 0
        ? {
            price_data: {
              currency: 'eur',
              unit_amount: PLATFORM_FEE_CENTS,
              product_data: { name: 'Gastos de gestión · NightVibe' },
            },
            quantity: qty,
          }
        : null;

    const unitCents = toCents(unit);
    const email = usableEmail(req.appUserEmail);

    // 8) Orden
    let order;
    try {
      order = await Order.create({
        userId: req.user.id,
        email,
        eventId: String(event._id),
        clubId,
        qty,
        amountEUR: unit * qty,
        currency: 'eur',
        ...(tier
          ? tierOrderFields(tier, unitCents, qty, event.title)
          : {
              tierId: null,
              tierName: '',
              items: [
                {
                  ticketTypeId: null,
                  name: event.title || 'Entrada',
                  unitAmount: unitCents,
                  qty,
                  currency: 'eur',
                },
              ],
            }),
        status: 'pending',
        reservedQty: qty,
        reservationActive: true,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });
    } catch (orderErr) {
      await release();
      throw orderErr;
    }

    // Imagen y descripción: igual que /direct
    const buildAbsoluteImageUrl = (relativePath) => {
      if (!relativePath) return null;
      if (/^https?:\/\//.test(relativePath)) return relativePath;
      const cleanPath = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
      const base = process.env.PUBLIC_UPLOADS_BASE_URL || `${req.protocol}://${req.get('host')}`;
      return `${base}${cleanPath}`;
    };
    let eventImageUrl = event.image ? buildAbsoluteImageUrl(event.image) : null;
    if (!eventImageUrl && Array.isArray(event.photos) && event.photos.length > 0 && event.photos[0]) {
      eventImageUrl = buildAbsoluteImageUrl(event.photos[0]);
    }

    const descriptionParts = [];
    if (event.city) descriptionParts.push(event.city);
    if (event.date) descriptionParts.push(new Date(event.date).toLocaleDateString('es-ES'));
    const productDescription =
      descriptionParts.length > 0 ? descriptionParts.join(' • ') : 'Entrada para evento NightVibe';

    const productName = stripeProductName(event, tier);

    const returnUrl = returnUrlParsed.value;
    const successUrl = returnUrl
      ? withParams(returnUrl, 'status=success&sid={CHECKOUT_SESSION_ID}')
      : `${process.env.APP_BASE_URL}/purchase/success?sid={CHECKOUT_SESSION_ID}`;
    const cancelUrl = returnUrl
      ? withParams(returnUrl, `status=cancelled&eventId=${String(event._id)}`)
      : `${process.env.APP_BASE_URL}/event/${String(event._id)}?cancelled=1`;

    const tierMeta = tierStripeMeta(tier);

    // 9) Sesión de Stripe (misma estructura que /direct)
    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: 'payment',
        locale: 'es',
        line_items: [
          {
            price_data: {
              currency: 'eur',
              unit_amount: unitCents,
              product_data: {
                name: productName,
                description: productDescription,
                ...(eventImageUrl ? { images: [eventImageUrl] } : {}),
                metadata: {
                  eventId: String(event._id),
                  ticketTheme,
                  ...tierMeta,
                },
              },
            },
            quantity: qty,
          },
          ...(feeLineItem ? [feeLineItem] : []),
        ],
        success_url: successUrl,
        cancel_url: cancelUrl,
        ...(email ? { customer_email: email } : {}),
        metadata: {
          eventId: String(event._id),
          orderId: String(order._id),
          userId: String(req.user.id),
          clubId: String(clubId),
          ticketTheme,
          ...tierMeta,
          perTicketFeeCents: String(PLATFORM_FEE_CENTS),
          feeLineAdded: feeLineItem ? '1' : '0',
        },
        allow_promotion_codes: true,
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
        automatic_tax: { enabled: false },
        payment_intent_data: {
          application_fee_amount: applicationFee,
          transfer_data: { destination: club.stripeAccountId },
          on_behalf_of: club.stripeAccountId,
        },
      });
    } catch (stripeErr) {
      // 10) Una sola liberación
      await release();
      order.reservationActive = false;
      order.status = 'failed';
      await order.save().catch(() => {});
      console.error('[checkout] error Stripe:', stripeErr?.raw || stripeErr);
      return res.status(500).json({
        error: 'stripe_error',
        message: stripeErr?.raw?.message || 'No se pudo iniciar el pago',
      });
    }

    order.stripeSessionId = session.id;
    order.sessionMetadata = { ...(session.metadata || {}) };
    await order.save();

    console.log('◆ [checkout] Created Checkout Session:', {
      orderId: String(order._id),
      sessionId: session.id,
      tierId,
      qty,
    });

    // 11) Respuesta JSON para la app
    const subtotalCents = unitCents * qty;
    const feeCents = feeLineItem ? PLATFORM_FEE_CENTS * qty : 0;
    return res.json({
      ok: true,
      url: session.url,
      sessionId: session.id,
      orderId: String(order._id),
      tier: { tierId, name: tierName, priceEUR: unit },
      qty,
      subtotalEUR: subtotalCents / 100,
      feeEUR: feeCents / 100,
      totalEUR: (subtotalCents + feeCents) / 100,
    });
  } catch (err) {
    console.error('[checkout] error:', err?.raw || err);
    return res.status(500).json({
      error: 'checkout_error',
      message: err?.raw?.message || 'No se pudo iniciar el pago',
    });
  }
});

module.exports = router;
