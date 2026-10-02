// index.js (entrypoint)
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const bodyParser = require("body-parser"); // <- para el webhook RAW
const Stripe = require("stripe");          // <- Stripe SDK
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const clubRoutes = require("./routes/clubRoutes");
const socialRoutes = require("./routes/socialRoutes");

// (opcional) Payments routes (links de compra / redirects)
let paymentRoutes = null;
try {
  // En este repo el archivo suele llamarse routes/payments.js (plural)
  paymentRoutes = require('./routes/payment');
  console.log('✅ routes/payment cargado');
} catch (e1) {
  try {
    paymentRoutes = require('./routes/payments');
    console.log('✅ routes/payments cargado');
  } catch (e2) {
    console.error('❌ No se pudo cargar ./routes/payment ni ./routes/payments (payments deshabilitado):', e2);
  }
}

// (opcional) Share / referrals (tracking de compartidos)
let shareRoutes = null;
try {
  shareRoutes = require('./routes/share');
  console.log('✅ routes/share cargado');
} catch (e) {
  console.error('❌ No se pudo cargar ./routes/share (tracking deshabilitado):', e);
}

let referralAnalyticsRoutes = null;
try {
  referralAnalyticsRoutes = require('./routes/referralAnalytics');
  console.log('✅ routes/referralAnalytics cargado');
} catch (e) {
  console.error('❌ No se pudo cargar ./routes/referralAnalytics (analytics deshabilitado):', e);
}
const { anyAuthWithId, anyAuth, ensureUserId } = require("./middlewares/authMiddleware");

// ✅ Inicializa firebase-admin y loguea el project_id para depurar 403
const admin = require("./middlewares/firebaseAdmin");
console.log("firebase-admin project:", admin.app().options.credential?.projectId || process.env.FIREBASE_PROJECT_ID || "(desconocido)");

const app = express();
// Detrás de nginx: confiar en el primer proxy para que req.ip sea la IP real del
// cliente (X-Forwarded-For). Lo necesita express-rate-limit para limitar por IP;
// sin esto todas las peticiones parecerían venir de la misma IP (la de nginx).
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// Validación de variables críticas en producción
if (process.env.NODE_ENV === 'production') {
  const missing = [];
  for (const key of [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'MONGO_URI',
    'QR_HMAC_KEY',
  ]) {
    if (!process.env[key]) missing.push(key);
  }
  if (missing.length) {
    console.error('❌ Faltan variables de entorno:', missing.join(', '));
    // No detenemos el proceso automáticamente para no romper despliegues, pero dejamos claro el error:
  }
}

// Rutas de diagnóstico. Desactivadas salvo que se activen explícitamente.
const DEBUG_ROUTES_ENABLED = process.env.ENABLE_DEBUG_ROUTES === 'true';
console.log('Debug routes:', DEBUG_ROUTES_ENABLED ? 'ACTIVADAS' : 'desactivadas');

// ===== Stripe =====
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

// ===== CARGAS NUEVAS (models/utils) =====
const QRCode = require("qrcode");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const Order = require("./models/Order");
const Ticket = require("./models/Ticket");
const CheckInLog = require("./models/CheckInLog");
const sendTicketEmail = require("./utils/sendTicketEmail");
const sendSimpleEmail = require("./utils/sendSimpleEmail");
const { verifyToken } = require("./utils/ticketToken");
const ClubApplication = require("./models/ClubApplication");
const jwt = require("jsonwebtoken");

// (opcional) Modelo Club para pagos al organizador vía Stripe Connect
let Club = null;
try {
  Club = require("./models/Club"); // Debe exponer { stripeAccountId }
} catch {
  console.warn("ℹ️ models/Club no encontrado. Payouts a clubs deshabilitados.");
}

// (opcional) Modelo Event para derivar clubId cuando no venga del cliente
let EventModel = null;
try {
  EventModel = require("./models/Event");
} catch {
  console.warn("ℹ️ models/Event no encontrado. Derivación de clubId por eventId limitada.");
}

// (opcional) Modelo User para poder mapear createdBy -> email/_id
let UserModel = null;
try {
  UserModel = require("./models/User");
} catch {
  console.warn("ℹ️ models/User no encontrado. Derivación por createdBy limitada.");
}

// ============================================================================
//   CORS — lista cerrada de orígenes (sin comodín *.vercel.app: con
//   credentials:true permitiría a cualquier despliegue de Vercel llamar a la API)
// ============================================================================
const FRONTEND_URL = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");

const staticAllowed = new Set([
  FRONTEND_URL,                        // si está definida
  "https://nightvibe.life",            // web pública (páginas /t/<token>)
  "https://clubs.nightvibe.life",      // portal de clubs, dominio propio
  "https://nvclubs.vercel.app",        // portal de clubs, Vercel
  "https://nvclubs-test.vercel.app",   // portal de pruebas
  // Desarrollo local: solo con las rutas de debug activadas, nunca abierto en producción
  ...(DEBUG_ROUTES_ENABLED ? ["http://localhost:3000"] : []),
].filter(Boolean));

function isAllowedOrigin(origin) {
  try {
    if (!origin) return true; // app Flutter, webhooks de Stripe, servidor a servidor
    if (staticAllowed.has(origin)) return true;

    const { protocol, hostname } = new URL(origin);
    // Subdominios propios, solo por https
    if (protocol === "https:" && hostname.endsWith(".nightvibe.life")) return true;

    return false;
  } catch {
    return false;
  }
}

// Config común de CORS para usar tanto en app.use como en preflight (OPTIONS)
const corsOptions = {
  origin: (origin, cb) =>
    isAllowedOrigin(origin)
      ? cb(null, true)
      : cb(new Error(`CORS no permitido para: ${origin}`)),
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  credentials: true,
  allowedHeaders: [
    "Authorization",
    "Content-Type",
    "X-Requested-With",
    "Accept",
    "Origin",
    "X-Scanner-Key", // necesario para el escáner
  ],
  exposedHeaders: ["Authorization", "Content-Type"],
};

app.use(cors(corsOptions));
// Responder preflight explícitamente con la MISMA config
app.options("*", cors(corsOptions));
// DEBUG temporal: ver headers y si llega Authorization/Cookie
if (DEBUG_ROUTES_ENABLED) {
  app.all('/api/debug/echo', (req, res) => {
    res.json({
      method: req.method,
      url: req.url,
      headers: req.headers,
      cookies: req.cookies || null,
    });
  });
}
// Captura errores de CORS y responde JSON en lugar de romper la petición
app.use((err, _req, res, next) => {
  if (err && /CORS no permitido/.test(String(err.message || ''))) {
    return res.status(403).json({ error: 'cors_blocked', message: err.message });
  }
  return next(err);
});

// ===== Seguridad producción =====
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

// Limitar ráfagas para endpoints sensibles
const createLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 60,             // 60 peticiones por IP/min
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(["/api/orders"], createLimiter);

// ===== Webhook Stripe (RAW body) — debe ir ANTES de express.json() =====
// Soporte para ambos secretos de Stripe (plataforma y cuentas conectadas)
const STRIPE_WEBHOOK_SECRET_PLATFORM = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_WEBHOOK_SECRET_CONNECT = process.env.STRIPE_WEBHOOK_SECRET_CONNECT || "";

// Logs de configuración de los secretos (sin mostrar el valor completo)
function safeSecret(secret) {
  if (!secret) return "(no definido)";
  return secret.slice(0, 6) + "***" + secret.slice(-4);
}
console.log("Stripe Webhook Secret (plataforma):", safeSecret(STRIPE_WEBHOOK_SECRET_PLATFORM));
console.log("Stripe Webhook Secret (connect):   ", safeSecret(STRIPE_WEBHOOK_SECRET_CONNECT));
if (!STRIPE_WEBHOOK_SECRET_PLATFORM) {
  console.warn("❌ Falta STRIPE_WEBHOOK_SECRET (plataforma) en variables de entorno.");
}
if (!STRIPE_WEBHOOK_SECRET_CONNECT) {
  console.warn("❌ Falta STRIPE_WEBHOOK_SECRET_CONNECT (connect) en variables de entorno.");
}

// Monta el router de webhooks (el módulo exporta un Router listo)
const stripeWebhooksRouter = require('./routes/stripeWebhooks');
app.use('/api/webhooks/stripe', stripeWebhooksRouter);


if (DEBUG_ROUTES_ENABLED) {
  // === DEBUG: ver estado de una Checkout Session (y su PI) ===
  app.get("/api/debug/checkout-session/:sid", async (req, res) => {
    try {
      const sid = req.params.sid;
      const sess = await stripe.checkout.sessions.retrieve(sid, {
        expand: ["payment_intent", "payment_intent.latest_charge", "payment_intent.transfer_data"],
      });
      res.json({
        id: sess.id,
        payment_status: sess.payment_status,
        mode: sess.mode,
        amount_total: sess.amount_total,
        currency: sess.currency,
        metadata: sess.metadata,
        payment_intent: sess.payment_intent && {
          id: sess.payment_intent.id,
          status: sess.payment_intent.status,
          application_fee_amount: sess.payment_intent.application_fee_amount,
          transfer_data: sess.payment_intent.transfer_data || null,
          latest_charge: sess.payment_intent.latest_charge && {
            id: sess.payment_intent.latest_charge.id,
            balance_transaction: sess.payment_intent.latest_charge.balance_transaction,
          },
        },
      });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // === DEBUG: ver PI por id (por si ya tienes el pi_...) ===
  app.get("/api/debug/payment-intent/:pi", async (req, res) => {
    try {
      const pi = await stripe.paymentIntents.retrieve(req.params.pi, {
        expand: ["latest_charge", "transfer_data"],
      });
      res.json({
        id: pi.id,
        status: pi.status,
        amount: pi.amount,
        currency: pi.currency,
        application_fee_amount: pi.application_fee_amount,
        transfer_data: pi.transfer_data || null,
        latest_charge: pi.latest_charge && {
          id: pi.latest_charge.id,
          balance_transaction: pi.latest_charge.balance_transaction,
        },
      });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
}

// ===== Parsers & estáticos =====
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Si el JSON viene malformado devolvemos 400 en vez de 500
app.use((err, _req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'bad_json', message: 'JSON inválido' });
  }
  return next(err);
});
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ===== MongoDB =====
mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ Conectado a MongoDB"))
  .catch((err) => console.error("❌ Error al conectar a MongoDB:", err));

// ===== Rutas base =====
app.get("/", (_req, res) => res.send("¡Servidor funcionando correctamente!"));
// Healthchecks
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/version', (_req, res) => res.json({
  node: process.version,
  env: process.env.NODE_ENV || 'development',
  uptime: process.uptime(),
}));
app.get('/api/auth/me', anyAuthWithId, (req, res) => {
  return res.json({ ok: true, user: req.user || null });
});

// ===== DEBUG Firebase: verifica un ID token (solo en desarrollo) =====
if (DEBUG_ROUTES_ENABLED) {
  app.get('/api/debug/verify-token', async (req, res) => {
    try {
      const h = req.headers.authorization || '';
      const token = h.startsWith('Bearer ') ? h.slice(7) : null;
      if (!token) return res.status(400).json({ ok: false, error: 'missing_bearer' });
      const decoded = await admin.auth().verifyIdToken(token);
      return res.json({ ok: true, uid: decoded.uid, projectId: admin.app().options.credential?.projectId || null });
    } catch (e) {
      return res.status(403).json({ ok: false, error: e?.errorInfo?.code || e?.message || 'verify_failed' });
    }
  });
}
app.get("/test-image", (req, res) => {
  const base = (
    process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`
  ).replace(/\/+$/, "");
  res.send(`<img src="${base}/uploads/test.jpg" alt="Test Image" />`);
});

// ===== Helpers internos =====
function _normalizeId(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (v.$oid) return String(v.$oid);
  if (v._id) return String(v._id);
  if (v.id) return String(v.id);
  return String(v);
}

function _extractClubIdFromEventDoc(ev) {
  if (!ev || typeof ev !== "object") return "";
  const cands = [
    ev.clubId,
    ev.club_id,
    ev.club,
    ev.organizerClubId,
    ev.ownerClubId,
    ev.createdBy?.clubId,
    ev.createdBy?.club?._id,
    ev.club?._id,
    ev.club?.id,
  ];
  for (const c of cands) {
    const id = _normalizeId(c).trim();
    if (id) return id;
  }
  return "";
}

// Normaliza email
function _cleanEmail(e) {
  return (e || '').toLowerCase().trim();
}

async function resolveConnectedAccount({ clubId, eventId }) {
  // 1) Si ya viene clubId explícito, intenta Club._id = clubId
  if (clubId && Club) {
    const club = await Club.findById(clubId).select("stripeAccountId name ownerUserId managers").lean();
    if (club?.stripeAccountId) {
      return { destinationAccount: club.stripeAccountId, clubId: String(club._id), reason: "clubId_direct" };
    }
  }

  // 2) Si no, intenta derivar clubId desde el Event
  if (EventModel && eventId) {
    const ev = await EventModel.findById(eventId).select("createdBy clubId").lean();
    if (ev) {
      // a) Si Event trae clubId directo y existe Club -> usarlo
      if (ev.clubId && Club) {
        const c = await Club.findById(ev.clubId).select("stripeAccountId name").lean();
        if (c?.stripeAccountId) {
          return { destinationAccount: c.stripeAccountId, clubId: String(c._id), reason: "event.clubId" };
        }
      }

      // b) Mapear createdBy(User) -> buscar Club por ownerUserId o managers
      if (UserModel) {
        try {
          const u = await UserModel.findById(ev.createdBy).select("email").lean();
          const email = (u?.email || "").toLowerCase();
          const uid = _normalizeId(ev.createdBy);

          if (Club) {
            const club = await Club.findOne({
              $or: [
                { ownerUserId: uid },
                { ownerUserId: email },
                { managers: uid },
                { managers: email },
              ],
            }).select("stripeAccountId name").lean();

            if (club?.stripeAccountId) {
              return { destinationAccount: club.stripeAccountId, clubId: String(club._id), reason: "match_user" };
            }
          }
        } catch {}
      }
    }
  }

  // 3) nada encontrado
  return { destinationAccount: null, clubId: null, reason: "not_found" };
}

// ===== Stripe Checkout: crear orden (con validación + payouts Connect) =====
app.post("/api/orders", async (req, res) => {
  try {
    let { eventId, items, userId, phone, clubId } = req.body;
    const quantityRaw = req.body?.quantity ?? req.body?.qty;

    // ✅ Compat clubs flow: si no vienen items pero sí eventId + quantity, construimos items desde el Event
    if ((!items || !Array.isArray(items) || items.length === 0) && eventId && quantityRaw) {
      const qty = Math.max(1, Math.floor(Number(quantityRaw) || 1));

      if (!EventModel) {
        return res.status(400).json({
          error: 'missing_items',
          message: 'No hay items en la orden y no se puede derivar desde el evento (EventModel no disponible).',
        });
      }

      const ev = await EventModel.findById(eventId)
        .select('title price ticketPrice priceEUR currency platformFeeEUR clubId createdBy')
        .lean();

      if (!ev) {
        return res.status(404).json({ error: 'event_not_found', message: 'Evento no encontrado.' });
      }

      // precio unitario (EUR) -> cents
      const unitEur =
        ev.priceEUR ??
        ev.ticketPrice ??
        ev.price ??
        0;

      const unitEurNum = Number(unitEur);
      if (!Number.isFinite(unitEurNum) || unitEurNum <= 0) {
        return res.status(400).json({
          error: 'invalid_event_price',
          message: 'El evento no tiene un precio válido para comprar entradas.',
        });
      }

      const unitAmount = Math.round(unitEurNum * 100);
      items = [
        {
          name: ev.title || 'Entrada NightVibe',
          currency: (ev.currency || 'eur').toLowerCase(),
          qty,
          unitAmount,
        },
      ];

      // Si no vino clubId, intentamos derivarlo del propio evento (no rompe nada)
      if (!clubId && ev.clubId) clubId = String(ev.clubId);
    }

    // Validaciones básicas (flujo legacy y compat)
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res
        .status(400)
        .json({ error: "missing_items", message: "No hay items en la orden." });
    }

    // Construcción segura de line_items
    const line_items = items.map((it, idx) => {
      const name = (it?.name || "Entrada").toString();
      const currency = ((it?.currency || "eur") + "").toLowerCase();
      const qty = Number.isFinite(it?.qty) && it.qty > 0 ? Math.floor(it.qty) : 1;

      // unit_amount debe ser entero en céntimos y >= 50
      let unitAmount = Number(it?.unitAmount);
      if (!Number.isFinite(unitAmount)) {
        throw new Error(`items[${idx}].unitAmount inválido`);
      }
      unitAmount = Math.round(unitAmount);
      if (unitAmount < 50) {
        throw new Error(
          `El importe mínimo por entrada es 50 céntimos. Recibido: ${unitAmount}`
        );
      }

      return {
        quantity: qty,
        price_data: {
          currency,
          unit_amount: unitAmount,
          product_data: { name: `${name} · ${eventId || ""}` },
        },
      };
    });

    // ===== Opción A: el comprador paga la comisión visible (service fee) =====

    // total de entradas en el pedido
    const qtyTotal = line_items.reduce((acc, li) => acc + (li.quantity || 0), 0);

    // fee por ticket en céntimos. Default: 1,50€ si no hay env.
    const envFeeRaw = (process.env.PLATFORM_FEE_PER_TICKET_CENTS ?? '').toString().trim();
    let perTicketCents = envFeeRaw === '' ? 150 : parseInt(envFeeRaw, 10);
    if (!Number.isFinite(perTicketCents) || perTicketCents < 0) perTicketCents = 150;

    // Override por evento (Mongo): platformFeeEUR (ej. 1, 1.5, 2.25). Si es 0 => sin comisión.
    if (EventModel && eventId) {
      try {
        const evFee = await EventModel.findById(eventId)
          .select('platformFeeEUR')
          .lean();

        if (evFee && evFee.platformFeeEUR !== undefined && evFee.platformFeeEUR !== null) {
          const eur = Number(evFee.platformFeeEUR);
          if (Number.isFinite(eur) && eur >= 0) {
            perTicketCents = Math.round(eur * 100);
          }
        }
      } catch (e) {
        console.warn('⚠️ No se pudo leer platformFeeEUR del evento:', e?.message || e);
      }
    }

    // Total fee a cobrar (y a retener como application_fee en Connect)
    const applicationFee = Math.max(0, qtyTotal * perTicketCents);

    // Línea visible de fee para el comprador
    let feeLineAdded = false;
    if (perTicketCents > 0 && qtyTotal > 0) {
      line_items.push({
        quantity: qtyTotal,
        price_data: {
          currency: 'eur',
          unit_amount: perTicketCents,
          product_data: { name: 'Gastos de gestión · NightVibe' },
        },
      });
      feeLineAdded = true;
    }

    // 🔎 Resolver cuenta Connect y clubId de forma robusta
    const resolved = await resolveConnectedAccount({ clubId, eventId });
    clubId = resolved.clubId || clubId || ""; // por si se resolvió distinto
    const destinationAccount = resolved.destinationAccount;

    console.log("🔎 resolveConnectedAccount:", resolved);
    console.log('💸 Platform fee:', { perTicketCents, qtyTotal, applicationFee, feeLineAdded });

    const successBase = (process.env.FRONTEND_URL || "https://clubs.nightvibe.life").replace(/\/+$/, "");

    // Parámetros base del Checkout
    const sessionParams = {
      mode: "payment",
      line_items,
      success_url: `${successBase}/purchase/success?sid={CHECKOUT_SESSION_ID}`,
      cancel_url: `${successBase}/purchase/cancel`,
      customer_creation: "always",
      metadata: {
        eventId: eventId || "",
        userId: userId || "",
        phone: phone || "",
        clubId: clubId || "",
        destinationAccount: destinationAccount || "",
        applicationFeeCents: String(applicationFee || 0),
        perTicketFeeCents: String(perTicketCents || 0),
        feeLineAdded: feeLineAdded ? '1' : '0',
      },
      phone_number_collection: { enabled: true },
    };

    // Si tenemos cuenta Connect del club, activamos payouts + fee
    if (destinationAccount) {
      sessionParams.payment_intent_data = {
        transfer_data: { destination: destinationAccount }, // 💸 neto al club
        application_fee_amount: applicationFee,             // 💰 tu fee
      };
    } else {
      console.warn("⚠️ Sin Connected Account -> el cobro irá a la cuenta plataforma");
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    console.log("➡️  Created Checkout Session:", {
      clubId,
      destinationAccount,
      applicationFee,
      sessionId: session.id,
    });
    return res.json({ url: session.url });
  } catch (e) {
    console.error(
      "❌ /api/orders error:",
      e?.type || "",
      e?.code || "",
      e?.message || e,
      e?.raw?.message || ""
    );
    return res.status(500).json({
      error: "stripe_session_error",
      message: e?.raw?.message || e?.message || "No se pudo crear la sesión de pago.",
    });
  }
});

/* ========= Endpoints de lectura de órdenes para el front ========= */
// Rutas públicas (sin auth): límite estricto para que no se puedan enumerar ids.
const publicOrderLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 30,             // 30 peticiones por IP/min
  standardHeaders: true,
  legacyHeaders: false,
});

// "ra***@gmail.com" -> suficiente para "te lo hemos enviado a ..." sin exponer la dirección
function _maskEmail(e) {
  const email = _cleanEmail(e);
  const at = email.lastIndexOf("@");
  if (at <= 0) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
}

// ⚠️ Solo campos no sensibles: nada de email completo, phone, buyerName, ids de Stripe, etc.
const PUBLIC_ORDER_FIELDS = "status ticketsIssuedAt eventId qty amountEUR currency tierName email";
function _publicOrderView(order) {
  return {
    status: order.status,
    ticketsIssuedAt: order.ticketsIssuedAt || null,
    eventId: order.eventId,
    qty: order.qty,
    amountEUR: order.amountEUR,
    currency: order.currency,
    tierName: order.tierName || "",
    emailMasked: _maskEmail(order.email),
  };
}

// GET /api/orders/by-session/:sid  -> usado por /purchase/success (usuario no autenticado)
app.get("/api/orders/by-session/:sid", publicOrderLimiter, async (req, res) => {
  try {
    const sid = String(req.params.sid || "").trim();
    if (!sid) return res.status(400).json({ error: "missing_sid" });

    const order = await Order.findOne({ stripeSessionId: sid }).select(PUBLIC_ORDER_FIELDS).lean();
    if (!order) return res.status(404).json({ error: "order_not_found" });

    return res.json({ order: _publicOrderView(order) });
  } catch (e) {
    console.error("GET /api/orders/by-session error:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// (Opcional) GET /api/orders/:id  -> misma vista reducida
app.get("/api/orders/:id", publicOrderLimiter, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: "order_not_found" });
    }
    const order = await Order.findById(req.params.id).select(PUBLIC_ORDER_FIELDS).lean();
    if (!order) return res.status(404).json({ error: "order_not_found" });
    return res.json({ order: _publicOrderView(order) });
  } catch (e) {
    console.error("GET /api/orders/:id error:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// GET /api/orders/:id/status  -> app (autenticado, solo el dueño de la orden)
// Devuelve los ticketIds para pedir el QR con GET /api/events/my-tickets/:ticketId/qr
app.get("/api/orders/:id/status", anyAuth, ensureUserId, async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");

    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: "order_not_found" });
    }

    const order = await Order.findById(req.params.id)
      .select("_id userId status ticketsIssuedAt tierName qty")
      .lean();
    if (!order) return res.status(404).json({ error: "order_not_found" });

    // Identidades del usuario: uid de Firebase + _id de Mongo (anyAuth deja el uid en req.user.id
    // cuando es Firebase, así que resolvemos el _id buscando por firebaseUid, sin crear nada).
    const ownerIds = new Set([req.firebaseUser?.uid, req.user?.id].filter(Boolean).map(String));
    if (req.firebaseUser?.uid && UserModel) {
      const u = await UserModel.findOne({ firebaseUid: req.firebaseUser.uid }).select("_id").lean();
      if (u) ownerIds.add(String(u._id));
    }

    if (!order.userId || !ownerIds.has(String(order.userId))) {
      console.warn("[GET /api/orders/:id/status] acceso denegado", {
        orderId: String(order._id),
        userId: req.user?.id || null,
      });
      return res.status(403).json({ error: "forbidden" });
    }

    const tickets = await Ticket.find({ orderId: order._id }).select("_id").lean();

    return res.json({
      status: order.status,
      ticketsIssuedAt: order.ticketsIssuedAt || null,
      ticketIds: tickets.map((t) => String(t._id)),
      tierName: order.tierName || "",
      qty: order.qty,
    });
  } catch (e) {
    console.error("GET /api/orders/:id/status error:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// ===== Check-in de tickets (escáner) =====
// Autenticación por club: x-scanner-key se busca en Club.scannerApiKey.
// ⚠️ COMPATIBILIDAD TEMPORAL: la clave global SCANNER_API_KEY se sigue aceptando en
// "modo legacy" (sin club identificado) mientras se migra el scanner del portal.
// En modo legacy se omiten las validaciones de club y evento, pero NO la de firma.

// Igual que eventTimes() en routes/eventRoutes.js: sin endAt, el evento dura 12 h.
const CHECKIN_EVENT_DEFAULT_DURATION_MS = 12 * 60 * 60 * 1000;
// Tras el fin del evento, aún se aceptan entradas durante este margen.
const CHECKIN_GRACE_AFTER_END_MS = 12 * 60 * 60 * 1000;

function _scannerKeyFromReq(req) {
  const k = req.headers["x-scanner-key"];
  return typeof k === "string" ? k.trim() : "";
}

// 120 peticiones/min por clave de scanner (sin clave -> por IP).
// La clave se hashea para no guardarla en claro en el store del limiter.
const checkinLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const key = _scannerKeyFromReq(req);
    if (key) return "sk:" + crypto.createHash("sha256").update(key).digest("hex");
    return "ip:" + (rateLimit.ipKeyGenerator ? rateLimit.ipKeyGenerator(req.ip) : req.ip);
  },
  handler: (_req, res) => res.status(429).json({ ok: false, reason: "rate_limited" }),
});

/** { club, legacy:false } si la clave es de un club; { club:null, legacy:true } si es la global; si no, null. */
async function _resolveScanner(key) {
  if (!key) return null;

  if (Club) {
    const club = await Club.findOne({ scannerApiKey: key })
      .select("_id name ownerUserId managers")
      .lean();
    if (club) return { club, legacy: false };
  }

  const globalKey = process.env.SCANNER_API_KEY || "";
  if (globalKey) {
    const a = Buffer.from(key, "utf8");
    const b = Buffer.from(globalKey, "utf8");
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return { club: null, legacy: true };
    }
  }
  return null;
}

/**
 * ¿El evento es del club que escanea?
 * - Si el evento tiene vínculo explícito (club / clubId), manda ese vínculo.
 * - Eventos antiguos sin club: createdBy (User) debe ser owner o manager del club,
 *   comparando por _id, firebaseUid o email (como resolveConnectedAccount).
 */
async function _eventBelongsToClub(ev, club) {
  const clubId = String(club._id);
  const evClub = ev.club ? String(ev.club) : "";
  const evClubId = String(ev.clubId || "").trim();
  if (evClub || evClubId) return evClub === clubId || evClubId === clubId;

  if (!ev.createdBy) return false;
  const creatorIds = new Set([String(ev.createdBy)]);
  if (UserModel && mongoose.isValidObjectId(String(ev.createdBy))) {
    try {
      const u = await UserModel.findById(ev.createdBy).select("email firebaseUid").lean();
      if (u?.email) creatorIds.add(_cleanEmail(u.email));
      if (u?.firebaseUid) creatorIds.add(String(u.firebaseUid));
    } catch {}
  }

  const clubPeople = [club.ownerUserId, ...(club.managers || [])].filter(Boolean).map(String);
  return clubPeople.some((x) => creatorIds.has(x) || creatorIds.has(_cleanEmail(x)));
}

/** true si el evento terminó hace más de CHECKIN_GRACE_AFTER_END_MS. Antes de empezar: false. */
function _eventEndedTooLongAgo(ev, now = Date.now()) {
  const start = ev?.startAt || ev?.date || null;
  const startMs = start ? new Date(start).getTime() : NaN;
  let endMs = ev?.endAt ? new Date(ev.endAt).getTime() : NaN;
  if (!Number.isFinite(endMs) && Number.isFinite(startMs)) {
    endMs = startMs + CHECKIN_EVENT_DEFAULT_DURATION_MS;
  }
  // Sin fechas no podemos saberlo: no bloqueamos la entrada.
  if (!Number.isFinite(endMs)) return false;
  return now > endMs + CHECKIN_GRACE_AFTER_END_MS;
}

// El log de auditoría nunca debe tumbar un check-in (p.ej. tras marcar la entrada como usada).
async function _logCheckin(entry) {
  try {
    await CheckInLog.create(entry);
  } catch (e) {
    console.error("[checkin] no se pudo guardar CheckInLog:", e?.message || e);
  }
}

/*
 * ⚠️ CÓDIGO MUERTO (comentado, no borrado): modo "NV1" (token + eventId + hmac).
 * Nunca encontraba nada: el webhook guarda tokenHash como SHA-256 hex y aquí se
 * comparaba con bcrypt. Además ningún QR actual usa este formato (todos son
 * JSON.stringify({ serial, token })). Sustituido por verifyToken(token, serial).
 *
 *   const expected = crypto
 *     .createHmac("sha256", process.env.QR_HMAC_KEY || "")
 *     .update(`${token}|${eventId}`)
 *     .digest("base64url");
 *
 *   if (expected !== hmac) {
 *     await CheckInLog.create({ ticketId: null, eventId, result: "bad_signature" });
 *     return res.status(400).json({ ok: false, reason: "bad_signature" });
 *   }
 *
 *   const candidates = await Ticket.find({
 *     eventId,
 *     status: { $in: ["issued", "checked_in"] },
 *   }).limit(10000);
 *
 *   for (const t of candidates) {
 *     const ok = await bcrypt.compare(token, t.tokenHash);
 *     if (ok) { found = t; break; }
 *   }
 */

app.post("/api/checkin", checkinLimiter, async (req, res) => {
  try {
    // ---------- Autenticación: ¿qué club escanea? ----------
    const scanner = await _resolveScanner(_scannerKeyFromReq(req));
    if (!scanner) {
      return res.status(401).json({ ok: false, reason: "unauthorized" });
    }
    const scanClubId = scanner.club ? String(scanner.club._id) : null;
    if (scanner.legacy) {
      console.warn(
        "⚠️ [checkin] Clave GLOBAL SCANNER_API_KEY usada (modo legacy, sin club): " +
          "se omiten las validaciones de club y evento. Migra el scanner a la clave del club."
      );
    }

    // ---------- Entrada: { serial, token, eventId } ----------
    // Solo strings: evita que un objeto ({ $ne: null }) llegue a las consultas.
    // ⚠️ No loguear el body: contiene el token de la entrada.
    const body = req.body || {};
    const serial = typeof body.serial === "string" ? body.serial.trim() : "";
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const scanEventId =
      typeof body.eventId === "string" && body.eventId.trim() ? body.eventId.trim() : null;

    if (!serial || !token) {
      return res.status(400).json({ ok: false, reason: "bad_request" });
    }

    // a) Firma del token (sin BD)
    if (!verifyToken(token, serial)) {
      await _logCheckin({ ticketId: null, eventId: scanEventId, clubId: scanClubId, result: "bad_signature" });
      return res.status(400).json({ ok: false, reason: "bad_signature" });
    }

    // b) Existe la entrada
    const ticket = await Ticket.findOne({ serial })
      .select("_id eventId orderId ticketTypeId serial status checkedInAt")
      .lean();
    if (!ticket) {
      await _logCheckin({ ticketId: null, eventId: scanEventId, clubId: scanClubId, result: "invalid" });
      return res.status(404).json({ ok: false, reason: "invalid" });
    }

    const ticketEventId = String(ticket.eventId || "");
    const logTicket = (result) =>
      _logCheckin({ ticketId: ticket._id, eventId: ticketEventId, clubId: scanClubId, result });

    // c) Estado: reembolsada
    if (ticket.status === "refunded") {
      await logTicket("refunded");
      return res.json({ ok: false, reason: "refunded" });
    }

    // Evento de la entrada (título, tiers, club y fechas)
    let ev = null;
    if (EventModel && mongoose.isValidObjectId(ticketEventId)) {
      ev = await EventModel.findById(ticketEventId)
        .select("title club clubId createdBy startAt endAt date ticketTiers.tierId ticketTiers.name")
        .lean();
    }
    const eventTitle = ev?.title || "";

    if (!scanner.legacy) {
      // d) El evento es de este club. Sin evento no se puede demostrar -> wrong_club.
      if (!ev || !(await _eventBelongsToClub(ev, scanner.club))) {
        await logTicket("wrong_club");
        return res.json({ ok: false, reason: "wrong_club", eventTitle });
      }

      // e) Es el evento que se está escaneando (si el portero lo ha fijado)
      if (scanEventId && scanEventId !== ticketEventId) {
        await logTicket("wrong_event");
        return res.json({ ok: false, reason: "wrong_event", eventTitle });
      }

      // f) Vigente: no terminó hace más de 12 h (si aún no empezó, se acepta)
      if (_eventEndedTooLongAgo(ev)) {
        await logTicket("event_ended");
        return res.json({ ok: false, reason: "event_ended", eventTitle });
      }
    }

    // Nombre del comprador (NO el email: el portero no lo necesita)
    let buyerName = "";
    let orderTierName = "";
    if (ticket.orderId) {
      try {
        const ord = await Order.findById(ticket.orderId).select("buyerName tierName").lean();
        buyerName = ord?.buyerName || "";
        orderTierName = ord?.tierName || "";
      } catch {
        // noop
      }
    }

    const duplicateBody = (t) => ({
      ok: false,
      reason: "duplicate",
      serial: ticket.serial,
      checkedInAt: t?.checkedInAt || null,
      buyerName,
    });

    // g) Ya usada
    if (ticket.status === "checked_in") {
      await logTicket("duplicate");
      return res.json(duplicateBody(ticket));
    }

    // h) Update atómico issued -> checked_in
    const updated = await Ticket.findOneAndUpdate(
      { _id: ticket._id, status: "issued" },
      {
        $set: {
          status: "checked_in",
          checkedInAt: new Date(),
          checkedInBy: scanClubId || "legacy_scanner",
        },
      },
      { new: true }
    ).lean();

    // i) Carrera: otro escaneo (o un reembolso) se adelantó
    if (!updated) {
      const fresh = await Ticket.findById(ticket._id).select("status checkedInAt").lean();
      if (fresh?.status === "refunded") {
        await logTicket("refunded");
        return res.json({ ok: false, reason: "refunded" });
      }
      await logTicket("duplicate");
      return res.json(duplicateBody(fresh));
    }

    await logTicket("ok");

    // tierName: el portero necesita saber si la entrada lleva consumición
    const tier = ticket.ticketTypeId
      ? (ev?.ticketTiers || []).find((t) => t.tierId === ticket.ticketTypeId)
      : null;

    return res.json({
      ok: true,
      serial: ticket.serial,
      status: "checked_in",
      checkedInAt: updated.checkedInAt,
      buyerName,
      tierName: tier?.name || orderTierName || "",
      eventTitle,
    });
  } catch (e) {
    console.error("❌ Error en /api/checkin:", e?.message || e);
    return res.status(500).json({ ok: false, reason: "server_error" });
  }
});

/**
 * Filtro de Mongo con los eventos del club. Mismo criterio que _eventBelongsToClub:
 * - vínculo explícito: club / clubId = este club;
 * - eventos antiguos SIN club ni clubId: createdBy es un User que es owner o manager
 *   del club (por _id, firebaseUid o email, este último sin distinguir mayúsculas).
 */
async function _clubEventsFilter(club) {
  const clubId = String(club._id);
  const or = [{ club: club._id }, { clubId }];

  const people = [club.ownerUserId, ...(club.managers || [])].filter(Boolean).map(String);
  // owner/manager guardado directamente como _id de User
  const creatorIds = new Set(people.filter((p) => /^[0-9a-f]{24}$/i.test(p)));
  if (UserModel && people.length) {
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const emails = people.filter((p) => p.includes("@")).map(_cleanEmail);
    const users = await UserModel.find({
      $or: [
        { firebaseUid: { $in: people } },
        ...(emails.length ? [{ email: { $in: emails.map((e) => new RegExp(`^${escapeRe(e)}$`, "i")) } }] : []),
      ],
    })
      .select("_id")
      .lean();
    for (const u of users) creatorIds.add(String(u._id));
  }

  if (creatorIds.size) {
    or.push({
      club: null,
      clubId: { $in: ["", null] },
      createdBy: { $in: [...creatorIds] },
    });
  }
  return { $or: or };
}

// GET /api/checkin/events -> eventos del club para que el portero elija cuál escanea.
// Misma autenticación y rate limit que POST /api/checkin; la clave global legacy no vale
// (para listar eventos hace falta saber qué club es).
app.get("/api/checkin/events", checkinLimiter, async (req, res) => {
  try {
    const scanner = await _resolveScanner(_scannerKeyFromReq(req));
    if (!scanner) {
      return res.status(401).json({ ok: false, reason: "unauthorized" });
    }
    if (scanner.legacy) {
      return res.status(400).json({ ok: false, reason: "legacy_key_not_supported" });
    }
    if (!EventModel) {
      return res.status(500).json({ ok: false, reason: "server_error" });
    }

    // Prefiltro aproximado en Mongo; la decisión final la toma _eventEndedTooLongAgo,
    // el MISMO criterio que el check-in (incluye los que aún no han empezado y los sin fecha).
    const now = Date.now();
    const endCutoff = new Date(now - CHECKIN_GRACE_AFTER_END_MS);
    const startCutoff = new Date(now - CHECKIN_GRACE_AFTER_END_MS - CHECKIN_EVENT_DEFAULT_DURATION_MS);

    const clubFilter = await _clubEventsFilter(scanner.club);
    const events = await EventModel.find({
      $and: [
        clubFilter,
        // Sin borradores. $ne:false también incluye los eventos antiguos sin el campo (default true).
        { isPublished: { $ne: false } },
        {
          $or: [
            { endAt: { $gte: endCutoff } },
            { startAt: { $gte: startCutoff } },
            { date: { $gte: startCutoff } },
            { endAt: null, startAt: null, date: null },
          ],
        },
      ],
    })
      .select("_id title startAt endAt date")
      .lean();

    const startMs = (ev) => {
      const s = ev.startAt || ev.date;
      const ms = s ? new Date(s).getTime() : NaN;
      return Number.isFinite(ms) ? ms : Infinity; // sin fecha: al final
    };

    const list = events
      .filter((ev) => !_eventEndedTooLongAgo(ev, now))
      .sort((a, b) => startMs(a) - startMs(b))
      .map((ev) => ({
        _id: String(ev._id),
        title: ev.title || "",
        startAt: ev.startAt || ev.date || null,
        endAt: ev.endAt || null,
      }));

    return res.json({ ok: true, events: list });
  } catch (e) {
    console.error("❌ Error en GET /api/checkin/events:", e?.message || e);
    return res.status(500).json({ ok: false, reason: "server_error" });
  }
});

// ===== Rutas de tu app =====

const authRoutes = require("./routes/authRoutes");
const eventRoutes = require("./routes/eventRoutes");
const searchRoutes = require("./routes/searchRoutes");
const userRoutes = require("./routes/userRoutes");
const registrationRoutes = require("./routes/registrationRoutes"); // <-- MOVIDO AQUÍ
const promotionsRoutes = require("./routes/promotionsRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const pushRoutes = require("./routes/pushRoutes");

// Compat: clientes antiguos pueden llamar /start|/request|/requests
// Normalizamos name -> clubName y reenviamos al router en /apply sin perder body
const registrationRouter = require("./routes/registrationRoutes");
app.post("/api/registration/start", (req, res, next) => {
  if (!req.body?.clubName && req.body?.name) req.body.clubName = req.body.name;
  req.url = "/apply";
  return registrationRouter(req, res, next);
});
app.post("/api/registration/request", (req, res, next) => {
  if (!req.body?.clubName && req.body?.name) req.body.clubName = req.body.name;
  req.url = "/apply";
  return registrationRouter(req, res, next);
});
app.post("/api/registration/requests", (req, res, next) => {
  if (!req.body?.clubName && req.body?.name) req.body.clubName = req.body.name;
  req.url = "/apply";
  return registrationRouter(req, res, next);
});

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/tickets", eventRoutes.ticketClaimRouter); // GET /api/tickets/claim/:claimToken (público)
app.use("/api/promotions", promotionsRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/push", pushRoutes);
app.use("/search", searchRoutes);
app.use("/api/registration", registrationRoutes); // <-- Y montado AQUÍ
app.use("/api/clubs", clubRoutes);
app.use("/api/social", socialRoutes);

// Payments: endpoints para links directos de compra (compat)
if (paymentRoutes) {
  app.use('/api/payments', paymentRoutes);
  console.log('✅ Mounted /api/payments');
} else {
  console.warn('⚠️ /api/payments NO montado (paymentRoutes=null).');
}

// Shares: generar links con refCode y redirects de tracking
if (shareRoutes) {
  app.use('/api/share', shareRoutes);

  // Ruta pública corta para compartir: https://dominio/r/:refCode
  // Reutiliza el mismo router sin exponer /create fuera de /api/share.
  app.get('/r/:refCode', (req, res, next) => shareRoutes(req, res, next));

  console.log('✅ Mounted /api/share');
  console.log('✅ Mounted public share redirect /r/:refCode');
} else {
  console.warn('⚠️ /api/share NO montado (shareRoutes=null).');
}

// Analytics: repercusión por usuario/canal en un evento
if (referralAnalyticsRoutes) {
  app.use('/api/referrals', referralAnalyticsRoutes);
  console.log('✅ Mounted /api/referrals');
} else {
  console.warn('⚠️ /api/referrals NO montado (referralAnalyticsRoutes=null).');
}

if (DEBUG_ROUTES_ENABLED) {
// ===== DEBUG: enviar email de prueba con QR =====
app.post('/api/debug/send-test-email', express.json(), async (req, res) => {
  try {
    const token = req.headers['x-debug-token'];
    if (!process.env.DEBUG_ADMIN_TOKEN || token !== process.env.DEBUG_ADMIN_TOKEN) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const { to } = req.body || {};
    if (!to) return res.status(400).json({ error: 'missing_to' });

    const qrPngBuffer = await QRCode.toBuffer('NV-TEST-' + Date.now(), { width: 300 });
    const resp = await sendTicketEmail({
      to,
      eventTitle: 'Prueba NightVibe',
      clubName: 'NightVibe',
      eventDate: new Date().toLocaleString('es-ES'),
      venue: '',
      serial: 'NV-TEST',
      qrPngBuffer,
      buyerName: 'Tester',
    });
    return res.json({ ok: true, status: resp?.statusCode || 202 });
  } catch (e) {
    console.error('[debug send-test-email] error:', e?.response?.body || e?.message || e);
    return res.status(500).json({ error: 'send_failed', message: e?.message || 'unknown' });
  }
});

// Helper local: genera un token con el MISMO formato que el webhook (estructura idéntica del QR)
function makeTicketToken(serial) {
  const raw = `${serial}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const sig = crypto
    .createHmac('sha256', process.env.QR_HMAC_KEY || 'nv_dev')
    .update(raw)
    .digest('hex')
    .slice(0, 16);
  return `${raw}.${sig}`;
}

app.post('/api/debug/resend-ticket', express.json(), async (req, res) => {
  try {
    const token = req.headers['x-debug-token'];
    if (!process.env.DEBUG_ADMIN_TOKEN || token !== process.env.DEBUG_ADMIN_TOKEN) {
      return res.status(403).json({ error: 'forbidden' });
    }
    // `to` del body se IGNORA a propósito: las entradas solo se reenvían al
    // email de la orden (el check-in valida por serial, así que enviarlas a
    // otra dirección equivale a regalar la entrada).
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ error: 'missing_orderId' });

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ error: 'order_not_found' });
    if (order.status !== 'paid') {
      return res.status(409).json({ error: 'order_not_paid', status: order.status });
    }

    const toEmail = typeof order.email === 'string' ? order.email.trim() : '';
    if (!toEmail) return res.status(400).json({ error: 'no_email', message: 'La orden no tiene email' });

    const ticketsDocs = await Ticket.find({
      orderId: order._id,
      status: { $in: ['issued', 'checked_in'] },
    });
    if (!ticketsDocs.length) return res.status(404).json({ error: 'no_tickets' });

    // Regenerar QR por serial (el check-in valida por serial => seguro)
    const tickets = [];
    for (const t of ticketsDocs) {
      const qrPayload = JSON.stringify({ serial: t.serial, token: makeTicketToken(t.serial) });
      const qrPngBuffer = await QRCode.toBuffer(qrPayload, { type: 'png', scale: 6, margin: 1 });
      tickets.push({ serial: t.serial, qrPngBuffer });
    }

    // Datos del evento (mismos fallbacks que el webhook)
    let evt = null;
    try { evt = EventModel ? await EventModel.findById(order.eventId).lean() : null; } catch (_) {}
    const clubName = evt?.clubName || evt?.club?.entityName || '';
    const venue = evt?.locationName || evt?.venue || '';
    const eventDate = evt?.startAt
      ? new Date(evt.startAt).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' })
      : '';
    const ticketTheme = (typeof evt?.ticketTheme === 'string' ? evt.ticketTheme.trim() : '') || 'default';

    await sendTicketEmail({
      to: toEmail,
      eventTitle: evt?.title || 'Entrada NightVibe',
      clubName,
      eventDate,
      venue,
      tickets,
      serial: tickets[0]?.serial,
      qrPngBuffer: tickets[0]?.qrPngBuffer,
      ticketTheme,
      buyerName: order.buyerName || '',
    });

    order.emailSentAt = new Date();
    order.emailLastTo = toEmail;
    order.emailError = null;
    order.emailAttempts = (order.emailAttempts || 0) + 1;
    await order.save();

    return res.json({ ok: true, resentTo: toEmail, tickets: tickets.length });
  } catch (e) {
    console.error('[resend-ticket] error:', e?.response?.body || e?.message || e);
    return res.status(500).json({ error: 'resend_failed', message: e?.message || 'unknown' });
  }
});
} // fin DEBUG_ROUTES_ENABLED (send-test-email, resend-ticket)

// ===== 404 =====
app.use((_req, res) => res.status(404).send("Ruta no encontrada"));

// ===== Server =====
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✨ Servidor corriendo en el puerto ${PORT}`);
  console.log("CORS FRONTEND_URL:", FRONTEND_URL || '(no definido)');
  console.log("Webhook Stripe en:", "/api/webhooks/stripe");
});

module.exports = app;
