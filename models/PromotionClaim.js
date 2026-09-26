// models/PromotionClaim.js
const mongoose = require('mongoose');

const { Schema } = mongoose;

/**
 * Tipos de evidencia (extensible)
 */
const EVIDENCE_TYPES = [
  'photo',      // url imagen
  'qr_scan',    // qrId / payload
  'text',       // explicación/nota
  'mixed',      // combinación
];

/**
 * Estados del claim
 */
const CLAIM_STATUS = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
];

/**
 * Tipos de misión (mantenlo alineado con PromotionLevelTemplate)
 */
const MISSION_TYPES = [
  'attend_event',
  'upload_event_photo',
  'follow_users',
  'group_photo_with_followed',
  'scan_qr',
  'theme_photo',
  'photocall_photo',
  'show_prizes_photo',
  'stamps_competition',
];

const EvidenceSchema = new Schema(
  {
    type: { type: String, enum: EVIDENCE_TYPES, required: true },

    // Para photo: url
    url: { type: String, default: '' },

    // Para qr_scan: payload / qrId
    qrId: { type: String, default: '' },
    payload: { type: Schema.Types.Mixed, default: null },

    // Para text
    text: { type: String, default: '' },

    // Cualquier extra (ej: { theme: "halloween" }, { stamps: 4 })
    meta: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const PromotionClaimSchema = new Schema(
  {
    // Quién reclama
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // Para qué club aplica
    club: { type: Schema.Types.ObjectId, ref: 'Club', required: true, index: true },

    // Opcional: evento asociado (si aplica)
    event: { type: Schema.Types.ObjectId, ref: 'Event', default: null, index: true },

    // Referencia al nivel/misión a la que corresponde
    levelNumber: { type: Number, required: true, min: 1, max: 100, index: true },
    missionType: { type: String, enum: MISSION_TYPES, required: true },
    missionKey: { type: String, required: true }, // ej: "L4_theme_photo_1"

    // Estado
    status: { type: String, enum: CLAIM_STATUS, default: 'pending', index: true },

    // Evidencias (foto, texto, qr...)
    evidence: { type: [EvidenceSchema], default: [] },

    // Comentario opcional del usuario
    userNote: { type: String, default: '' },

    // Resolución por el club
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null }, // club/staff/admin
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, default: '' },

    // Si el club otorga premio inmediato al aprobar (para trackear)
    rewardGranted: { type: Boolean, default: false },
    rewardGrantedAt: { type: Date, default: null },

    // Para auditoría/seguridad
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
  },
  { timestamps: true }
);

// Evita duplicar claims pendientes para la misma misión (usuario+club+nivel+missionKey)
PromotionClaimSchema.index(
  { user: 1, club: 1, levelNumber: 1, missionKey: 1, status: 1 },
  { partialFilterExpression: { status: 'pending' } }
);

module.exports = mongoose.model('PromotionClaim', PromotionClaimSchema);
