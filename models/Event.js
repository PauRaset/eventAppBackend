// models/Event.js
const mongoose = require("mongoose");

/**
 * Photo sub-schema (moderation-ready) with backward compatibility.
 * - Old docs may only contain { url } (or even strings); we normalize them in pre-save.
 * - Defaults treat legacy photos as "approved" to avoid blocking existing content.
 */
const eventPhotoSchema = new mongoose.Schema(
  {
    photoId: { type: String, default: "" },
    url: { type: String, required: true },

    // who uploaded
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    byUsername: { type: String, default: "" },
    uploadedAt: { type: Date, default: Date.now },

    // moderation
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "approved",
    },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, default: "" },

    // mission metadata captured at upload time (depends on the uploader's current level/mission)
    missionType: { type: String, default: null },
    missionId: { type: String, default: null },
    missionTitle: { type: String, default: null },
    missionDescription: { type: String, default: null },
    missionCurrent: { type: Number, default: null },
    missionTarget: { type: Number, default: null },
    levelNumber: { type: Number, default: null },

    // moderation result metadata saved by the club when approving/rejecting the photo
    validatedForMissionType: { type: String, default: null },
    validatedForMissionId: { type: String, default: null },
    validatedForMissionTitle: { type: String, default: null },
    validatedForLevelNumber: { type: Number, default: null },
    validationResult: { type: String, default: null },

    // reactions (NightVibe vibes)
    reactions: {
      type: [
        {
          userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
          },

          type: {
            type: String,
            enum: ["hype", "love", "party", "energy"],
            required: true,
          },

          createdAt: {
            type: Date,
            default: Date.now,
          },
        },
      ],
      default: [],
    },

    // signatures (NightVibe — firmas sobre la foto)
    signatures: {
      type: [
        {
          userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
          },
          username: { type: String, default: "" },
          profilePicture: { type: String, default: "" }, // ruta relativa (= User.profilePicture)
          x: { type: Number, required: true, min: 0, max: 1 }, // 0..1 relativo
          y: { type: Number, required: true, min: 0, max: 1 },
          createdAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
  },
  { _id: false }
);

const ticketTierSchema = new mongoose.Schema(
  {
    tierId: { type: String, required: true },   // estable, generado en el servidor
    name:   { type: String, required: true },   // "Entrada general", "Con consumición"
    description: { type: String, default: "" }, // qué incluye (opcional)

    priceEUR: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 0 },  // 0 = ilimitado en este tier

    // Contadores que lleva el sistema, NUNCA el club
    sold:     { type: Number, default: 0, min: 0 },
    reserved: { type: Number, default: 0, min: 0 },

    order:  { type: Number, default: 0 },        // secuencia de tandas
    active: { type: Boolean, default: true },

    // Ventana de venta opcional (early bird, etc.)
    salesStart: { type: Date, default: null },
    salesEnd:   { type: Date, default: null },
  },
  { _id: false }
);

/**
 * Schema de eventos con compatibilidad hacia atrás:
 * - startAt / endAt (fechas normalizadas) y "date" legacy.
 * - photos con sub-schema moderable (legacy compatible via pre-save).
 * - age y price como Number.
 * - NUEVO: Relación con Club
 *    - clubId: String (rápido para queries/metadata)
 *    - club:   ObjectId ref 'Club' (relación formal)
 *   Ambos se sincronizan en pre-save.
 */
const eventSchema = new mongoose.Schema(
  {
    title:       { type: String, default: "" },
    description: { type: String, default: "" },

    // Fechas nuevas normalizadas
    startAt: { type: Date },
    endAt:   { type: Date },

    // Compatibilidad con campo antiguo
    date: { type: Date },

    // Ubicación
    city:       { type: String, default: "" },
    street:     { type: String, default: "" },
    postalCode: { type: String, default: "" },

    // Coordenadas geocodificadas a partir de la dirección (GeoJSON Point).
    // IMPORTANTE: el orden es [longitud, latitud], no al revés.
    location: {
      type: {
        type: String,
        enum: ["Point"],
        default: undefined,
      },
      coordinates: {
        type: [Number],
        default: undefined,
      },
    },

    // Metadatos de la geocodificación
    geoStatus: {
      type: String,
      enum: ["pending", "ok", "failed", "manual"],
      default: "pending",
    },
    geoProvider:      { type: String, default: "" },
    geoFormatted:     { type: String, default: "" },
    geoUpdatedAt:     { type: Date, default: null },
    geoSourceAddress: { type: String, default: "" },

    // Imagen principal (ruta relativa tipo "uploads/...")
    image: { type: String, default: "" },

    // Galería: fotos moderables (legacy compatible: strings/objetos antiguos se normalizan en pre-save)
    photos: {
      type: [eventPhotoSchema],
      default: [],
    },

    // Multi-categoría
    categories: { type: [String], default: [] },

    // Extra
    age:   { type: Number, default: 18 },
    dressCode: { type: String, default: "" },
    price: { type: Number, default: 0 },

    // Ventas/entradas (compatibles hacia atrás)
    currency: { type: String, default: "eur" },
    capacity: { type: Number, default: 0 },       // 0 = sin límite
    ticketsSold: { type: Number, default: 0 },     // contador rápido
    // Entradas reservadas por sesiones de Checkout abiertas todavía sin pagar.
    // ticketsSold + ticketsReserved es el stock comprometido real.
    ticketsReserved: { type: Number, default: 0 },
    salesStart: { type: Date, default: null },
    salesEnd:   { type: Date, default: null },
    isPublished: { type: Boolean, default: true },

    // Tipos de entrada y tandas. Si está vacío, el evento usa price/capacity
    // como siempre (comportamiento legacy).
    ticketTiers: { type: [ticketTierSchema], default: [] },

    attendees: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // 🔥 NUEVO — relación con Club
    clubId: { type: String, index: true, default: "" }, // guardamos como string para flexibilidad
    club:   { type: mongoose.Schema.Types.ObjectId, ref: "Club", index: true, default: null },

    // Comisión NightVibe por entrada (EUR). Si existe, sobrescribe el default (1.50€).
    // Ej: 1.5 => 1,50€; 0 => sin comisión.
    platformFeeEUR: { type: Number, default: null },
    ticketTheme: { type: String, default: "" },

    // Activación del sistema de promociones/niveles para este evento.
    // Si está a false, el frontend puede mostrar el bloque sutil de “promociones no activadas”.
    promotionsEnabled: { type: Boolean, default: false },

    // Token único del QR del evento. Servirá como base para generar/validar el QR
    // sin depender de guardar necesariamente la imagen final en la base de datos.
    qrToken: { type: String, index: true, default: "" },

    // Texto corto opcional del evento, útil si más adelante se presenta también
    // con formato tipo publicación/red social.
    caption: { type: String, default: "" },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        delete ret.__v;
        return ret;
      },
    },
  }
);

/** Utils */
function isHex24(s) {
  return typeof s === "string" && /^[a-fA-F0-9]{24}$/.test(s);
}

/** Genera un id estable para una foto (string) */
function genPhotoId() {
  return `evtphoto_${new mongoose.Types.ObjectId().toString()}`;
}

/** Normaliza rutas de uploads: si viene URL absoluta, recorta desde /uploads/... */
function onlyUploadPath(input) {
  if (!input || typeof input !== 'string') return input;
  const i = input.indexOf('/uploads/');
  if (i !== -1) return input.slice(i);
  return input;
}

/**
 * Normalizaciones antes de guardar:
 * - Fechas: convertir a Date y usar date → startAt si hace falta.
 * - age/price a Number.
 * - Sincronizar clubId ⇄ club:
 *    - si llega `club` (ObjectId) y no `clubId` → set clubId
 *    - si llega `clubId` con pinta de ObjectId y no `club` → set club
 */
eventSchema.pre("save", function (next) {
  // Fechas
  if (this.startAt && !(this.startAt instanceof Date)) this.startAt = new Date(this.startAt);
  if (this.endAt && !(this.endAt instanceof Date))     this.endAt   = new Date(this.endAt);
  if (this.date && !(this.date instanceof Date))       this.date    = new Date(this.date);
  if (!this.startAt && this.date) this.startAt = this.date;

  // age / price a número
  if (typeof this.age === "string") {
    const n = parseInt(this.age, 10);
    if (!Number.isNaN(n)) this.age = n;
  }
  if (typeof this.price === "string") {
    const n = Number(this.price);
    if (!Number.isNaN(n)) this.price = n;
  }

  // capacity / ticketsSold a número y no negativos
  if (typeof this.capacity === "string") {
    const n = Number(this.capacity);
    if (!Number.isNaN(n)) this.capacity = n;
  }
  if (typeof this.ticketsSold === "string") {
    const n = Number(this.ticketsSold);
    if (!Number.isNaN(n)) this.ticketsSold = n;
  }
  if (this.capacity < 0) this.capacity = 0;
  if (this.ticketsSold < 0) this.ticketsSold = 0;
  if (typeof this.ticketsReserved === "string") {
    const n = Number(this.ticketsReserved);
    if (!Number.isNaN(n)) this.ticketsReserved = n;
  }
  if (this.ticketsReserved < 0) this.ticketsReserved = 0;

  // Normalizar salesStart / salesEnd
  if (this.salesStart && !(this.salesStart instanceof Date)) this.salesStart = new Date(this.salesStart);
  if (this.salesEnd && !(this.salesEnd instanceof Date))     this.salesEnd   = new Date(this.salesEnd);

  // Sincronizar clubId ⇄ club
  if (this.club && !this.clubId) {
    this.clubId = String(this.club);
  } else if (!this.club && isHex24(this.clubId)) {
    // Sólo autoconvertimos si parece ObjectId
    this.club = new mongoose.Types.ObjectId(this.clubId);
  }

  // Normalizar imagen principal a ruta relativa
  if (this.image) {
    this.image = onlyUploadPath(String(this.image).trim());
  }

  // Normalizar textos opcionales nuevos
  if (typeof this.caption === 'string') {
    this.caption = this.caption.trim();
  }
  if (typeof this.qrToken === 'string') {
    this.qrToken = this.qrToken.trim();
  }

  // Normalizar galería (acepta strings legacy o objetos)
  if (Array.isArray(this.photos)) {
    this.photos = this.photos
      .map((p) => {
        // Legacy string -> object
        if (typeof p === "string") {
          return {
            photoId: genPhotoId(),
            url: onlyUploadPath(p),
            status: "approved", // legacy: no bloqueamos contenido existente
            uploadedAt: new Date(),
            reviewedBy: null,
            reviewedAt: null,
            reviewNote: "",
          };
        }

        if (p && typeof p === "object") {
          const copy = { ...p };
          if (copy.url) copy.url = onlyUploadPath(String(copy.url));

          // Ensure defaults for legacy objects
          if (!copy.photoId) copy.photoId = genPhotoId();
          if (!copy.status) copy.status = "approved";
          if (copy.reviewedBy === undefined) copy.reviewedBy = null;
          if (copy.reviewedAt === undefined) copy.reviewedAt = null;
          if (copy.reviewNote === undefined) copy.reviewNote = "";
          if (!copy.uploadedAt) copy.uploadedAt = new Date();

          if (copy.missionType === undefined) copy.missionType = null;
          if (copy.missionId === undefined) copy.missionId = null;
          if (copy.missionTitle === undefined) copy.missionTitle = null;
          if (copy.missionDescription === undefined) copy.missionDescription = null;
          if (copy.missionCurrent === undefined) copy.missionCurrent = null;
          if (copy.missionTarget === undefined) copy.missionTarget = null;
          if (copy.levelNumber === undefined) copy.levelNumber = null;

          if (copy.validatedForMissionType === undefined) copy.validatedForMissionType = null;
          if (copy.validatedForMissionId === undefined) copy.validatedForMissionId = null;
          if (copy.validatedForMissionTitle === undefined) copy.validatedForMissionTitle = null;
          if (copy.validatedForLevelNumber === undefined) copy.validatedForLevelNumber = null;
          if (copy.validationResult === undefined) copy.validationResult = null;
          if (!Array.isArray(copy.reactions)) copy.reactions = [];
          if (!Array.isArray(copy.signatures)) copy.signatures = [];

          return copy;
        }

        return null;
      })
      .filter(Boolean);
  }

  // Normalizar categorías: si viene string JSON o "a,b,c"
  if (typeof this.categories === 'string') {
    const raw = this.categories.trim();
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) this.categories = parsed.map(String);
    } catch (_) {
      this.categories = raw
        ? raw.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    }
  }

  // Generar qrToken automáticamente si el evento aún no tiene uno.
  // Así cada evento puede disponer de un identificador único estable para QR.
  if (!this.qrToken) {
    this.qrToken = new mongoose.Types.ObjectId().toString();
  }

  // Normalizar ticketTiers
  if (Array.isArray(this.ticketTiers) && this.ticketTiers.length > 0) {
    const orders = this.ticketTiers.map((t) => t.order ?? 0);
    const hasOrderCollision = new Set(orders).size !== orders.length;

    this.ticketTiers = this.ticketTiers.map((tier, idx) => {
      if (!tier.tierId) {
        tier.tierId = `tier_${new mongoose.Types.ObjectId().toString()}`;
      }
      if (typeof tier.priceEUR === "string") {
        const n = Number(tier.priceEUR);
        if (!Number.isNaN(n)) tier.priceEUR = n;
      }
      if (typeof tier.quantity === "string") {
        const n = Number(tier.quantity);
        if (!Number.isNaN(n)) tier.quantity = n;
      }
      if (typeof tier.sold === "string") {
        const n = Number(tier.sold);
        tier.sold = Number.isNaN(n) ? 0 : n;
      }
      if (tier.sold < 0) tier.sold = 0;
      if (typeof tier.reserved === "string") {
        const n = Number(tier.reserved);
        tier.reserved = Number.isNaN(n) ? 0 : n;
      }
      if (tier.reserved < 0) tier.reserved = 0;
      if (hasOrderCollision) tier.order = idx;
      return tier;
    });
  }

  next();
});

/** Índices compuestos útiles */
eventSchema.index({ clubId: 1, startAt: -1 });
eventSchema.index({ "createdBy": 1, startAt: -1 });
eventSchema.index({ attendees: 1, startAt: -1 });
// Publicación + ventana temporal de venta
eventSchema.index({ isPublished: 1, startAt: -1 });
// Búsquedas por rango de venta
eventSchema.index({ salesStart: 1, salesEnd: 1 });
eventSchema.index({ location: "2dsphere" });

// Virtual: el evento tiene al menos un tier activo
eventSchema.virtual('hasTiers').get(function () {
  return Array.isArray(this.ticketTiers) && this.ticketTiers.some((t) => t.active !== false);
});

// Virtual: evento a la venta ahora
eventSchema.virtual('isOnSale').get(function () {
  const now = new Date();
  if (this.isPublished === false) return false;
  if (this.salesStart && now < this.salesStart) return false;
  if (this.salesEnd && now > this.salesEnd) return false;
  return true;
});

module.exports = mongoose.model("Event", eventSchema);
