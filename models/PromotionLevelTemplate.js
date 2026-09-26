// models/PromotionLevelTemplate.js
const mongoose = require('mongoose');

const { Schema } = mongoose;

/**
 * Tipos de misión (extensible)
 * - attend_event: asistir a X eventos
 * - upload_event_photo: subir fotos (por evento o total)
 * - follow_users: seguir a X usuarios
 * - group_photo_with_followed: foto de grupo con usuarios seguidos (suele requerir validación)
 * - scan_qr: escanear QR dentro del local
 * - theme_photo: foto con temática/disfraz
 * - photocall_photo: foto en photocall
 * - show_prizes_photo: foto mostrando premios obtenidos
 * - stamps_competition: dinámica competitiva (club decide ganador)
 */
const MISSION_TYPES = [
  'attend_event',
  'upload_event_photo',
  'approved_event_photo',
  'follow_users',
  'group_photo_with_followed',
  'scan_qr',
  'theme_photo',
  'photocall_photo',
  'show_prizes_photo',
  'stamps_competition',
  'share_event',
  'link_clicks',
  'unique_visits',
  'referred_purchases',
];

/**
 * Tipos de recompensa (extensible)
 */
const REWARD_TYPES = [
  'shot',            // chupito
  'drink',           // consumición
  'free_entry',      // entrada gratis
  'vip_access',      // acceso vip
  'bottle',          // botella
  'trip',            // viaje/premio grande
  'custom',          // texto libre
];

const LEVEL_STATUS = ['draft', 'active', 'paused'];
const LEVEL_DIFFICULTY = ['easy', 'medium', 'hard', 'extreme'];
const VALIDATION_TYPES = ['automatic', 'manual', 'link_tracking', 'hybrid'];

const MissionSchema = new Schema({
  // Tipo de misión (enum estable para backend/app)
  type: { type: String, enum: MISSION_TYPES, required: true },

  // Texto visible en app/panel
  title: { type: String, required: true },
  description: { type: String, default: '' },

  // Objetivo numérico (ej: seguir 5 usuarios, asistir 20 eventos, etc.)
  target: { type: Number, default: 1 },

  // Unidad visible/semántica del objetivo (events, clicks, photos, users, etc.)
  unit: { type: String, default: '' },

  // Parámetros extra según misión
  params: { type: Schema.Types.Mixed, default: {} },

  // Tipo de validación para que la app/backend sepan cómo contar la misión
  validationType: {
    type: String,
    enum: VALIDATION_TYPES,
    default: 'automatic',
  },

  // Compatibilidad hacia atrás con lógica ya existente
  requiresApproval: { type: Boolean, default: false },

  // Orden dentro del nivel
  order: { type: Number, default: 0 },

  // Si está activa
  active: { type: Boolean, default: true },
});

const RewardSchema = new Schema(
  {
    type: { type: String, enum: REWARD_TYPES, default: 'custom' },

    // Texto corto (ej: "1 chupito", "Entrada gratis", "VIP x4", etc.)
    title: { type: String, required: true },

    // Detalles opcionales (ej: condiciones)
    description: { type: String, default: '' },

    // Valor numérico opcional (ej: 1 chupito -> 1, VIP x4 -> 4)
    value: { type: Number, default: null },

    // Datos extra (ej: { vipPeople: 4 }, { bottleOptions: [...] })
    meta: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const PromotionLevelTemplateSchema = new Schema(
  {
    /**
     * scope:
     * - global: niveles por defecto NightVibe
     * - club: niveles personalizados para un club concreto
     */
    scope: { type: String, enum: ['global', 'club'], default: 'global', index: true },

    // Si scope = club, referencia al club
    club: { type: Schema.Types.ObjectId, ref: 'Club', default: null, index: true },

    // Número de nivel (1..10 por defecto)
    levelNumber: { type: Number, required: true, min: 1, max: 100, index: true },

    // Orden editable dentro del sistema del club
    order: { type: Number, default: 0, index: true },

    // Nombre del nivel (visible en la app)
    title: { type: String, required: true },

    // Descripción opcional (visible en el detalle)
    description: { type: String, default: '' },

    // Dificultad visible del nivel
    difficulty: {
      type: String,
      enum: LEVEL_DIFFICULTY,
      default: 'medium',
    },

    // Lista de misiones del nivel
    missions: { type: [MissionSchema], default: [] },

    // Recompensa del nivel
    reward: { type: RewardSchema, required: true },

    // Estado del nivel en el panel/app
    status: {
      type: String,
      enum: LEVEL_STATUS,
      default: 'active',
    },

    // Compatibilidad hacia atrás con código ya existente
    active: { type: Boolean, default: true },

    // Control de visibilidad en la app
    visibleInApp: { type: Boolean, default: true },

    // Versión por si quieres migraciones futuras
    version: { type: Number, default: 1 },
  },
  { timestamps: true }
);

// Evita duplicados por scope/club/levelNumber
PromotionLevelTemplateSchema.index(
  { scope: 1, club: 1, levelNumber: 1 },
  { unique: true }
);

PromotionLevelTemplateSchema.pre('save', function (next) {
  if (typeof this.order !== 'number' || Number.isNaN(this.order)) {
    this.order = this.levelNumber;
  }

  // Mantener compatibilidad entre status y active
  if (this.status === 'paused' || this.status === 'draft') {
    this.active = false;
  } else if (this.status === 'active') {
    this.active = true;
  }

  if (!this.status) {
    this.status = this.active ? 'active' : 'paused';
  }

  if (Array.isArray(this.missions)) {
    this.missions = this.missions.map((mission, idx) => {
      const m = mission && typeof mission.toObject === 'function' ? mission.toObject() : mission;
      if (!m) return m;

      if (typeof m.order !== 'number' || Number.isNaN(m.order)) {
        m.order = idx + 1;
      }

      if (!m.validationType) {
        m.validationType = m.requiresApproval ? 'manual' : 'automatic';
      }

      if (!m.unit) {
        if (m.type === 'attend_event') m.unit = 'events';
        else if (m.type === 'follow_users') m.unit = 'users';
        else if (m.type === 'link_clicks') m.unit = 'clicks';
        else if (m.type === 'unique_visits') m.unit = 'visits';
        else if (m.type === 'referred_purchases') m.unit = 'purchases';
        else if (m.type === 'upload_event_photo' || m.type === 'approved_event_photo') m.unit = 'photos';
        else m.unit = '';
      }

      return m;
    });
  }

  next();
});

/**
 * Helper: plantillas default (10 niveles) en castellano.
 * Lo dejo aquí para que luego podamos “seedear” fácil desde un script o al arrancar.
 */
PromotionLevelTemplateSchema.statics.getDefaultTemplates = function () {
  return [
    {
      scope: 'global',
      levelNumber: 1,
      title: 'Nivel 1 — Primer paso',
      description: 'Asiste a un evento y sube una foto del local en NightVibe.',
      order: 1,
      difficulty: 'easy',
      status: 'active',
      missions: [
        {
          type: 'attend_event',
          title: 'Asistir a 1 evento',
          description: 'Marca asistencia en un evento del club.',
          unit: 'events',
          validationType: 'automatic',
          target: 1,
          requiresApproval: false,
          order: 1,
        },
        {
          type: 'upload_event_photo',
          title: 'Subir 1 foto del evento',
          description: 'Sube una foto del local/evento en NightVibe.',
          unit: 'photos',
          validationType: 'automatic',
          target: 1,
          params: { perEvent: true },
          requiresApproval: false,
          order: 2,
        },
      ],
      reward: { type: 'shot', title: '1 chupito', value: 1 },
    },

    {
      scope: 'global',
      levelNumber: 2,
      title: 'Nivel 2 — Social starter',
      description: 'Completa acciones sociales y demuestra asistencia con fotos.',
      order: 2,
      difficulty: 'medium',
      status: 'active',
      missions: [
        {
          type: 'follow_users',
          title: 'Seguir a 5 usuarios',
          description: 'Sigue a 5 cuentas dentro de NightVibe.',
          unit: 'users',
          validationType: 'automatic',
          target: 5,
          requiresApproval: false,
          order: 1,
        },
        {
          type: 'attend_event',
          title: 'Asistir a 2 eventos',
          description: 'Asiste a 2 eventos (del club o de la plataforma, según configuración).',
          unit: 'events',
          validationType: 'automatic',
          target: 2,
          requiresApproval: false,
          order: 2,
        },
        {
          type: 'upload_event_photo',
          title: 'Subir una foto en cada evento',
          description: 'Sube una foto en cada evento al que asistas.',
          unit: 'photos',
          validationType: 'automatic',
          target: 2,
          params: { perEvent: true },
          requiresApproval: false,
          order: 3,
        },
        {
          type: 'group_photo_with_followed',
          title: 'Foto de grupo con los usuarios seguidos',
          description: 'Sube una foto de grupo con los 5 usuarios que has seguido.',
          unit: 'photos',
          validationType: 'manual',
          target: 1,
          requiresApproval: true,
          order: 4,
        },
      ],
      reward: { type: 'free_entry', title: 'Entrada gratis (1 persona)', value: 1 },
    },

    {
      scope: 'global',
      levelNumber: 3,
      title: 'Nivel 3 — Búsqueda del QR',
      description: 'Encuentra el QR en la discoteca y completa la dinámica del sello.',
      order: 3,
      difficulty: 'medium',
      status: 'active',
      missions: [
        {
          type: 'scan_qr',
          title: 'Encontrar y escanear el QR del local',
          description: 'Escanea el QR dentro de la discoteca.',
          unit: 'scans',
          validationType: 'automatic',
          target: 1,
          requiresApproval: false,
          order: 1,
        },
        {
          type: 'stamps_competition',
          title: 'Conseguir sellos y subir foto',
          description: 'Sube una foto con el sello en la cara. Quien consiga más sellos en el evento sube de nivel.',
          unit: 'competitions',
          validationType: 'manual',
          target: 1,
          requiresApproval: true,
          order: 2,
        },
      ],
      reward: { type: 'custom', title: 'Subida de nivel + premio del club', description: 'El club decide el premio exacto.' },
    },

    {
      scope: 'global',
      levelNumber: 4,
      title: 'Nivel 4 — Temática',
      description: 'Participa en un evento temático y sube la foto.',
      missions: [
        {
          type: 'theme_photo',
          title: 'Foto con temática con 1 persona',
          description: 'Sube una foto vestido/a de la temática con 1 amigo/a o pareja.',
          target: 1,
          requiresApproval: true,
          order: 1,
        },
      ],
      reward: { type: 'shot', title: '2 chupitos (1 cada uno)', value: 2 },
    },

    {
      scope: 'global',
      levelNumber: 5,
      title: 'Nivel 5 — Photocall',
      description: 'Foto en el photocall “modo pareja” (vale también con amigos).',
      missions: [
        {
          type: 'photocall_photo',
          title: 'Foto en el photocall',
          description: 'Sube una foto en el photocall con 1 persona.',
          target: 1,
          requiresApproval: true,
          order: 1,
        },
      ],
      reward: { type: 'free_entry', title: 'Entrada gratis para 2', value: 2 },
    },

    {
      scope: 'global',
      levelNumber: 6,
      title: 'Nivel 6 — Coleccionista',
      description: 'Demuestra tus premios obtenidos en NightVibe.',
      missions: [
        {
          type: 'show_prizes_photo',
          title: 'Foto con tus premios obtenidos',
          description: 'Sube una foto mostrando premios o evidencias obtenidas en eventos.',
          target: 1,
          requiresApproval: true,
          order: 1,
        },
      ],
      reward: { type: 'custom', title: 'Premio del club', description: 'Consumición / upgrade / regalo, según el club.' },
    },

    {
      scope: 'global',
      levelNumber: 7,
      title: 'Nivel 7 — Team outfit',
      description: 'Evento temático, con outfit/disfraz, y foto con 1 persona.',
      missions: [
        {
          type: 'theme_photo',
          title: 'Foto temática con 1 persona',
          description: 'Asiste a un evento temático y sube una foto con 1 amigo/a o pareja.',
          target: 1,
          requiresApproval: true,
          order: 1,
        },
      ],
      reward: { type: 'drink', title: '1 consumición gratuita', value: 1 },
    },

    {
      scope: 'global',
      levelNumber: 8,
      title: 'Nivel 8 — Veterano',
      description: 'Constancia en la plataforma.',
      missions: [
        {
          type: 'attend_event',
          title: 'Asistir a 20 eventos',
          description: 'Alcanza 20 eventos asistidos en NightVibe.',
          target: 20,
          params: { platformWide: true },
          requiresApproval: false,
          order: 1,
        },
      ],
      reward: { type: 'vip_access', title: 'Acceso VIP para 4', value: 4, meta: { people: 4 } },
    },

    {
      scope: 'global',
      levelNumber: 9,
      title: 'Nivel 9 — Leyenda',
      description: 'Nivel alto de actividad en NightVibe.',
      missions: [
        {
          type: 'attend_event',
          title: 'Asistir a 40 eventos',
          description: 'Alcanza 40 eventos asistidos en NightVibe.',
          target: 40,
          params: { platformWide: true },
          requiresApproval: false,
          order: 1,
        },
      ],
      reward: { type: 'bottle', title: '1 botella a elegir en VIP', value: 1 },
    },

    {
      scope: 'global',
      levelNumber: 10,
      title: 'Nivel 10 — Top tier',
      description: 'El nivel máximo: constancia total.',
      missions: [
        {
          type: 'attend_event',
          title: 'Asistir a 50 eventos',
          description: 'Alcanza 50 eventos asistidos en NightVibe.',
          target: 50,
          params: { platformWide: true },
          requiresApproval: false,
          order: 1,
        },
      ],
      reward: { type: 'trip', title: 'Viaje a Nueva York (1 semana)', value: 1, meta: { destination: 'New York', durationDays: 7 } },
    },
  ];
};

module.exports = mongoose.model('PromotionLevelTemplate', PromotionLevelTemplateSchema);
