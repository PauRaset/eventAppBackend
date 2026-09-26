// index.js (entrypoint)
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const session = require("express-session");
const passport = require("passport");
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
const { anyAuthWithId } = require("./middlewares/authMiddleware");

// ✅ Inicializa firebase-admin y loguea el project_id para depurar 403
const admin = require("./middlewares/firebaseAdmin");
console.log("firebase-admin project:", admin.app().options.credential?.projectId || process.env.FIREBASE_PROJECT_ID || "(desconocido)");

const app = express();
// Si estamos detrás de un proxy (Vercel/NGINX), esto permite que la cookie `secure`
// funcione correctamente en producción.
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
    'SESSION_SECRET',
    'QR_HMAC_KEY',
  ]) {
    if (!process.env[key]) missing.push(key);
  }
  if (missing.length) {
    console.error('❌ Faltan variables de entorno:', missing.join(', '));
    // No detenemos el proceso automáticamente para no romper despliegues, pero dejamos claro el error:
  }
}

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
//   CORS — permitir clubs.nightvibe.life, previews de Vercel y FRONTEND_URL
// ============================================================================
const FRONTEND_URL = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");

const staticAllowed = new Set([
  FRONTEND_URL,
  "https://event-app-prod.vercel.app",
  "https://nightvibe-six.vercel.app",
  "http://localhost:3000",
  "https://clubs.nightvibe.life",
  "https://nvclubs.vercel.app",
]);

function isAllowedOrigin(origin) {
  try {
    if (!origin) return true; // curl / apps nativas
    if (staticAllowed.has(origin)) return true;

    const { hostname } = new URL(origin);
    if (hostname.endsWith(".vercel.app")) return true;      // previews
    if (hostname.endsWith(".nightvibe.life")) return true;  // subdominios

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
if (process.env.NODE_ENV !== 'production') {
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

/*app.post(
  "/api/webhooks/stripe",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Webhook signature failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // ===== EMISIÓN DE TICKETS + EMAIL =====
    if (event.type === "checkout.session.completed") {
      const sessionObj = event.data.object;
      console.log(
        "✅ Pago OK:",
        sessionObj.id,
        "email:",
        sessionObj.customer_details?.email
      );

      try {
        // 1) Datos base del pago (desde la Session)
        const email  = sessionObj.customer_details?.email || null;
        const name   = sessionObj.customer_details?.name  || "";
        const eventId = sessionObj.metadata?.eventId || "EVT";
        const clubId  = sessionObj.metadata?.clubId || null;
        const userId  = sessionObj.metadata?.userId || null;
        const phone   = sessionObj.metadata?.phone  || null;
        const paymentIntentId = sessionObj.payment_intent || null;

        // 2) Recuperar line items reales
        const lineItems = await stripe.checkout.sessions.listLineItems(
          sessionObj.id,
          { limit: 100 }
        );

        // Calcular subtotal y moneda (a partir del primer item)
        let subtotalCents = 0;
        let currency = "eur";
        for (const li of lineItems.data) {
          const qty = li.quantity || 1;
          const unit = li.amount_total
            ? Math.floor(li.amount_total / qty)
            : li.price?.unit_amount || 0;
          subtotalCents += unit * qty;
          currency = (li.price?.currency || currency || "eur").toLowerCase();
        }

        // 3) Opcional: recuperar PaymentIntent para capturar application_fee y destino Connect
        let applicationFeeCents = 0;
        let destinationAccount = null;
        let chargeId = null;
        let balanceTxId = null;

        if (paymentIntentId) {
          try {
            const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
              expand: ["latest_charge", "transfer_data"],
            });
            if (pi?.application_fee_amount) {
              applicationFeeCents = pi.application_fee_amount;
            }
            if (pi?.transfer_data?.destination) {
              destinationAccount = pi.transfer_data.destination; // acct_***
            }
            const charge = pi?.latest_charge;
            if (typeof charge === "object") {
              chargeId = charge.id || null;
              balanceTxId = charge.balance_transaction || null;
            }
          } catch (e) {
            console.warn("⚠️ No se pudo expandir PaymentIntent:", e?.message || e);
          }
        }

        // 4) Crear/actualizar Order
        const order = await Order.findOneAndUpdate(
          { stripeSessionId: sessionObj.id },
          {
            stripeSessionId: sessionObj.id,
            paymentIntentId,
            chargeId,
            balanceTxId,

            // Comprador
            userId,
            phone,
            email,
            buyerName: name,

            // Negocio / evento
            clubId,
            eventId,

            // Items
            items: lineItems.data.map((li) => ({
              ticketTypeId: li.price?.product || null,
              name:
                li.description ||
                li.price?.nickname ||
                li.price?.product ||
                "Entrada",
              unitAmount: li.amount_total
                ? Math.floor(li.amount_total / (li.quantity || 1))
                : li.price?.unit_amount || 0,
              qty: li.quantity || 1,
              currency: (li.price?.currency || currency || "eur").toLowerCase(),
            })),

            // Totales / fees
            currency,
            subtotalCents,
            applicationFeeCents,
            destinationAccount,

            // Metadatos
            sessionMetadata: sessionObj.metadata || {},

            status: "paid",
          },
          { upsert: true, new: true }
        );

        // (Opcional) título/fecha del evento para el email
        const eventTitle = `Evento ${eventId}`;
        const eventDate = "";

        // 5) Emitir tickets: 1 por unidad
        for (const li of lineItems.data) {
          const qty = li.quantity || 1;
          for (let i = 0; i < qty; i++) {
            // token + firma HMAC
            const token = crypto.randomBytes(16).toString("base64url"); // 128 bits
            const hmac = crypto
              .createHmac("sha256", process.env.QR_HMAC_KEY)
              .update(`${token}|${eventId}`)
              .digest("base64url");
            const payload = `NV1:t=${token}&e=${eventId}&s=${hmac}`;

            // solo guardamos hash del token
            const tokenHash = await bcrypt.hash(token, 10);

            // serial corto legible (p.ej. NV-AB12-3F)
            const serial = `NV-${crypto
              .randomBytes(2)
              .toString("hex")
              .toUpperCase()}-${crypto
              .randomBytes(1)
              .toString("hex")
              .toUpperCase()}`;

            // persistir ticket
            const ticket = await Ticket.create({
              eventId,
              orderId: order._id,
              ownerUserId: userId,
              email,
              ticketTypeId: li.price?.product || null,
              serial,
              tokenHash,
              status: "issued",
            });

            // QR PNG (con el payload firmado)
            const qrPng = await QRCode.toBuffer(payload, {
              errorCorrectionLevel: "M",
              width: 480,
            });

            // email con la entrada (si hay email)
            if (email) {
              await sendTicketEmail({
                to: email,
                eventTitle,
                eventDate,
                serial: ticket.serial,
                qrPngBuffer: qrPng,
              });
            } else {
              console.log(
                "⚠️ Ticket emitido SIN email (no disponible): serial",
                ticket.serial
              );
            }
          }
        }

        console.log("🎟️  Tickets emitidos para order", order._id.toString());
      } catch (err) {
        console.error("❌ Error procesando checkout.session.completed:", err);
      }
    }

    res.json({ received: true });
  }
);*/

if (process.env.NODE_ENV !== 'production') {
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

// ===== Sesiones =====
app.use(
  session({
    secret: process.env.SESSION_SECRET || "mysecretkey",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);

// ===== Passport (si lo usas) =====
app.use(passport.initialize());
app.use(passport.session());
require("./passportConfig");

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
if (process.env.NODE_ENV !== 'production') {
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

    const successBase = (process.env.FRONTEND_URL || "https://event-app-prod.vercel.app").replace(/\/+$/, "");

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

/* ========= NUEVO: endpoints de lectura de órdenes para el front ========= */
// GET /api/orders/by-session/:sid  -> usado por /purchase/success
app.get("/api/orders/by-session/:sid", async (req, res) => {
  try {
    const sid = decodeURIComponent(req.params.sid || "");
    if (!sid) return res.status(400).json({ error: "missing_sid" });

    const order = await Order.findOne({ stripeSessionId: sid }).lean();
    if (!order) return res.status(404).json({ error: "order_not_found" });

    return res.json({ order });
  } catch (e) {
    console.error("GET /api/orders/by-session error:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// (Opcional) GET /api/orders/:id  -> por si alguna vez lo necesitas
app.get("/api/orders/:id", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).lean();
    if (!order) return res.status(404).json({ error: "order_not_found" });
    return res.json({ order });
  } catch (e) {
    console.error("GET /api/orders/:id error:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// ===== Check-in de tickets (escáner) =====
app.post("/api/checkin", async (req, res) => {
  try {
    // Seguridad básica por API key (MVP) + rate limiting aplicado arriba
    const key = req.headers["x-scanner-key"];
    if (!key || key !== process.env.SCANNER_API_KEY) {
      return res.status(401).json({ ok: false, reason: "unauthorized" });
    }

    const { token, eventId, hmac, serial } = req.body || {};
    console.log("[checkin] body:", req.body);

    // Soportamos dos modos:
    //  1) Formato nuevo  -> token + eventId + hmac  (NV1)
    //  2) Formato legacy -> serial + token         (JSON antiguo)
    const isNewFormat = !!(token && eventId && hmac);
    const isLegacyFormat = !!(serial && token);

    if (!isNewFormat && !isLegacyFormat) {
      return res.status(400).json({ ok: false, reason: "bad_request" });
    }

    let found = null;
    let effectiveEventId = eventId || null;

    if (isNewFormat) {
      // ---------- Modo nuevo: token + eventId + hmac ----------
      // Verificar firma HMAC
      const expected = crypto
        .createHmac("sha256", process.env.QR_HMAC_KEY || "")
        .update(`${token}|${eventId}`)
        .digest("base64url");

      if (expected !== hmac) {
        await CheckInLog.create({
          ticketId: null,
          eventId,
          result: "bad_signature",
        });
        return res.status(400).json({ ok: false, reason: "bad_signature" });
      }

      // Buscar ticket por comparación de hash dentro del evento
      const candidates = await Ticket.find({
        eventId,
        status: { $in: ["issued", "checked_in"] },
      }).limit(10000);

      for (const t of candidates) {
        const ok = await bcrypt.compare(token, t.tokenHash);
        if (ok) {
          found = t;
          break;
        }
      }

      effectiveEventId = eventId;
    } else if (isLegacyFormat) {
      // ---------- Modo legacy: serial + token ----------
      // Compatibilidad hacia atrás: algunas entradas antiguas codifican solo
      // { serial, token } en el QR y no tienen un tokenHash verificable.
      // Para estas, validamos únicamente por serial.
      const cand = await Ticket.findOne({
        serial,
        status: { $in: ["issued", "checked_in"] },
      });

      if (!cand) {
        await CheckInLog.create({
          ticketId: null,
          eventId: null,
          result: "invalid",
        });
        return res.status(404).json({ ok: false, reason: "invalid" });
      }

      // A partir de aquí tratamos igual que en el formato nuevo
      found = cand;
      effectiveEventId = cand.eventId || null;
    }

    if (!found) {
      await CheckInLog.create({
        ticketId: null,
        eventId: effectiveEventId,
        result: "invalid",
      });
      return res.status(404).json({ ok: false, reason: "invalid" });
    }

    // Cargar orden para devolver buyerName/email
    let buyerName = "";
    let buyerEmail = "";
    try {
      if (found.orderId) {
        const ord = await Order.findById(found.orderId)
          .select("buyerName email")
          .lean();
        if (ord) {
          buyerName = ord.buyerName || "";
          buyerEmail = ord.email || "";
        }
      }
    } catch {
      // noop
    }

    if (found.status === "checked_in") {
      await CheckInLog.create({
        ticketId: found._id,
        eventId: effectiveEventId,
        result: "duplicate",
      });
      return res.json({
        ok: false,
        reason: "duplicate",
        serial: found.serial,
        checkedInAt: found.checkedInAt,
        buyerName,
        buyerEmail,
      });
    }

    // Update atómico
    const updated = await Ticket.findOneAndUpdate(
      { _id: found._id, status: "issued" },
      {
        $set: {
          status: "checked_in",
          checkedInAt: new Date(),
          checkedInBy: "scanner",
        },
      },
      { new: true }
    );

    const result = updated ? "ok" : "duplicate";
    await CheckInLog.create({
      ticketId: found._id,
      eventId: effectiveEventId,
      result,
    });

    return res.json({
      ok: result === "ok",
      serial: found.serial,
      status: updated?.status || found.status,
      checkedInAt: updated?.checkedInAt || found.checkedInAt,
      buyerName,
      buyerEmail,
    });
  } catch (e) {
    console.error("❌ Error en /api/checkin:", e);
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
    const { orderId, to } = req.body || {};
    if (!orderId) return res.status(400).json({ error: 'missing_orderId' });

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ error: 'order_not_found' });
    if (order.status !== 'paid') {
      return res.status(409).json({ error: 'order_not_paid', status: order.status });
    }

    const toEmail = (to && String(to).trim()) || order.email;
    if (!toEmail) return res.status(400).json({ error: 'no_email' });

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
