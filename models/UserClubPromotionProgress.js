// models/UserClubPromotionProgress.js
const mongoose = require('mongoose');

const { Schema } = mongoose;

/**
 * Estados posibles para una misión en el progreso del usuario
 */
const MISSION_STATUS = [
  'locked',
  'in_progress',
  'pending',     // enviado para validación del club
  'approved',    // validado por el club (si aplica)
  'completed',   // completado (auto o tras approved)
  'rejected',    // rechazado por el club
];

/**
 * Progreso de una misión concreta
 * missionKey: identificador estable dentro de un nivel (lo generamos desde backend)
 */
const MissionProgressSchema = new Schema(
  {
    missionKey: { type: String, required: true }, // ej: "L1_attend_event"
    type: { type: String, required: true },      // ej: "attend_event"

    title: { type: String, default: '' },

    // Estado
    status: { type: String, enum: MISSION_STATUS, default: 'locked' },

    // Progreso numérico
    current: { type: Number, default: 0 },
    target: { type: Number, default: 1 },

    // Si requiere aprobación del club
    requiresApproval: { type: Boolean, default: false },

    // Si hay claim asociado (pendiente/aprobado/rechazado)
    claimId: { type: Schema.Types.ObjectId, ref: 'PromotionClaim', default: null },

    // Metadatos útiles (eventId, photoUrl, qrId, etc.)
    meta: { type: Schema.Types.Mixed, default: {} },

    // Timestamps
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    updatedAt: { type: Date, default: null },
  },
  { _id: false }
);

/**
 * Progreso de un nivel
 * Guardamos snapshot del reward para mostrar rápido en app.
 */
const LevelProgressSchema = new Schema(
  {
    levelNumber: { type: Number, required: true, min: 1, max: 100 },

    title: { type: String, default: '' },
    description: { type: String, default: '' },

    // Estado del nivel
    status: { type: String, enum: ['locked', 'in_progress', 'completed'], default: 'locked' },

    // Misiones
    missions: { type: [MissionProgressSchema], default: [] },

    // Reward snapshot (para UI rápida, aunque venga del template)
    reward: {
      type: { type: String, default: 'custom' },
      title: { type: String, default: '' },
      description: { type: String, default: '' },
      value: { type: Number, default: null },
      meta: { type: Schema.Types.Mixed, default: {} },
    },

    // Progreso calculado (0..1) cacheado (opcional)
    progress: { type: Number, default: 0 },
    completedAt: { type: Date, default: null },

    // Canje de recompensa del nivel
    rewardRedeemed: { type: Boolean, default: false },
    rewardRedeemedAt: { type: Date, default: null },
  },
  { _id: false }
);

/**
 * Contadores agregados para calcular misiones sin escanear todo cada vez
 */
const CountersSchema = new Schema(
  {
    // Contadores por club
    attendancesInClub: { type: Number, default: 0 },
    photosUploadedInClub: { type: Number, default: 0 },
    qrScansInClub: { type: Number, default: 0 },

    // Contadores globales (NightVibe)
    attendancesPlatform: { type: Number, default: 0 },

    // Sociales
    followedUsers: { type: Number, default: 0 },

    // Extra (sellos, etc.)
    stampsInCurrentEvent: { type: Number, default: 0 },
  },
  { _id: false }
);

const UserClubPromotionProgressSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    club: { type: Schema.Types.ObjectId, ref: 'Club', required: true, index: true },

    // Nivel actual (el que está haciendo)
    currentLevel: { type: Number, default: 1 },

    // Snapshot rápido para tu lista de promos (lo que pinta Flutter)
    currentProgress: { type: Number, default: 0 }, // 0..1 del nivel actual
    currentRewardTitle: { type: String, default: '' },

    // Estado general
    status: { type: String, enum: ['active', 'blocked'], default: 'active' },

    // Progreso por niveles (1..10 por defecto)
    levels: { type: [LevelProgressSchema], default: [] },

    // Contadores agregados
    counters: { type: CountersSchema, default: () => ({}) },

    // Si hay claims pendientes (rápido para UI)
    pendingClaimsCount: { type: Number, default: 0 },

    // Último evento donde hizo progreso (útil para debug/analíticas)
    lastEventId: { type: Schema.Types.ObjectId, ref: 'Event', default: null },
    lastActivityAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Índice único para asegurar un progreso por usuario+club
UserClubPromotionProgressSchema.index({ user: 1, club: 1 }, { unique: true });

/**
 * Helper: inicializa los 10 niveles desde templates (array ya resuelto)
 * templates: [{ levelNumber, title, description, missions[], reward }]
 */
UserClubPromotionProgressSchema.statics.buildFromTemplates = function ({
  templates,
  startLevel = 1,
}) {
  const levels = (templates || [])
    .sort((a, b) => a.levelNumber - b.levelNumber)
    .map((t) => {
      const missions = (t.missions || [])
        .slice()
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map((m) => {
          const key = `L${t.levelNumber}_${m.type}_${(m.order || 0)}`; // estable y simple
          return {
            missionKey: key,
            type: m.type,
            title: m.title || '',
            status: t.levelNumber === startLevel ? 'in_progress' : 'locked',
            current: 0,
            target: m.target ?? 1,
            requiresApproval: !!m.requiresApproval,
            meta: {},
            startedAt: t.levelNumber === startLevel ? new Date() : null,
            updatedAt: new Date(),
          };
        });

      return {
        levelNumber: t.levelNumber,
        title: t.title || `Nivel ${t.levelNumber}`,
        description: t.description || '',
        status: t.levelNumber === startLevel ? 'in_progress' : 'locked',
        missions,
        reward: t.reward || { type: 'custom', title: '' },
        progress: 0,
        completedAt: null,
        rewardRedeemed: false,
        rewardRedeemedAt: null,
      };
    });

  return {
    currentLevel: startLevel,
    levels,
    currentProgress: 0,
    currentRewardTitle:
      levels.find((l) => l.levelNumber === startLevel)?.reward?.title || '',
    counters: {},
    pendingClaimsCount: 0,
    lastActivityAt: new Date(),
  };
};

module.exports = mongoose.model('UserClubPromotionProgress', UserClubPromotionProgressSchema);
