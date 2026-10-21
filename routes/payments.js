// routes/payments.js
const express = require('express');
const Stripe = require('stripe');
const Order = require('../models/Order');
const Event = require('../models/Event');
const Club = require('../models/Club');
const User = require('../models/User');
const { reserveStock, releaseStock, sweepExpiredReservations } = require('../utils/stock');
const { accessTypeOf } = require('../utils/accessType');

// Respuesta para eventos gratuitos en las rutas de compra (Stripe no admite 0 €).
//  free_limited: la plaza se reserva gratis desde la app (POST /api/events/:id/reserve) -> 400
//  free_open:    no hace falta entrada, basta marcar asistencia -> 400
const FREE_ACCESS_ERRORS = {
  free_limited: {
    status: 400,
    error: 'free_reservation_required',
    title: 'Evento gratuito',
    message: 'Este evento es gratuito con aforo limitado: reserva tu plaza gratis desde la app NightVibe.',
  },
  free_open: {
    status: 400,
    error: 'no_ticket_required',
    title: 'Entrada libre',
    message: 'Este evento es de entrada libre: no necesitas entrada. Marca que vas desde la app.',
  },
};

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

// Imagen del producto en Stripe Checkout. Nunca lanza: si el valor no es una
// ruta/URL utilizable devuelve null y el checkout sigue sin imagen.
// event.photos guarda objetos { url, status, ... } (strings solo en datos legacy).
const buildAbsoluteImageUrl = (req, value) => {
  let raw = value;
  if (raw && typeof raw === 'object') {
    if (raw.status && raw.status !== 'approved') return null; // nunca fotos sin moderar
    raw = raw.url;
  }
  if (typeof raw !== 'string') return null;
  const path = raw.trim();
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  const base = process.env.PUBLIC_UPLOADS_BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
};

const resolveEventImageUrl = (req, event) => {
  try {
    const fromImage = buildAbsoluteImageUrl(req, event && event.image);
    if (fromImage) return fromImage;
    const photos = event && Array.isArray(event.photos) ? event.photos : [];
    for (const p of photos) {
      const url = buildAbsoluteImageUrl(req, p);
      if (url) return url;
    }
  } catch (e) {
    console.warn('[checkout] imagen del evento ignorada:', e && e.message);
  }
  return null;
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

/**
 * Paso 3b de la resolución del club (compartido por /direct y /checkout).
 * El club puede tener ownerUserId guardado como EMAIL en vez de como
 * ObjectId (así lo guarda el registro del portal). Buscamos por el email
 * del usuario propietario. Devuelve el club (lean) o null.
 *
 * Autorreparación: si lo encuentra así, guarda event.club = Club._id para que
 * la próxima compra entre por el paso 1 (Club.findById(event.club)).
 * NO toca event.clubId: sigue siendo el _id del User, que es lo que usan
 * /mine, las promociones y referralAnalytics (/club/:clubId/event/:eventId).
 */
async function findClubByOwnerEmail(event, logTag) {
  const ownerUserId = event.createdBy || event.clubId || event.organizerId || null;
  if (!ownerUserId) return null;

  const ownerUser = await User.findById(ownerUserId).lean();
  const rawEmail = (ownerUser?.email || '').trim();
  const ownerEmail = rawEmail.toLowerCase();
  if (!ownerEmail) return null;

  const club = await Club.findOne({
    ownerUserId: { $in: [...new Set([ownerEmail, rawEmail])] },
  }).lean();
  if (!club) return null;

  console.log(`[${logTag}] club resuelto por EMAIL del propietario:`, {
    eventId: String(event._id),
    clubId: String(club._id),
    ownerEmail,
  });

  try {
    await Event.updateOne({ _id: event._id }, { $set: { club: club._id } });
    console.log(`[${logTag}] evento reparado: club ->`, String(club._id));
  } catch (repairErr) {
    console.warn(`[${logTag}] no se pudo reparar el vínculo:`, repairErr.message);
  }
  return club;
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


/* ==================================================================
   PROTECCIÓN DE RESERVAS (/direct y /checkout)
   - GET /direct ya NO reserva: devuelve la página del evento (la que ven
     las previsualizaciones de WhatsApp, iMessage...). Solo el POST que
     envía el botón "Comprar" reserva y abre Stripe.
   - Bots de previsualización: nunca pueden iniciar una compra.
   - Límites de peticiones y tope de entradas reservadas a la vez.
   La reserva dura 30 min: es el mínimo que Stripe admite para expires_at,
   así que la reserva nunca caduca antes que la sesión que respalda.
================================================================== */
const rateLimit = require('express-rate-limit');

const RESERVATION_MS = 30 * 60 * 1000;
const MAX_QTY_DIRECT = 10;
// Generosos a propósito: en la puerta del local mucha gente comparte la IP
// (wifi del club, operadores móviles con IP compartida).
const MAX_ACTIVE_RESERVED_PER_IP = Number(process.env.DIRECT_MAX_ACTIVE_PER_IP) || 30;
const MAX_ACTIVE_RESERVED_PER_USER = Number(process.env.CHECKOUT_MAX_ACTIVE_PER_USER) || 20;

// Previsualizadores de enlaces y rastreadores conocidos. iMessage se presenta
// como "facebookexternalhit ... Twitterbot". Es una capa extra: lo que de
// verdad protege es que el GET no reserve.
const PREVIEW_BOT_RE =
  /(whatsapp|facebookexternalhit|facebot|meta-externalagent|twitterbot|slackbot|slack-imgproxy|telegrambot|discordbot|linkedinbot|skypeuripreview|pinterest|redditbot|embedly|applebot|googlebot|google-inspectiontool|bingbot|yandex|baiduspider|duckduckbot|snapchat|viber|vkshare|line\/|kakaotalk|crawler|spider|headlesschrome)/i;

function isPreviewBot(req) {
  const ua = String(req.get('user-agent') || '').trim();
  if (!ua) return true; // un navegador real siempre manda user-agent
  return PREVIEW_BOT_RE.test(ua);
}

/** Entradas reservadas ahora mismo (sin pagar y sin caducar) que cumplen `match`. */
async function activeReservedQty(match) {
  const rows = await Order.aggregate([
    { $match: { ...match, reservationActive: true, expiresAt: { $gt: new Date() } } },
    { $group: { _id: null, n: { $sum: '$reservedQty' } } },
  ]);
  return rows[0]?.n || 0;
}

/* ---------- Páginas HTML (estética oscura NightVibe) ---------- */

const NV_COLORS = { bg: '#0b0b10', card: '#15151d', line: '#26262f', text: '#f4f4f5', muted: '#a1a1aa', accent: '#a855f7' };

function pageShell({ title, head = '', body }) {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="theme-color" content="${NV_COLORS.bg}">
${head}
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:${NV_COLORS.bg};color:${NV_COLORS.text};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:480px;margin:0 auto;padding:20px 16px 40px}
.brand{font-weight:800;letter-spacing:.08em;font-size:13px;color:${NV_COLORS.accent};text-transform:uppercase;margin:4px 0 16px}
.poster{width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:18px;background:${NV_COLORS.card};display:block}
h1{font-size:26px;line-height:1.2;margin:18px 0 8px}
.meta{color:${NV_COLORS.muted};font-size:15px;line-height:1.5;margin:0}
.card{background:${NV_COLORS.card};border:1px solid ${NV_COLORS.line};border-radius:16px;padding:16px;margin-top:18px}
.tier{display:flex;align-items:center;gap:12px;padding:12px;border:1px solid ${NV_COLORS.line};border-radius:12px;margin-bottom:10px;cursor:pointer}
.tier:has(input:checked){border-color:${NV_COLORS.accent};background:rgba(168,85,247,.08)}
.tier input{accent-color:${NV_COLORS.accent};width:18px;height:18px;margin:0}
.tier .name{flex:1;font-weight:600}
.tier .left{display:block;font-weight:400;color:${NV_COLORS.muted};font-size:13px}
.tier .price{font-weight:700}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px}
select{background:${NV_COLORS.bg};color:${NV_COLORS.text};border:1px solid ${NV_COLORS.line};border-radius:10px;padding:10px 12px;font-size:16px}
.price-big{font-size:22px;font-weight:800}
.fee{color:${NV_COLORS.muted};font-size:13px;margin:10px 0 0}
.total{margin-top:14px;padding-top:14px;border-top:1px solid ${NV_COLORS.line};font-weight:700}
button,.btn{display:block;width:100%;margin-top:18px;padding:16px;border:0;border-radius:14px;background:${NV_COLORS.accent};color:#fff;font-size:17px;font-weight:700;text-align:center;text-decoration:none;cursor:pointer}
button:disabled{background:${NV_COLORS.line};color:${NV_COLORS.muted};cursor:not-allowed}
.notice{margin-top:18px;padding:14px;border-radius:12px;background:${NV_COLORS.card};border:1px solid ${NV_COLORS.line};color:${NV_COLORS.muted};text-align:center}
.small{color:${NV_COLORS.muted};font-size:12px;text-align:center;margin-top:14px}
</style></head>
<body><main>${body}</main></body></html>`;
}

/** Página de aviso (errores, límites) con la misma estética. */
function sendInfoPage(res, status, { title, message, event = null, eventId = null }) {
  const id = eventId || (event ? String(event._id) : null);
  const back = id
    ? `<a class="btn" href="/api/payments/direct/${encodeURIComponent(id)}">Volver al evento</a>`
    : '';
  const body = `<div class="brand">NightVibe</div>
<h1>${escapeHtml(title)}</h1>
${event && event.title ? `<p class="meta">${escapeHtml(event.title)}</p>` : ''}
${message ? `<p class="notice">${escapeHtml(message)}</p>` : ''}
${back}`;
  return res.status(status).type('html').send(pageShell({ title: `${title} · NightVibe`, body }));
}

function formatEventDate(d) {
  if (!d) return '';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  try {
    const s = new Intl.DateTimeFormat('es-ES', {
      weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid',
    }).format(date);
    return s.charAt(0).toUpperCase() + s.slice(1);
  } catch (_) {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** Nombre del local para la página: Club vinculado o, si no, el usuario que lo creó. */
async function venueNameForEvent(event) {
  try {
    if (event.club) {
      const c = await Club.findById(event.club).select('name').lean();
      if (c?.name) return c.name;
    }
    if (event.createdBy) {
      const u = await User.findById(event.createdBy).select('displayName username').lean();
      return u?.displayName || u?.username || '';
    }
  } catch (_) {}
  return '';
}

/**
 * Qué se puede comprar ahora en la página: tandas comprables (con precio > 0)
 * o el precio único. Devuelve { options, blocked, maxQty }.
 * blocked = texto si no se puede comprar (agotado, venta cerrada, gratis...).
 */
function directPurchaseState(event) {
  const now = new Date();
  // Gratuitos: sin compra (entrada libre, o reserva gratuita aún no disponible)
  const access = accessTypeOf(event);
  if (access === 'free_open') {
    return { options: [], blocked: 'Entrada libre: no necesitas entrada. Marca que vas desde la app.', label: 'Entrada libre', maxQty: 0 };
  }
  if (access === 'free_limited') {
    const left = event.capacity > 0
      ? Math.max(0, event.capacity - (event.ticketsSold || 0) - (event.ticketsReserved || 0))
      : null;
    return {
      options: [],
      blocked: left === 0
        ? 'Evento gratuito: no quedan plazas.'
        : 'Evento gratuito con aforo limitado. Reserva tu plaza gratis desde la app NightVibe.',
      label: 'Gratis · aforo limitado',
      maxQty: 0,
    };
  }
  if (event.salesStart && now < new Date(event.salesStart)) {
    return { options: [], blocked: `La venta empieza el ${formatEventDate(event.salesStart)}`, maxQty: 0 };
  }
  if (event.salesEnd && now > new Date(event.salesEnd)) {
    return { options: [], blocked: 'La venta ha finalizado', maxQty: 0 };
  }

  if (hasActiveTiers(event)) {
    const all = availableTiers(event);
    const options = all
      .map((t) => {
        const rem = tierRemaining(t);
        return { tierId: t.tierId, name: t.name, price: parsePrice(t.priceEUR), remaining: rem === Infinity ? null : rem };
      })
      .filter((o) => o.price !== null && o.price > 0);
    if (!all.length) return { options: [], blocked: 'Entradas agotadas', maxQty: 0 };
    if (!options.length) return { options: [], blocked: 'Las entradas de este evento no se venden online', maxQty: 0 };
    return { options, blocked: null, maxQty: MAX_QTY_DIRECT };
  }

  const rawPrice = event.price !== undefined && event.price !== null && event.price !== '' ? event.price : event.priceEUR;
  const price = parsePrice(rawPrice);
  if (price === null || !(price > 0)) {
    return { options: [], blocked: 'Las entradas de este evento no se venden online', maxQty: 0 };
  }
  let remaining = null;
  if (event.capacity > 0) {
    remaining = Math.max(0, event.capacity - (event.ticketsSold || 0) - (event.ticketsReserved || 0));
    if (remaining === 0) return { options: [], blocked: 'Entradas agotadas', maxQty: 0 };
  }
  return {
    options: [{ tierId: null, name: 'Entrada', price, remaining }],
    blocked: null,
    maxQty: Math.min(MAX_QTY_DIRECT, remaining ?? MAX_QTY_DIRECT),
  };
}

function platformFeeFor(event) {
  const v = parsePrice(event.platformFeeEUR);
  return v !== null ? Math.max(0, v) : 1.5;
}

/** GET /direct/:eventId — página del evento con Open Graph. NO reserva nada. */
async function renderDirectLanding(req, res) {
  const { eventId } = req.params;
  if (!mongoose.isValidObjectId(eventId)) {
    return sendInfoPage(res, 404, { title: 'Evento no encontrado' });
  }
  const event = await Event.findById(eventId).lean();
  if (!event || event.isPublished === false) {
    return sendInfoPage(res, 404, { title: 'Evento no encontrado', message: 'Este evento no existe o ya no está disponible.' });
  }

  const q = req.query || {};
  const state = directPurchaseState(event);
  const venue = await venueNameForEvent(event);
  const address = [event.street, event.city].filter(Boolean).join(', ');
  const when = formatEventDate(event.startAt || event.date);
  const imageUrl = resolveEventImageUrl(req, event);
  const fee = platformFeeFor(event);
  const minPrice = state.options.length ? Math.min(...state.options.map((o) => o.price)) : null;

  const pageUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const ogDescription = [when, venue || event.city, minPrice !== null ? `Desde ${formatEUR(minPrice)}` : state.label || state.blocked]
    .filter(Boolean)
    .join(' · ');

  const head = [
    `<meta name="description" content="${escapeHtml(ogDescription)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="NightVibe">`,
    `<meta property="og:locale" content="es_ES">`,
    `<meta property="og:title" content="${escapeHtml(event.title || 'Evento NightVibe')}">`,
    `<meta property="og:description" content="${escapeHtml(ogDescription)}">`,
    `<meta property="og:url" content="${escapeHtml(pageUrl)}">`,
    imageUrl ? `<meta property="og:image" content="${escapeHtml(imageUrl)}">` : '',
    imageUrl ? `<meta property="og:image:alt" content="${escapeHtml(event.title || 'Cartel del evento')}">` : '',
    `<meta name="twitter:card" content="${imageUrl ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${escapeHtml(event.title || 'Evento NightVibe')}">`,
    `<meta name="twitter:description" content="${escapeHtml(ogDescription)}">`,
    imageUrl ? `<meta name="twitter:image" content="${escapeHtml(imageUrl)}">` : '',
  ].filter(Boolean).join('\n');

  // Selección inicial: la tanda de ?tier= si es comprable; si no, la más barata.
  const wantedTier = typeof q.tier === 'string' ? q.tier.trim() : '';
  const cheapest = state.options.reduce((b, o) => (!b || o.price < b.price ? o : b), null);
  const selected = state.options.find((o) => o.tierId && o.tierId === wantedTier) || cheapest;
  let qty = Math.floor(Number(q.qty ?? q.q ?? 1));
  if (!Number.isFinite(qty) || qty < 1) qty = 1;
  if (state.maxQty) qty = Math.min(qty, state.maxQty);

  const hidden = ['ref', 'ch']
    .filter((k) => typeof q[k] === 'string' && q[k].trim())
    .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(q[k].trim().slice(0, 64))}">`)
    .join('');

  let purchaseHtml;
  if (state.blocked) {
    purchaseHtml = `<p class="notice">${escapeHtml(state.blocked)}</p>`;
  } else {
    const isTiers = state.options.length > 1 || (state.options[0] && state.options[0].tierId);
    const tiersHtml = isTiers
      ? state.options.map((o) => `<label class="tier">
<input type="radio" name="tier" value="${escapeHtml(o.tierId)}" data-price="${o.price}"${o === selected ? ' checked' : ''}>
<span class="name">${escapeHtml(o.name)}${o.remaining !== null && o.remaining <= 20 ? `<span class="left">Quedan ${o.remaining}</span>` : ''}</span>
<span class="price">${escapeHtml(formatEUR(o.price))}</span></label>`).join('')
      : `<div class="row"><span>Entrada</span><span class="price-big">${escapeHtml(formatEUR(selected.price))}</span></div>`;
    const qtyOptions = Array.from({ length: state.maxQty }, (_, i) => i + 1)
      .map((n) => `<option value="${n}"${n === qty ? ' selected' : ''}>${n}</option>`)
      .join('');
    purchaseHtml = `<form method="post" action="${escapeHtml(req.baseUrl + req.path)}" class="card" id="buy" data-fee="${fee}" data-price="${selected.price}">
${tiersHtml}
<div class="row" style="margin-top:12px"><label for="qty">Cantidad</label><select id="qty" name="qty">${qtyOptions}</select></div>
${fee > 0 ? `<p class="fee">+ ${escapeHtml(formatEUR(fee))} de gastos de gestión por entrada</p>` : ''}
<div class="row total"><span>Total</span><span id="total"></span></div>
${hidden}
<button type="submit">Comprar entradas</button>
<p class="small">Pago seguro con Stripe. Recibirás las entradas por email.</p>
</form>
<script>
(function(){var f=document.getElementById('buy');if(!f)return;var t=document.getElementById('total');
function eur(n){try{return new Intl.NumberFormat('es-ES',{style:'currency',currency:'EUR'}).format(n)}catch(e){return n.toFixed(2)+' €'}}
function upd(){var r=f.querySelector('input[name=tier]:checked');var p=parseFloat(r?r.dataset.price:f.dataset.price)||0;
var q=parseInt(f.qty.value,10)||1;t.textContent=eur(q*(p+(parseFloat(f.dataset.fee)||0)))}
f.addEventListener('change',upd);upd();
f.addEventListener('submit',function(){var b=f.querySelector('button');b.disabled=true;b.textContent='Abriendo el pago…'});})();
</script>`;
  }

  const body = `<div class="brand">NightVibe</div>
${imageUrl ? `<img class="poster" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(event.title || 'Cartel del evento')}">` : ''}
<h1>${escapeHtml(event.title || 'Evento')}</h1>
${when ? `<p class="meta">${escapeHtml(when)}</p>` : ''}
${venue ? `<p class="meta">${escapeHtml(venue)}</p>` : ''}
${address ? `<p class="meta">${escapeHtml(address)}</p>` : ''}
${purchaseHtml}`;

  res.set('Cache-Control', 'no-store');
  return res.status(200).type('html').send(pageShell({ title: `${event.title || 'Evento'} · NightVibe`, head, body }));
}

// Límites de peticiones (antes /api/payments/* no tenía ninguno)
const directPageLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60, // la página: solo contra rastreo masivo
  standardHeaders: true,
  legacyHeaders: false,
});
const directStartLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10, // compras iniciadas por IP cada 10 min
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) =>
    sendInfoPage(res, 429, {
      title: 'Demasiados intentos',
      message: 'Has iniciado muchas compras seguidas. Espera unos minutos y vuelve a intentarlo.',
      eventId: mongoose.isValidObjectId(req.params.eventId) ? req.params.eventId : null,
    }),
});


// POST /api/payments/direct/:eventId  (botón "Comprar" de la página del GET)
// Reserva, crea la orden y la sesión de Checkout y hace redirect 303 a Stripe.
// Datos del formulario: qty, tier, ref, ch.
async function startDirectCheckout(req, res) {
    try {
      const { eventId } = req.params;
      const input = req.body && typeof req.body === 'object' ? req.body : {};

      // Bots y clientes sin user-agent no pueden iniciar compras
      if (isPreviewBot(req)) {
        console.warn('[direct] compra rechazada: bot o sin user-agent', {
          eventId, ip: req.ip, ua: String(req.get('user-agent') || '').slice(0, 200),
        });
        return sendInfoPage(res, 403, { title: 'No se puede iniciar la compra', eventId: mongoose.isValidObjectId(eventId) ? eventId : null });
      }
      if (!mongoose.isValidObjectId(eventId)) {
        return sendInfoPage(res, 404, { title: 'Evento no encontrado' });
      }
      sweepExpiredReservations().catch(() => {});   // no bloqueante

      // === Share tracking (optional, non-breaking) ===
      // You can append these params to the /direct link when sharing:
      //   /api/payments/direct/:eventId?ref=XXXX&ch=ig_story
      // They will be persisted in Stripe session metadata so the webhook can attribute sales.
      const refCodeRaw = typeof input.ref === 'string' ? input.ref : '';
      const channelRaw = typeof input.ch === 'string' ? input.ch : '';

      const refCode = refCodeRaw.trim().slice(0, 64); // keep it short & safe
      const shareChannel = channelRaw.trim().slice(0, 64);
  
      const event = await Event.findById(eventId).lean();
      if (!event) {
        return sendInfoPage(res, 404, { title: 'Evento no encontrado' });
      }
  
      // Misma lógica de validaciones que en create-checkout-session
      const now = new Date();
      if (event.isPublished === false) {
        return sendInfoPage(res, 404, { title: 'Evento no encontrado', message: 'Este evento no existe o ya no está disponible.' });
      }
      if (event.salesStart && now < new Date(event.salesStart)) {
        return sendInfoPage(res, 400, { title: 'La venta todavía no ha empezado', event });
      }
      if (event.salesEnd && now > new Date(event.salesEnd)) {
        return sendInfoPage(res, 400, { title: 'La venta ha finalizado', event });
      }

      // Eventos gratuitos: no pasan por Stripe (antes, 400 de precio inválido)
      const freeAccess = FREE_ACCESS_ERRORS[accessTypeOf(event)];
      if (freeAccess) {
        if (req.accepts(['html', 'json']) === 'json') {
          return res.status(freeAccess.status).json({ error: freeAccess.error, message: freeAccess.message });
        }
        return sendInfoPage(res, freeAccess.status, { title: freeAccess.title, message: freeAccess.message, event });
      }
  
      // === Tandas: solo si el evento tiene ticketTiers activos ===
      // (?tier=<tierId>). Enlace viejo o tanda agotada -> la más barata comprable.
      // Sin tiers, tierSale es null y todo lo de abajo funciona como siempre.
      let tierSale = null;
      if (hasActiveTiers(event)) {
        const tierParam = typeof input.tier === 'string' ? input.tier.trim() : '';
        const sel = resolveTierForSale(event, tierParam, { fallbackToCheapest: true });
        if (sel.error) {
          return sendSoldOutPage(res, { event, nextTier: null, query: input });
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
        return sendInfoPage(res, 400, {
          title: 'Entradas no disponibles',
          message: 'Las entradas de este evento no se venden online.',
          event,
        });
      }

      // Cantidad del formulario (1..10, como la app)
      const qtyParam = input.qty ?? input.q;
      let qty = Math.floor(Number(qtyParam || 1));
      if (!Number.isFinite(qty) || qty < 1) qty = 1;
      if (qty > MAX_QTY_DIRECT) qty = MAX_QTY_DIRECT;

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
          return sendInfoPage(res, 400, { title: 'Entradas no disponibles', message: 'El evento no tiene club asociado.', event });
        }
        club = await Club.findOne({ ownerUserId }).lean();
        if (club) clubId = club._id;
      }

      // 3b) El club puede tener ownerUserId guardado como EMAIL en vez de como
      // ObjectId (así lo guarda el registro del portal). Buscamos por el email
      // del usuario propietario y reparamos event.club (ver findClubByOwnerEmail).
      if (!club) {
        club = await findClubByOwnerEmail(event, 'direct');
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
        return sendInfoPage(res, 400, {
          title: 'Entradas no disponibles',
          message: 'El club todavía no puede vender entradas online.',
          event,
        });
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
  
      // Tope de entradas reservadas a la vez por IP en este evento: un bucle de
      // compras sin pagar no puede dejar el evento agotado.
      const clientIp = String(req.ip || '');
      const alreadyReserved = await activeReservedQty({ eventId: String(event._id), clientIp });
      if (alreadyReserved + qty > MAX_ACTIVE_RESERVED_PER_IP) {
        console.warn('[direct] tope de reservas por IP', {
          eventId: String(event._id), ip: clientIp, alreadyReserved, qty, max: MAX_ACTIVE_RESERVED_PER_IP,
        });
        return sendInfoPage(res, 429, {
          title: 'Demasiadas entradas pendientes de pago',
          message: 'Desde tu conexión ya hay muchas entradas de este evento reservadas sin pagar. Termina esos pagos o espera unos minutos.',
          event,
        });
      }

      // Order "guest": sin userId ni email (Stripe nos dará el email)
      // Reserva de stock: aquí, ya validados evento, precio, club y Stripe, y
      // justo antes de crear la orden. Ningún return anterior puede dejar una
      // reserva sin orden (que el sweep no sabría encontrar ni liberar).
      let releaseTier = null;
      let reservationCounted = true; // las tandas siempre suman (reserveTierStock)
      if (tierSale) {
        const r = await reserveResolvedTier(event, tierSale.tier, qty);
        if (!r.ok) {
          const nextTier =
            r.reason === 'event_sold_out' ? null : laterPurchasableTier(r.event, tierSale.tier);
          return sendSoldOutPage(res, { event, nextTier, query: input });
        }
        releaseTier = r.release;
      } else {
        const reserved = await reserveStock(event._id, qty);
        if (!reserved.ok) {
          return sendSoldOutPage(res, { event, nextTier: null, query: input });
        }
        reservationCounted = reserved.counted;
      }
      // Liberar solo lo que de verdad se reservó (aforo ilimitado no suma nada)
      const releaseReservation = () =>
        releaseTier ? releaseTier() : reservationCounted ? releaseStock(event._id, qty) : undefined;

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
        reservationCounted,
        expiresAt: new Date(Date.now() + RESERVATION_MS),
        clientIp,
        ...(tierSale ? tierOrderFields(tierSale.tier, toCents(unit), qty, event.title) : {}),
      });
      } catch (orderErr) {
        await releaseReservation();
        throw orderErr;   // lo recoge el catch general (500), como antes
      }
  
      // ==== Cartel / imagen del evento para Stripe Checkout ====
      // ==== Cartel / imagen del evento para Stripe Checkout ====
      // event.image y, si no hay, la primera foto aprobada; null si nada sirve
      const eventImageUrl = resolveEventImageUrl(req, event);
  
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
          expires_at: Math.floor((Date.now() + RESERVATION_MS) / 1000),
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
        return sendInfoPage(res, 500, {
          title: 'No se pudo iniciar el pago',
          message: 'Inténtalo de nuevo en unos minutos.',
          event,
        });
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
      return sendInfoPage(res, 500, { title: 'No se pudo iniciar el pago', message: 'Inténtalo de nuevo en unos minutos.' });
    }
}

// GET: la página del evento (enlace estable para compartir). NO reserva.
// Las previsualizaciones (WhatsApp, iMessage...) y los HEAD llegan aquí.
router.get('/direct/:eventId', directPageLimiter, (req, res) =>
  renderDirectLanding(req, res).catch((err) => {
    console.error('[direct] error en la página del evento:', err?.message || err);
    return sendInfoPage(res, 500, { title: 'No se pudo cargar el evento' });
  })
);
// POST: el botón "Comprar". Aquí sí se reserva y se abre Stripe.
router.post('/direct/:eventId', directStartLimiter, startDirectCheckout);


/* ==================================================================
   POST /api/payments/checkout  — compra desde la app (autenticada)
   Soporta tandas (ticketTiers). Responde JSON con la URL de Stripe.
   /direct queda intacto: la lógica de club, comisión y sesión está
   replicada aquí a propósito para no tocar el enlace web.
================================================================== */
const mongoose = require('mongoose');
const { anyAuth: anyAuthMw } = require('../middlewares/authMiddleware');

const MAX_QTY_APP = 10;

// Compras iniciadas por usuario (va DESPUÉS de resolveAppUser: req.user.id es
// el _id de Mongo, igual entre JWT y Firebase).
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `checkout:${req.user.id}`,
  handler: (req, res) =>
    res.status(429).json({
      error: 'too_many_requests',
      message: 'Has iniciado muchas compras seguidas. Espera unos minutos y vuelve a intentarlo.',
    }),
});

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
  // 3b) Club con ownerUserId = email del propietario
  if (!club) {
    club = await findClubByOwnerEmail(event, 'checkout');
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

router.post('/checkout', anyAuthMw, resolveAppUser, checkoutLimiter, async (req, res) => {
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

    // Referido (opcional): el refCode del enlace compartido desde el que llegó
    // el usuario. Igual que en /direct: va a los metadatos de Stripe y el webhook
    // lo resuelve a refUserId. Formato inválido -> se ignora (nunca bloquea la compra).
    const refCodeRaw = typeof body.refCode === 'string' ? body.refCode.trim() : '';
    const refCode = /^[A-Za-z0-9_-]{1,64}$/.test(refCodeRaw) ? refCodeRaw : '';
    const shareChannelRaw = typeof body.shareChannel === 'string' ? body.shareChannel.trim() : '';
    const shareChannel = refCode ? shareChannelRaw.slice(0, 64) : '';

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

    // 3b) Eventos gratuitos: no pasan por Stripe (antes, 400 de precio inválido)
    const freeAccess = FREE_ACCESS_ERRORS[accessTypeOf(event)];
    if (freeAccess) {
      return res.status(freeAccess.status).json({ error: freeAccess.error, message: freeAccess.message });
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

    // 5a) Tope de entradas reservadas a la vez por usuario en este evento
    const alreadyReserved = await activeReservedQty({ eventId: String(event._id), userId: String(req.user.id) });
    if (alreadyReserved + qty > MAX_ACTIVE_RESERVED_PER_USER) {
      console.warn('[checkout] tope de reservas por usuario', {
        eventId: String(event._id), userId: String(req.user.id), alreadyReserved, qty, max: MAX_ACTIVE_RESERVED_PER_USER,
      });
      return res.status(429).json({
        error: 'too_many_pending',
        message: 'Ya tienes muchas entradas de este evento pendientes de pago. Termina esos pagos o espera unos minutos.',
        pending: alreadyReserved,
        max: MAX_ACTIVE_RESERVED_PER_USER,
      });
    }

    // 5b/6) Reserva de stock
    let releaseTier = null;
    let reservationCounted = true; // las tandas siempre suman (reserveTierStock)
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
      const reserved = await reserveStock(event._id, qty);
      if (!reserved.ok) {
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
      reservationCounted = reserved.counted;
    }

    // A partir de aquí hay una reserva: cualquier fallo debe liberarla UNA vez
    // (y solo lo que de verdad se reservó: aforo ilimitado no suma nada).
    const release = () =>
      releaseTier ? releaseTier() : reservationCounted ? releaseStock(event._id, qty) : undefined;

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
        reservationCounted,
        expiresAt: new Date(Date.now() + RESERVATION_MS),
      });
    } catch (orderErr) {
      await release();
      throw orderErr;
    }

    // Imagen y descripción: igual que /direct
    const eventImageUrl = resolveEventImageUrl(req, event);

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
          ...(refCode ? { refCode } : {}),
          ...(shareChannel ? { shareChannel } : {}),
        },
        allow_promotion_codes: true,
        expires_at: Math.floor((Date.now() + RESERVATION_MS) / 1000),
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
